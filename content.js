(function() {
    'use strict';
    
    if (window.whiskAutomatorLoaded) {
        return;
    }
    window.whiskAutomatorLoaded = true;
    
    // --- State Management ---
    let automationState = {
        isRunning: false,
        prompts: [],
        currentIndex: 0,
        delay: 20,
        timeoutId: null,
        settings: {
            randomize: false,
            aspectRatios: []
        }
    };

    // --- Selectors ---
    const SELECTORS = {
        textarea: 'textarea[placeholder*="Descreva sua ideia"]',
        submitButton: 'button[aria-label="Enviar comando"]',
        // Selector for the menu that appears after clicking the aspect ratio button
        aspectRatioMenuItem: '[role="menuitem"]'
    };

    // --- Utility Functions ---
    function findElement(selector, parent = document) {
        return parent.querySelector(selector);
    }

    function findAllElements(selector, parent = document) {
        return Array.from(parent.querySelectorAll(selector));
    }

    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const element = findElement(selector);
            if (element) return resolve(element);

            const observer = new MutationObserver(() => {
                const element = findElement(selector);
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });
            
            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Elemento não encontrado: ${selector}`));
            }, timeout);

            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    function simulateTyping(element, text) {
        element.focus();
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function sendMessageToBackground(message) {
        try {
            chrome.runtime.sendMessage(message);
        } catch (error) {
            console.warn('Falha ao enviar mensagem para o background (popup pode estar fechado).', error);
        }
    }

    // --- Core Logic ---

    async function submitPrompt(prompt, aspectRatio) {
        try {
            const textarea = await waitForElement(SELECTORS.textarea);
            simulateTyping(textarea, prompt);
            await new Promise(resolve => setTimeout(resolve, 500)); // Delay after typing

            if (automationState.settings.randomize && aspectRatio) {
                const allButtons = findAllElements('button');
                const ratioButton = allButtons.find(btn => btn.textContent.includes('aspect_ratio'));

                if (!ratioButton) {
                    throw new Error('Botão de proporção (aspect_ratio) não foi encontrado.');
                }
                
                // Click to open the menu
                ratioButton.click();
                await new Promise(resolve => setTimeout(resolve, 500));

                await waitForElement('button span');
                const optionButtons = findAllElements('button');
                const targetButton = optionButtons.find(btn => btn.textContent.trim() === aspectRatio);

                if (targetButton) {
                    targetButton.click();
                    await new Promise(resolve => setTimeout(resolve, 250));

                    // Click the main button again to close the menu
                    ratioButton.click();
                    await new Promise(resolve => setTimeout(resolve, 250)); 
                } else {
                    console.warn(`Não foi possível encontrar a opção de proporção: ${aspectRatio}`);
                    // Close the menu anyway to prevent errors
                    ratioButton.click();
                }
            }

            const submitButton = findElement(SELECTORS.submitButton);
            if (!submitButton || submitButton.disabled) {
                throw new Error('Botão de envio não encontrado ou desabilitado.');
            }
            submitButton.click();

        } catch (error) {
            console.error('Erro ao enviar prompt:', error);
            throw error;
        }
    }

    function handleAutomationComplete() {
        sendMessageToBackground({
            action: 'automationComplete',
            totalPrompts: automationState.prompts.length
        });
        resetAutomation();
    }

    function resetAutomation() {
        if (automationState.timeoutId) clearTimeout(automationState.timeoutId);
        automationState = { isRunning: false, prompts: [], currentIndex: 0, delay: 20, timeoutId: null, settings: {} };
    }

    async function runAutomation() {
        if (!automationState.isRunning || automationState.currentIndex >= automationState.prompts.length) {
            handleAutomationComplete();
            return;
        }

        const currentPrompt = automationState.prompts[automationState.currentIndex];
        let currentAspectRatio = null;

        // If randomize is on, pick a ratio from the list provided by the popup
        if (automationState.settings.randomize && automationState.settings.aspectRatios && automationState.settings.aspectRatios.length > 0) {
            const possibleRatios = automationState.settings.aspectRatios;
            currentAspectRatio = possibleRatios[Math.floor(Math.random() * possibleRatios.length)];
            // DEBUG MESSAGE
            sendMessageToBackground({ action: 'updateStatus', message: `Sorteado: ${currentAspectRatio}` });
        }
        
        sendMessageToBackground({
            action: 'updateStatus',
            message: `Enviando: "${currentPrompt.substring(0, 30)}..."`,
            type: 'running',
            progress: `Prompt ${automationState.currentIndex + 1} de ${automationState.prompts.length}`
        });
        
        try {
            // A small delay to make the debug message visible
            await new Promise(resolve => setTimeout(resolve, 500)); 
            await submitPrompt(currentPrompt, currentAspectRatio);
            automationState.currentIndex++;
            
            if (automationState.isRunning && automationState.currentIndex < automationState.prompts.length) {
                automationState.timeoutId = setTimeout(runAutomation, automationState.delay * 1000);
            } else if (automationState.isRunning) {
                sendMessageToBackground({
                    action: 'updateStatus',
                    message: 'Aguardando a última imagem ser gerada...',
                    type: 'running'
                });
            }
        } catch (error) {
            sendMessageToBackground({ action: 'automationError', error: error.message });
            resetAutomation();
        }
    }

    // --- Listeners ---

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'ping') {
            sendResponse({ status: 'ready' });
            return true;
        }
        
        if (request.action === 'startAutomation') {
            if (automationState.isRunning) return true;
            
            automationState.isRunning = true;
            automationState.prompts = request.prompts;
            automationState.delay = request.delay;
            automationState.settings = request.settings; // Store settings
            automationState.currentIndex = 0;
            
            runAutomation();
            return true;
        }
        
        if (request.action === 'stopAutomation') {
            resetAutomation();
            sendMessageToBackground({ action: 'updateStatus', message: 'Automação interrompida', type: 'stopped' });
            return true;
        }
        return true;
    });

    function handleImageGeneration(mutations) {
        if (!automationState.isRunning) return;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                const images = node.matches('img') ? [node] : Array.from(node.querySelectorAll('img'));
                images.forEach(img => {
                    if (img.src.startsWith('blob:') && !img.dataset.downloadProcessed) {
                        img.dataset.downloadProcessed = 'true';
                        const prompt = automationState.prompts[automationState.currentIndex - 1] || 'prompt_desconhecido';
                        setTimeout(() => {
                            sendMessageToBackground({
                                action: 'downloadImage',
                                url: img.src,
                                prompt: prompt
                            });
                            if (automationState.currentIndex >= automationState.prompts.length) {
                                handleAutomationComplete();
                            }
                        }, 500);
                    }
                });
            }
        }
    }

    function initialize() {
        const observer = new MutationObserver(handleImageGeneration);
        observer.observe(document.body, { childList: true, subtree: true });
        sendMessageToBackground({ action: 'contentScriptReady' });
    }

    if (document.readyState === 'complete') {
        initialize();
    } else {
        window.addEventListener('load', initialize);
    }
})();