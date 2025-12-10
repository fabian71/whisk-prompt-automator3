(function () {
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
            aspectRatios: [],
            imagesPerPrompt: 2  // Default: download both images
        },
        lastPromptSubmitTime: null,  // Track when we last submitted a prompt
        waitingForImage: false,       // Flag to indicate we're waiting for a new image
        imagesFoundForCurrentPrompt: 0 // Count images found for current prompt
    };

    // Track processed image URLs to prevent duplicate downloads
    const processedImageUrls = new Set();

    // Track automation start time
    let automationStartTime = null;
    let timerInterval = null;

    // --- Floating Overlay ---
    let floatingOverlay = null;

    function createFloatingOverlay() {
        if (floatingOverlay) return;

        floatingOverlay = document.createElement('div');
        floatingOverlay.id = 'whisk-automator-overlay';
        floatingOverlay.innerHTML = `
            <div class="overlay-header">
                <span class="overlay-title">WHISK AUTOMATOR</span>
                <div class="overlay-header-right">
                    <span class="overlay-status">Gerando imagem</span>
                    <button class="overlay-close" id="overlay-close-btn" title="Fechar">✕</button>
                </div>
            </div>
            <div class="overlay-body">
                <div class="current-prompt" id="overlay-prompt">Aguardando...</div>
                <div class="overlay-info">
                    <div class="info-row">
                        <span>Prompt <span id="overlay-current">0</span> de <span id="overlay-total">0</span></span>
                    </div>
                    <div class="info-row">
                        <span>Tempo: <span id="overlay-time">00:00</span></span>
                    </div>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar" id="overlay-progress"></div>
                </div>
            </div>
            <div class="overlay-footer">
                Gosta do projeto? ❤ Me paga um cafezinho: <a href="https://ko-fi.com/dentparanoide" target="_blank" rel="noopener noreferrer">ko-fi.com/dentparanoide</a>
            </div>
        `;

        // Add close button event listener
        setTimeout(() => {
            const closeBtn = document.getElementById('overlay-close-btn');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    hideFloatingOverlay();
                });
            }
        }, 100);


        // Add styles
        const style = document.createElement('style');
        style.textContent = `
            #whisk-automator-overlay {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 320px;
                background: linear-gradient(135deg, #2d3748 0%, #1a202c 100%);
                border-radius: 12px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
                color: white;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                z-index: 999999;
                animation: slideIn 0.3s ease-out;
            }

            @keyframes slideIn {
                from {
                    transform: translateX(400px);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }

            .overlay-header {
                background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
                padding: 12px 16px;
                border-radius: 12px 12px 0 0;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .overlay-title {
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 1px;
            }

            .overlay-header-right {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .overlay-status {
                font-size: 11px;
                background: rgba(255, 255, 255, 0.2);
                padding: 4px 10px;
                border-radius: 12px;
                font-weight: 600;
            }

            .overlay-close {
                background: rgba(255, 255, 255, 0.2);
                border: none;
                color: white;
                width: 24px;
                height: 24px;
                border-radius: 50%;
                font-size: 16px;
                font-weight: 700;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
                line-height: 1;
                padding: 0;
            }

            .overlay-close:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.1);
            }

            .overlay-close:active {
                transform: scale(0.95);
            }

            .overlay-body {
                padding: 16px;
            }

            .current-prompt {
                background: rgba(255, 255, 255, 0.1);
                padding: 12px;
                border-radius: 8px;
                font-size: 13px;
                line-height: 1.5;
                margin-bottom: 12px;
                max-height: 80px;
                overflow-y: auto;
                word-wrap: break-word;
            }

            .overlay-info {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-bottom: 12px;
            }

            .info-row {
                display: flex;
                justify-content: space-between;
                font-size: 12px;
                color: #cbd5e0;
            }

            .info-row span {
                font-weight: 500;
            }

            .info-row span span {
                color: white;
                font-weight: 700;
            }

            .progress-bar-container {
                background: rgba(255, 255, 255, 0.1);
                height: 8px;
                border-radius: 4px;
                overflow: hidden;
            }

            .progress-bar {
                height: 100%;
                background: linear-gradient(90deg, #4facfe 0%, #00f2fe 100%);
                border-radius: 4px;
                transition: width 0.3s ease;
                width: 0%;
            }

            .current-prompt::-webkit-scrollbar {
                width: 6px;
            }

            .current-prompt::-webkit-scrollbar-track {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 3px;
            }

            .current-prompt::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.2);
                border-radius: 3px;
            }

            .overlay-footer {
                background: rgba(0, 0, 0, 0.2);
                padding: 10px 16px;
                border-radius: 0 0 12px 12px;
                font-size: 11px;
                text-align: center;
                color: #cbd5e0;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
            }

            .overlay-footer a {
                color: #4facfe;
                text-decoration: none;
                font-weight: 600;
                transition: color 0.2s ease;
            }

            .overlay-footer a:hover {
                color: #00f2fe;
                text-decoration: underline;
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(floatingOverlay);
    }

    function updateFloatingOverlay() {
        if (!floatingOverlay || !automationState.isRunning) return;

        const currentPrompt = automationState.prompts[automationState.currentIndex - 1] || 'Aguardando...';
        const progress = (automationState.currentIndex / automationState.prompts.length) * 100;

        document.getElementById('overlay-prompt').textContent = currentPrompt;
        document.getElementById('overlay-current').textContent = automationState.currentIndex;
        document.getElementById('overlay-total').textContent = automationState.prompts.length;
        document.getElementById('overlay-progress').style.width = `${progress}%`;
    }

    function updateTimer() {
        if (!automationStartTime || !floatingOverlay) return;

        const elapsed = Math.floor((Date.now() - automationStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

        const timeElement = document.getElementById('overlay-time');
        if (timeElement) {
            timeElement.textContent = timeStr;
        }
    }

    function showFloatingOverlay() {
        createFloatingOverlay();
        automationStartTime = Date.now();
        timerInterval = setInterval(updateTimer, 1000);
        updateFloatingOverlay();
    }

    function showCompletionState() {
        if (!floatingOverlay) return;

        // Stop the timer
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }

        // Change header to green and update status
        const header = floatingOverlay.querySelector('.overlay-header');
        const status = floatingOverlay.querySelector('.overlay-status');
        const progressBar = document.getElementById('overlay-progress');

        if (header) {
            header.style.background = 'linear-gradient(135deg, #48bb78 0%, #38a169 100%)';
        }
        if (status) {
            status.textContent = 'Concluído! ✓';
        }
        if (progressBar) {
            progressBar.style.width = '100%';
            progressBar.style.background = 'linear-gradient(90deg, #48bb78 0%, #38a169 100%)';
        }

        // Overlay stays visible - user can close it manually or it will close on page refresh
    }

    function hideFloatingOverlay() {
        if (floatingOverlay) {
            floatingOverlay.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => {
                if (floatingOverlay && floatingOverlay.parentNode) {
                    floatingOverlay.parentNode.removeChild(floatingOverlay);
                    floatingOverlay = null;
                }
            }, 300);
        }
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        automationStartTime = null;

        // Add slideOut animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideOut {
                from {
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    transform: translateX(400px);
                    opacity: 0;
                }
            }
        `;
        if (!document.querySelector('style[data-slideout]')) {
            style.setAttribute('data-slideout', 'true');
            document.head.appendChild(style);
        }
    }

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

        // Show completion state instead of hiding immediately
        showCompletionState();

        // Reset automation state but keep overlay visible
        if (automationState.timeoutId) clearTimeout(automationState.timeoutId);
        automationState = {
            isRunning: false,
            prompts: [],
            currentIndex: 0,
            delay: 20,
            timeoutId: null,
            settings: { imagesPerPrompt: 2 },
            lastPromptSubmitTime: null,
            waitingForImage: false,
            imagesFoundForCurrentPrompt: 0
        };
        processedImageUrls.clear();
    }

    function resetAutomation() {
        if (automationState.timeoutId) clearTimeout(automationState.timeoutId);
        automationState = {
            isRunning: false,
            prompts: [],
            currentIndex: 0,
            delay: 20,
            timeoutId: null,
            settings: { imagesPerPrompt: 2 },
            lastPromptSubmitTime: null,
            waitingForImage: false,
            imagesFoundForCurrentPrompt: 0
        };
        // Clear processed URLs when automation is reset
        processedImageUrls.clear();
        // Hide floating overlay
        hideFloatingOverlay();
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

            // Mark that we're about to submit a prompt and waiting for image
            automationState.waitingForImage = true;
            automationState.lastPromptSubmitTime = Date.now();
            automationState.imagesFoundForCurrentPrompt = 0; // Reset counter

            await submitPrompt(currentPrompt, currentAspectRatio);
            automationState.currentIndex++;

            // Update floating overlay with new progress
            updateFloatingOverlay();

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

        if (request.action === 'getAutomationState') {
            sendResponse({
                isRunning: automationState.isRunning,
                currentIndex: automationState.currentIndex,
                totalPrompts: automationState.prompts.length
            });
            return true;
        }

        if (request.action === 'startAutomation') {
            if (automationState.isRunning) {
                sendResponse({ success: false, message: 'Automation already running' });
                return true;
            }

            automationState.isRunning = true;
            automationState.prompts = request.prompts;
            automationState.delay = request.delay;
            automationState.settings = request.settings; // Store settings
            automationState.currentIndex = 0;

            // Show floating overlay
            showFloatingOverlay();

            runAutomation();
            sendResponse({ success: true });
            return true;
        }

        if (request.action === 'stopAutomation') {
            resetAutomation();
            sendMessageToBackground({ action: 'updateStatus', message: 'Automação interrompida', type: 'stopped' });
            sendResponse({ success: true });
            return true;
        }

        sendResponse({ success: false, message: 'Unknown action' });
        return true;
    });

    function handleImageGeneration(mutations) {
        if (!automationState.isRunning) return;

        // Only process if we're actively waiting for an image
        if (!automationState.waitingForImage) {
            return;
        }

        // Check if too much time has passed since submitting the prompt (30 seconds timeout)
        const timeSinceSubmit = Date.now() - automationState.lastPromptSubmitTime;
        if (timeSinceSubmit > 30000) {
            console.log('[Whisk Automator] Timeout: Nenhuma imagem detectada em 30 segundos');
            automationState.waitingForImage = false;
            return;
        }

        // Get how many images we should download per prompt
        const imagesPerPrompt = automationState.settings.imagesPerPrompt || 2;

        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;
                const images = node.matches('img') ? [node] : Array.from(node.querySelectorAll('img'));
                images.forEach(img => {
                    // Check if it's a blob URL and hasn't been processed yet
                    if (img.src.startsWith('blob:') && !processedImageUrls.has(img.src)) {
                        // Check if we've already found enough images for this prompt
                        if (automationState.imagesFoundForCurrentPrompt >= imagesPerPrompt) {
                            return; // Already found enough images for this prompt
                        }

                        // Mark as processed immediately
                        processedImageUrls.add(img.src);
                        img.dataset.downloadProcessed = 'true';
                        automationState.imagesFoundForCurrentPrompt++;

                        console.log(`[Whisk Automator] Nova imagem detectada: ${img.src.substring(0, 50)}...`);
                        console.log(`[Whisk Automator] Imagens para este prompt: ${automationState.imagesFoundForCurrentPrompt}/${imagesPerPrompt}`);

                        const prompt = automationState.prompts[automationState.currentIndex - 1] || 'prompt_desconhecido';
                        setTimeout(() => {
                            sendMessageToBackground({
                                action: 'downloadImage',
                                url: img.src,
                                prompt: prompt
                            });
                        }, 500);

                        // If we've found all images for this prompt, stop waiting
                        if (automationState.imagesFoundForCurrentPrompt >= imagesPerPrompt) {
                            automationState.waitingForImage = false;
                            console.log(`[Whisk Automator] Todas as ${imagesPerPrompt} imagens encontradas para este prompt`);

                            // Check if automation is complete
                            if (automationState.currentIndex >= automationState.prompts.length) {
                                handleAutomationComplete();
                            }
                        }
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