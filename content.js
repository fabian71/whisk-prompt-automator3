(function () {
    console.log('%c FLOW AUTOMATOR LEVANTANDO... ', 'background: #222; color: #bada55; font-size: 20px');
    'use strict';

    if (window.flowAutomatorLoaded) {
        return;
    }
    window.flowAutomatorLoaded = true;

    // --- State Management ---
    let automationState = {
        isRunning: false,
        prompts: [],
        currentIndex: 0,
        delay: 20,
        timeoutId: null,
        waitingForUpscaleToast: false,
        settings: {
            randomize: false,
            aspectRatios: []
        },
        // Break/pause system
        promptsSinceLastBreak: 0,
        isOnBreak: false,
        breakEndTime: null,
        breakTimeoutId: null
    };


    // Set to track processed video IDs
    const processedVideos = new Set();

    // Buffer for mutations to handle multiple variants appearing at once
    let mutationBuffer = [];
    let mutationTimeout = null;

    // --- Selectors (Language-Independent) ---
    const SELECTORS = {
        // Textarea selector using ID and common attributes
        textarea: '#PINHOLE_TEXT_AREA_ELEMENT_ID, textarea[placeholder], textarea[data-sharkid]',
        // Submit button identified by icon (arrow_forward) and position
        submitButtonIcon: 'arrow_forward',
        // Aspect ratio icon
        aspectRatioIcon: 'crop_16_9'
    };

    // --- Utility Functions ---
    function findElement(selector, parent = document) {
        return parent.querySelector(selector);
    }

    function findAllElements(selector, parent = document) {
        return Array.from(parent.querySelectorAll(selector));
    }

    function findCreateButton() {
        // Find button with arrow_forward icon (submit button)
        const buttons = findAllElements('button');
        return buttons.find(btn => {
            const icon = btn.querySelector('i.material-icons, i.google-symbols');
            if (icon && icon.textContent.trim() === SELECTORS.submitButtonIcon) {
                return true;
            }
            // Fallback: check if button contains the icon text directly
            return btn.textContent.includes(SELECTORS.submitButtonIcon);
        });
    }

    function extractPromptFromImageElement(imgElement) {
        if (!imgElement) return null;

        // 1) Try alt attribute ("Flow Image: <prompt>")
        const alt = imgElement.getAttribute('alt');
        if (alt && alt.toLowerCase().startsWith('flow image:')) {
            const prompt = alt.split(':').slice(1).join(':').trim();
            if (prompt) return prompt;
        }

        // 2) Try the prompt button text inside the same card
        try {
            const card = imgElement.closest('.sc-333e51d6-0, [data-index]');
            if (card) {
                const promptButton = card.querySelector('.sc-6349d8ef-10');
                if (promptButton && promptButton.textContent.trim()) {
                    return promptButton.textContent.trim();
                }
            }
        } catch (e) {
            // ignore selector errors
        }

        return null;
    }

    function waitForEnabledCreateButton(timeout = 10000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const button = findCreateButton();
                const isDisabled = button && (button.disabled || button.getAttribute('aria-disabled') === 'true');
                if (button && !isDisabled) {
                    return resolve(button);
                }
                if (Date.now() - start >= timeout) {
                    return reject(new Error('Submit button not found or still disabled.'));
                }
                requestAnimationFrame(check);
            };
            check();
        });
    }

    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            console.log(`[Flow Automator Debug] Waiting for element: ${selector}`);
            const element = findElement(selector);
            if (element) {
                console.log(`[Flow Automator Debug] Element found immediately: ${selector}`);
                return resolve(element);
            }

            const observer = new MutationObserver(() => {
                const element = findElement(selector);
                if (element) {
                    console.log(`[Flow Automator Debug] Element found via mutation: ${selector}`);
                    observer.disconnect();
                    resolve(element);
                }
            });

            const timer = setTimeout(() => {
                observer.disconnect();
                console.warn(`[Flow Automator Debug] Context: Element NOT found after timeout: ${selector}`);
                reject(new Error(`Element not found: ${selector}`));
            }, timeout);

            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    function sendMessageToBackground(message) {
        try {
            chrome.runtime.sendMessage(message, () => {
                if (chrome.runtime.lastError) {
                    // Suppress
                }
            });
        } catch (e) {
            console.warn('Extension context invalid/disconnected.');
        }
    }

    function simulateTyping(element, text) {
        element.focus();
        element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }



    async function simulateSafeClick(element) {
        if (!element) return;

        console.log('[Flow Automator] Targeting element for interaction:', element);

        // 1. Focus the element first
        element.focus();

        // 2. Dispatch Mouse Events sequence
        const mouseEvents = ['mouseover', 'mousedown', 'mouseup', 'click'];
        mouseEvents.forEach(type => {
            const evt = new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                buttons: 1 // Left click
            });
            element.dispatchEvent(evt);
        });

        // Removed Keyboard events to prevent double-download trigger
        // If click fails again, we might need to swap this for ONLY keyboard events
    }

    // --- Core Logic ---

    // --- Generation Mode Selection ---
    async function selectGenerationMode(mode) {
        try {
            console.log(`[Flow Automator] Selecting generation mode: ${mode}`);

            // Find the dropdown button that contains "Criar imagens" or similar text
            // Based on the HTML: <button data-state="closed" class="..."><span>Criar imagens</span>...
            const allButtons = findAllElements('button');

            // Look for the button that has a select element as a sibling
            const dropdownButton = allButtons.find(btn => {
                // Check if this button has a sibling select with data-sharkid
                const parent = btn.parentElement;
                if (parent) {
                    const selectElement = parent.querySelector('select[data-sharkid]');
                    if (selectElement) {
                        // Found the generation mode dropdown
                        return true;
                    }
                }
                return false;
            });

            if (!dropdownButton) {
                console.warn('[Flow Automator] Generation mode dropdown not found. Continuing with default...');
                return;
            }

            // Get current mode from button text
            const buttonText = dropdownButton.textContent.trim();
            console.log(`[Flow Automator] Current mode button text: "${buttonText}"`);

            // Check if we need to change mode
            const needsChange = (mode === 'IMAGE_GENERATION' && !buttonText.includes('Criar imagens')) ||
                (mode === 'TEXT_TO_VIDEO' && !buttonText.includes('Texto para vídeo'));

            if (!needsChange) {
                console.log('[Flow Automator] Already in correct mode. Skipping...');
                return;
            }

            // Click to open dropdown
            console.log('[Flow Automator] Opening generation mode dropdown...');
            dropdownButton.click();
            await new Promise(resolve => setTimeout(resolve, 500));

            // Find the select element and get the correct option
            const parent = dropdownButton.parentElement;
            const selectElement = parent.querySelector('select[data-sharkid]');

            if (selectElement) {
                // Find the option with the desired value
                const option = Array.from(selectElement.options).find(opt => opt.value === mode);

                if (option) {
                    console.log(`[Flow Automator] Found option: ${option.text}`);

                    // Set the select value (this might trigger change events)
                    selectElement.value = mode;
                    selectElement.dispatchEvent(new Event('change', { bubbles: true }));

                    // Also try to click the visual button option if it exists
                    // Look for buttons with the option text
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const optionButtons = findAllElements('button');
                    const targetButton = optionButtons.find(btn => {
                        const text = btn.textContent.toLowerCase();
                        if (mode === 'IMAGE_GENERATION') {
                            return text.includes('criar imagens') || text.includes('image generation');
                        } else if (mode === 'TEXT_TO_VIDEO') {
                            return text.includes('texto para vídeo') || text.includes('text to video');
                        }
                        return false;
                    });

                    if (targetButton) {
                        console.log('[Flow Automator] Clicking visual option button...');
                        targetButton.click();
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                } else {
                    console.warn(`[Flow Automator] Option ${mode} not found in select`);
                }
            }

            // Close dropdown by clicking button again (if still open)
            await new Promise(resolve => setTimeout(resolve, 200));

            // --- SPECIAL CONFIGURATION FOR IMAGE MODE ---
            if (mode === 'IMAGE_GENERATION') {
                console.log('[Flow Automator] Configuring image settings (Respostas por comando = 1)...');

                // 1. Find and click the settings button (tune icon)
                const settingsButton = allButtons.find(btn => {
                    const icon = btn.querySelector('i.material-icons');
                    if (icon && icon.textContent.trim() === 'tune') {
                        return true;
                    }
                    // Also check aria-label
                    const ariaLabel = btn.getAttribute('aria-label');
                    return ariaLabel && ariaLabel.toLowerCase().includes('configurações');
                });

                if (settingsButton) {
                    console.log('[Flow Automator] Opening settings dialog...');
                    settingsButton.click();
                    await new Promise(resolve => setTimeout(resolve, 800));

                    // 2. Find the "Respostas por comando" combobox
                    const comboboxButtons = findAllElements('button[role="combobox"]');
                    const responsesCombobox = comboboxButtons.find(btn => {
                        const text = btn.textContent.toLowerCase();
                        return text.includes('respostas por comando') || text.includes('responses per prompt');
                    });

                    if (responsesCombobox) {
                        console.log('[Flow Automator] Found "Respostas por comando" combobox');

                        // Check current value
                        const currentValue = responsesCombobox.textContent;
                        console.log('[Flow Automator] Current value:', currentValue);

                        // Only click if not already set to 1
                        if (!currentValue.includes('1') || currentValue.includes('10') || currentValue.includes('12')) {
                            console.log('[Flow Automator] Opening combobox to select "1"...');
                            responsesCombobox.click();
                            await new Promise(resolve => setTimeout(resolve, 500));

                            // 3. Find and click option "1"
                            // Look for elements with role="option" or similar
                            const options = findAllElements('[role="option"], button, div');
                            const option1 = options.find(opt => {
                                const text = opt.textContent.trim();
                                // Match exactly "1" (not "10", "12", etc.)
                                return text === '1' || text === '1 resposta' || text === '1 response';
                            });

                            if (option1) {
                                console.log('[Flow Automator] Clicking option "1"...');
                                option1.click();
                                await new Promise(resolve => setTimeout(resolve, 300));
                            } else {
                                console.warn('[Flow Automator] Option "1" not found in combobox');
                            }
                        } else {
                            console.log('[Flow Automator] Already set to 1, skipping...');
                        }

                        // Close settings dialog by clicking outside or close button
                        await new Promise(resolve => setTimeout(resolve, 300));

                        // Try to find close button or click settings button again
                        const closeButtons = findAllElements('button');
                        const closeBtn = closeButtons.find(btn => {
                            const icon = btn.querySelector('i.material-icons');
                            return icon && (icon.textContent.trim() === 'close' || icon.textContent.trim() === 'x');
                        });

                        if (closeBtn) {
                            closeBtn.click();
                        } else {
                            // Click settings button again to close
                            settingsButton.click();
                        }

                        await new Promise(resolve => setTimeout(resolve, 500));
                        console.log('[Flow Automator] Settings configured successfully');
                    } else {
                        console.warn('[Flow Automator] "Respostas por comando" combobox not found');
                    }
                } else {
                    console.warn('[Flow Automator] Settings button (tune icon) not found');
                }
            }

        } catch (error) {
            console.error('[Flow Automator] Error selecting generation mode:', error);
            // Continue anyway - don't block automation
        }
    }

    async function submitPrompt(prompt, aspectRatio) {
        try {
            console.log('[Flow Automator Debug] submitPrompt called. Finding textarea...');

            // FIRST: Select generation mode if specified
            if (automationState.settings.generationMode) {
                await selectGenerationMode(automationState.settings.generationMode);
            }

            const textarea = await waitForElement(SELECTORS.textarea);
            console.log('[Flow Automator Debug] Textarea found. Typing prompt...');
            simulateTyping(textarea, prompt);
            await new Promise(resolve => setTimeout(resolve, 500)); // Delay after typing

            if (automationState.settings.randomize && aspectRatio) {
                // Find aspect ratio button by icon instead of text
                const allButtons = findAllElements('button');
                const ratioButton = allButtons.find(btn => {
                    const icon = btn.querySelector('i.material-icons, i.google-symbols');
                    return icon && icon.textContent.trim() === SELECTORS.aspectRatioIcon;
                });

                if (ratioButton) {
                    ratioButton.click();
                    await new Promise(resolve => setTimeout(resolve, 500));

                    await waitForElement('button span');
                    const optionButtons = findAllElements('button');
                    const targetButton = optionButtons.find(btn => btn.textContent.trim() === aspectRatio);

                    if (targetButton) {
                        targetButton.click();
                        await new Promise(resolve => setTimeout(resolve, 250));
                    } else {
                        console.warn(`Could not find aspect ratio option: ${aspectRatio}`);
                    }

                    ratioButton.click();
                    await new Promise(resolve => setTimeout(resolve, 250));
                } else {
                    console.warn('Aspect ratio button not found. Continuing with default configuration.');
                }
            }

            const submitButton = await waitForEnabledCreateButton();
            submitButton.click();

        } catch (error) {
            console.error('Error submitting prompt:', error);
            throw error;
        }
    }

    function handleAutomationComplete() {
        stopTimer();
        stopVideoPolling();
        updateFloatingUI({
            status: '✅ Concluído!',
            progress: automationState.prompts.length,
            total: automationState.prompts.length,
            state: 'success'
        });

        sendMessageToBackground({
            action: 'automationComplete',
            totalPrompts: automationState.prompts.length
        });
        resetAutomation();
    }

    function resetAutomation() {
        if (automationState.timeoutId) clearTimeout(automationState.timeoutId);
        if (automationState.breakTimeoutId) clearTimeout(automationState.breakTimeoutId);
        stopTimer();
        stopVideoPolling(); // Stop fallback polling
        automationState = {
            isRunning: false,
            prompts: [],
            currentIndex: 0,
            delay: 20,
            timeoutId: null,
            processedThisTurn: false, // Flag to limit 1 download per prompt
            waitingForUpscaleToast: false,
            isPaused: false, // New state
            settings: { autoDownload: true, upscale: true, saveTxt: false },
            promptsSinceLastBreak: 0,
            isOnBreak: false,
            breakEndTime: null,
            breakTimeoutId: null
        };
    }

    function scheduleNextPrompt() {
        // Allow scheduling even if paused? No.
        if (!automationState.isRunning || automationState.isPaused) return;

        if (automationState.waitingForUpscaleToast) {
            console.log('[Flow Automator] Awaiting upscale completion toast. Next prompt will wait.');
            return;
        }

        // Ensure we don't schedule multiple times
        if (automationState.timeoutId) clearTimeout(automationState.timeoutId);

        // Check if we should take a break
        if (automationState.settings.breakEnabled) {
            automationState.promptsSinceLastBreak++;

            const shouldBreak = automationState.promptsSinceLastBreak >= automationState.settings.breakPrompts;
            const hasMorePrompts = automationState.currentIndex < automationState.prompts.length;

            if (shouldBreak && hasMorePrompts) {
                console.log(`[Flow Automator] ☕ Iniciando pausa de ${automationState.settings.breakDuration} minutos...`);
                startBreak();
                return; // Don't schedule next prompt yet
            }
        }

        console.log(`[Flow Automator] Scheduling next prompt in ${automationState.delay} seconds...`);
        sendMessageToBackground({
            action: 'updateStatus',
            message: `Aguardando ${automationState.delay}s para o próximo...`,
            type: 'running'
        });

        stopTimer(); // Pause timer during delay wait
        updateFloatingUI({ status: `Aguardando ${automationState.delay}s...` });

        automationState.timeoutId = setTimeout(() => {
            runAutomation();
        }, automationState.delay * 1000);
    }

    function startBreak() {
        automationState.isOnBreak = true;
        const breakDurationMs = automationState.settings.breakDuration * 60 * 1000;
        automationState.breakEndTime = Date.now() + breakDurationMs;

        console.log(`[Flow Automator] ☕ Pausa iniciada. Retomando em ${automationState.settings.breakDuration} minutos...`);

        sendMessageToBackground({
            action: 'updateStatus',
            message: `☕ Pausa de ${automationState.settings.breakDuration} min`,
            type: 'running'
        });

        updateFloatingUI({
            status: `☕ Pausa (${automationState.settings.breakDuration} min)`,
            prompt: `Retomando em ${automationState.settings.breakDuration} minutos...`
        });

        // Stop the main timer during break
        stopTimer();

        // Schedule end of break
        automationState.breakTimeoutId = setTimeout(() => {
            endBreak();
        }, breakDurationMs);

        // Update UI every second during break
        const breakInterval = setInterval(() => {
            if (!automationState.isOnBreak) {
                clearInterval(breakInterval);
                return;
            }

            const remainingMs = automationState.breakEndTime - Date.now();
            if (remainingMs <= 0) {
                clearInterval(breakInterval);
                return;
            }

            const remainingMin = Math.ceil(remainingMs / 60000);
            updateFloatingUI({
                status: `☕ Pausa (${remainingMin} min restantes)`,
                prompt: 'Aguarde...'
            });
        }, 1000);
    }

    function endBreak() {
        console.log('[Flow Automator] ☕ Pausa finalizada. Retomando automação...');

        automationState.isOnBreak = false;
        automationState.promptsSinceLastBreak = 0; // Reset counter
        automationState.breakEndTime = null;

        if (automationState.breakTimeoutId) {
            clearTimeout(automationState.breakTimeoutId);
            automationState.breakTimeoutId = null;
        }

        sendMessageToBackground({
            action: 'updateStatus',
            message: 'Retomando automação...',
            type: 'running'
        });

        updateFloatingUI({
            status: 'Retomando...',
            prompt: 'Preparando próximo prompt...'
        });

        // Restart timer
        startTimer();

        // Schedule next prompt immediately
        setTimeout(() => {
            runAutomation();
        }, 2000);
    }

    async function runAutomation() {
        if (!automationState.isRunning) return;

        // Check if extension context is still valid
        try {
            chrome.runtime.getURL('');
        } catch (e) {
            console.error('[Flow Automator] Extension context invalidated!');
            alert('⚠️ A extensão foi recarregada.\n\nPor favor, recarregue esta página do Flow (F5) para continuar.');
            resetAutomation();
            return;
        }

        if (automationState.isPaused) {
            console.log('[Flow Automator] Automation is paused. Waiting for resume...');
            updateFloatingUI({ status: 'Pausado' });
            return;
        }

        if (automationState.currentIndex >= automationState.prompts.length) {
            handleAutomationComplete();
            return;
        }

        // Ensure we start this prompt without stale upscale waits
        automationState.waitingForUpscaleToast = false;

        // Reset the "processed one video" flag for this new prompt cycle
        automationState.processedThisTurn = false;

        // --- NEW: On first run/resume, mark ALL currently visible media as processed ---
        if (automationState.currentIndex === 0) {
            // Mark existing videos
            const existingVideos = document.querySelectorAll('video[src*="storage.googleapis.com"]');
            existingVideos.forEach(vid => {
                const id = extractVideoId(vid.src);
                if (id) {
                    processedVideos.add(id);
                    console.log('[Flow Automator] Ignoring existing video:', id);
                }
            });

            // Mark existing images
            const existingImages = document.querySelectorAll('img[src*="storage.googleapis.com"]');
            existingImages.forEach(img => {
                const src = img.currentSrc || img.src || img.getAttribute('src');
                if (src && src.includes('/image/')) {
                    const id = extractMediaId(src, 'image');
                    if (id) {
                        processedVideos.add(id);
                        console.log('[Flow Automator] Ignoring existing image:', id);
                    }
                }
            });
        }





        const currentPrompt = automationState.prompts[automationState.currentIndex];
        let currentAspectRatio = null;

        // Removed Aspect Ratio randomization as per user request

        // Initialize Floating UI if not present
        injectFloatingUI();

        // Start fallback polling for video detection
        startVideoPolling();

        // Start Timer & Update UI
        startTimer();
        updateFloatingUI({
            status: 'Gerando vídeo...',
            prompt: currentPrompt,
            progress: automationState.currentIndex + 1,
            total: automationState.prompts.length
        });

        sendMessageToBackground({
            action: 'updateStatus',
            message: `Enviando: "${currentPrompt.substring(0, 30)}..."`,
            type: 'running',
            progress: `Prompt ${automationState.currentIndex + 1} de ${automationState.prompts.length}`
        });

        try {
            await new Promise(resolve => setTimeout(resolve, 500));
            await submitPrompt(currentPrompt, currentAspectRatio);
            automationState.currentIndex++;

            // --- CHANGE: No longer auto-scheduling here based on time ---
            // The next step is triggered by Event (Video Ready OR Download Complete)

            if (automationState.isRunning) {
                sendMessageToBackground({
                    action: 'updateStatus',
                    message: 'Aguardando geração do vídeo...',
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
            return false;
        }

        if (request.action === 'startAutomation') {
            if (automationState.isRunning) {
                sendResponse({ status: 'already_running' });
                return false;
            }

            automationState.isRunning = true;
            automationState.prompts = request.prompts;
            automationState.delay = request.delay;
            automationState.settings = request.settings; // Store settings
            automationState.currentIndex = 0;
            automationState.isPaused = false; // Ensure not paused on start

            runAutomation();
            sendResponse({ status: 'started' });
            return false;
        }

        if (request.action === 'stopAutomation' || request.action === 'cancelAutomation') {
            resetAutomation();
            const ui = document.getElementById('flow-automator-ui');
            if (ui) ui.style.display = 'none';
            sendMessageToBackground({ action: 'updateStatus', message: 'Cancelado/Parado', type: 'stopped' });
            sendResponse({ status: 'stopped' });
            return false;
        }

        if (request.action === 'pauseAutomation') {
            automationState.isPaused = true;
            stopTimer();
            updateFloatingUI({ status: 'Pausado' });
            sendResponse({ status: 'paused' });
            return false;
        }

        if (request.action === 'resumeAutomation') {
            if (automationState.isPaused) {
                automationState.isPaused = false;
                startTimer();
                updateFloatingUI({ status: 'Retomando...' });
                runAutomation(); // Kickstart again
            }
            sendResponse({ status: 'resumed' });
            return false;
        }

        if (request.action === 'getStatus') {
            sendResponse({
                isRunning: automationState.isRunning,
                isPaused: automationState.isPaused,
                currentIndex: automationState.currentIndex,
                totalPrompts: automationState.prompts.length,
                statusMessage: automationState.isPaused ? 'Pausado' : `Executando ${automationState.currentIndex + 1}/${automationState.prompts.length}`,
                statusType: automationState.isRunning ? 'running' : 'stopped'
            });
            return false;
        }

        return false;
    });

    function handleMediaGeneration(mutations) {
        if (!automationState.isRunning) return;

        // Log para debug
        console.log(`[Flow Automator Debug] handleMediaGeneration called with ${mutations.length} mutations.`);

        // Accumulate mutations
        mutationBuffer.push(...mutations);

        if (mutationTimeout) clearTimeout(mutationTimeout);

        // Wait 1.5 seconds to collect all variants (e.g., if site generates 2 or 4 videos)
        mutationTimeout = setTimeout(() => {
            processBufferedMutations();
        }, 1500);
    }

    // --- FALLBACK: Polling para detectar vídeos/imagens caso MutationObserver falhe ---
    let pollingInterval = null;

    function startVideoPolling() {
        if (pollingInterval) return; // Already running
        console.log('[Flow Automator] Starting media polling fallback...');

        pollingInterval = setInterval(() => {
            if (!automationState.isRunning || automationState.processedThisTurn) return;

            // --- Also check for error toasts during polling ---
            const toasts = document.querySelectorAll('li[data-sonner-toast]');
            for (const toast of toasts) {
                const text = (toast.innerText || '').toLowerCase();
                const errorKeywords = ['erro', 'error', 'indisponível', 'unavailable', 'falhou', 'failed'];
                if (errorKeywords.some(kw => text.includes(kw))) {
                    console.log('[Flow Automator Polling] ❌ Error toast detected! Skipping...');
                    handleServiceError();
                    return;
                }
            }

            // Check for videos
            const videos = document.querySelectorAll('video');
            for (const video of videos) {
                const src = video.currentSrc || video.src || video.getAttribute('src');
                if (src && src.includes('storage.googleapis.com')) {
                    const videoId = extractVideoId(src);
                    if (videoId && !processedVideos.has(videoId)) {
                        console.log('[Flow Automator Polling] 🎬 Novo vídeo detectado via polling:', videoId);

                        // Lock and process
                        automationState.processedThisTurn = true;
                        processedVideos.add(videoId);

                        processVideoDownload(video, videoId).catch(err => {
                            console.error('[Flow Automator Polling] Error:', err);
                            automationState.processedThisTurn = false;
                        });
                        return; // Process one at a time
                    }
                }
            }

            // Check for images
            const images = document.querySelectorAll('img[src*="storage.googleapis.com"]');
            console.log(`[Flow Automator Polling] Found ${images.length} images from storage.googleapis.com`);
            for (const img of images) {
                const src = img.currentSrc || img.src || img.getAttribute('src');
                if (src && src.includes('/image/')) {
                    const imageId = extractMediaId(src, 'image');
                    if (imageId && !processedVideos.has(imageId)) {
                        console.log('[Flow Automator Polling] 🖼️ Nova imagem detectada via polling:', imageId);

                        // Lock and process
                        automationState.processedThisTurn = true;
                        processedVideos.add(imageId);

                        processMediaDownload(img, imageId, 'image').catch(err => {
                            console.error('[Flow Automator Polling] Error:', err);
                            automationState.processedThisTurn = false;
                        });
                        return; // Process one at a time
                    }
                }
            }
        }, 3000); // Check every 3 seconds
    }

    function stopVideoPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    }

    function handleServiceError() {
        if (!automationState.isRunning) return;

        // Prevent spamming
        if (automationState.isErrorHandling) return;
        automationState.isErrorHandling = true;

        console.log('[Flow Automator] Service Error detected. SKIPPING to next prompt...');

        sendMessageToBackground({
            action: 'updateStatus',
            message: 'Erro no Flow. Pulando para o próximo...',
            type: 'error'
        });

        // Destravar turno para permitir fluxo futuro
        automationState.processedThisTurn = false;
        automationState.waitingForUpscaleToast = false;

        // Reset Error state quickly so next prompt can run
        setTimeout(() => {
            automationState.isErrorHandling = false;
        }, 5000);

        // Schedule next immediately (skipping current because currentIndex was already incremented in runAutomation)
        scheduleNextPrompt();
    }

    function processBufferedMutations() {
        const mutations = mutationBuffer;
        mutationBuffer = []; // Clear buffer

        const validCandidates = [];

        // Debug: Count total nodes
        let addedNodesCount = 0;
        mutations.forEach(m => addedNodesCount += m.addedNodes.length);
        if (addedNodesCount > 0) {
            console.log(`[Flow Automator Debug] Processing ${mutations.length} mutations with ${addedNodesCount} added nodes.`);
        }

        // Error detection strings (expanded list)
        const errorTextValues = [
            'temporariamente indisponível',
            'temporarily unavailable',
            'tente novamente mais tarde',
            'try again later',
            'error generating',
            'erro ao gerar',
            'ocorreu um erro',
            'an error occurred',
            'falhou',
            'failed',
            'não foi possível',
            'could not',
            'unable to',
            'service unavailable',
            'serviço indisponível',
            'upscale error'
        ];

        for (const mutation of mutations) {
            // Handle newly added nodes
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) { // Element node
                        // Check for error messages first
                        const text = node.innerText ? node.innerText.toLowerCase() : '';
                        if (errorTextValues.some(err => text.includes(err))) {
                            console.warn('[Flow Automator] Service Error detected:', text);
                            handleServiceError();
                        }

                        // Check for video
                        const videos = [];
                        if (node.matches && node.matches('video')) videos.push(node);
                        if (node.querySelectorAll) videos.push(...Array.from(node.querySelectorAll('video')));

                        for (const video of videos) {
                            checkAndAddCandidate(video, 'childList', 'video');
                        }

                        // Check for images (for IMAGE_GENERATION mode)
                        const images = [];
                        if (node.matches && node.matches('img')) images.push(node);
                        if (node.querySelectorAll) images.push(...Array.from(node.querySelectorAll('img')));

                        for (const img of images) {
                            checkAndAddCandidate(img, 'childList', 'image');
                        }
                    }
                }
            }
            // Handle attribute changes (src update)
            else if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                const target = mutation.target;
                if (target.nodeName === 'VIDEO') {
                    checkAndAddCandidate(target, 'attributes', 'video');
                } else if (target.nodeName === 'IMG') {
                    checkAndAddCandidate(target, 'attributes', 'image');
                }
            }
        }

        function checkAndAddCandidate(element, source, mediaType) {
            const src = element.currentSrc || element.src || element.getAttribute('src');

            if (src) {
                // For images, check if it's from Google storage (generated images)
                // For videos, use existing logic
                const isValidMedia = src.includes('storage.googleapis.com');

                if (!isValidMedia) {
                    console.log(`[Flow Automator Debug] Ignored (Not from storage.googleapis.com):`, src);
                    return;
                }

                // IMPORTANT: Detect actual media type from URL, not just element type
                // Flow uses <video> elements to display images, so we need to check the URL
                let actualMediaType = mediaType;
                if (src.includes('/image/')) {
                    actualMediaType = 'image';
                    console.log('[Flow Automator Debug] URL contains /image/ - treating as image');
                } else if (src.includes('/video/')) {
                    actualMediaType = 'video';
                    console.log('[Flow Automator Debug] URL contains /video/ - treating as video');
                }

                // LOG: Show detected media
                console.log(`[Flow Automator Debug] 👀 ${actualMediaType} detectado via ${source}:`, src, element);

                const mediaId = extractMediaId(src, actualMediaType) || `temp_id_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

                if (extractMediaId(src, actualMediaType)) {
                    console.log(`[Flow Automator] ID extraído com sucesso: ${mediaId}`);
                } else {
                    console.warn(`[Flow Automator] ID não encontrado no SRC. Usando ID temporário para rastreio: ${mediaId}`);
                }

                if (processedVideos.has(mediaId)) {
                    // console.log(`[Flow Automator Debug] Ignored (Already processed): ${mediaId}`);
                } else {
                    // Avoid adding duplicates to candidates list
                    if (!validCandidates.some(c => c.id === mediaId)) {
                        console.log(`[Flow Automator Debug] ✅ Candidato VÁLIDO adicionado (${actualMediaType}):`, mediaId);
                        validCandidates.push({ element, id: mediaId, type: actualMediaType });
                    }
                }
            } else {
                console.log(`[Flow Automator Debug] Ignorado (Sem SRC):`, element);
            }
        }

        if (validCandidates.length === 0) return;

        console.log(`[Flow Automator] Buffered detection found ${validCandidates.length} new candidates.`);

        // Logic: specific to prevent duplicates per turn
        if (automationState.processedThisTurn) {
            console.log('[Flow Automator] Turn LOCKED. Ignoring these candidates. (Waiting for next runAutomation)');
            return;
        }

        // Pick the FIRST valid candidate
        const selected = validCandidates[0];
        console.log('[Flow Automator] Selected target media:', selected.id, 'Type:', selected.type);

        // LOCK & MARK
        automationState.processedThisTurn = true;
        validCandidates.forEach(c => processedVideos.add(c.id));

        // Process the selected media (video or image)
        processMediaDownload(selected.element, selected.id, selected.type).catch(error => {
            console.error('[Flow Automator] Error processing media:', error);
            // Unlock if error occurs immediately?
            automationState.processedThisTurn = false;
        });
    }



    // Helper to extract UUID from URL (works for both videos and images)
    function extractMediaId(url, mediaType) {
        try {
            // For videos: URL format usually: .../video/UUID?params...
            // For images: URL format usually: .../image/UUID?params... or similar
            const videoMatch = url.match(/\/video\/([a-f0-9-]+)/i);
            const imageMatch = url.match(/\/image\/([a-f0-9-]+)/i);

            if (mediaType === 'video' && videoMatch) {
                return videoMatch[1];
            } else if (mediaType === 'image' && imageMatch) {
                return imageMatch[1];
            }

            // Fallback: try to extract any UUID-like pattern
            const genericMatch = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
            return genericMatch ? genericMatch[1] : null;
        } catch (e) {
            return null;
        }
    }

    // Legacy function for backward compatibility
    function extractVideoId(url) {
        return extractMediaId(url, 'video');
    }

    async function processMediaDownload(element, mediaId, mediaType) {
        console.log(`[Flow Automator] Starting download flow for ${mediaType}:`, mediaId);

        // For images, we might not have the same "generating %" indicator
        // So we'll use a simpler wait strategy
        if (mediaType === 'image') {
            // Wait for image to fully load
            if (element.complete && element.naturalHeight !== 0) {
                console.log('[Flow Automator] Image already loaded');
            } else {
                console.log('[Flow Automator] Waiting for image to load...');
                await new Promise((resolve) => {
                    element.onload = resolve;
                    element.onerror = resolve; // Continue even if error
                    setTimeout(resolve, 5000); // Timeout after 5s
                });
            }

            // Additional wait for UI to stabilize
            await new Promise(resolve => setTimeout(resolve, 2000));

            // VERIFY: Check if this image belongs to the current prompt
            let promptIndex = automationState.currentIndex > 0 ? automationState.currentIndex - 1 : 0;
            const currentPrompt = automationState.prompts[promptIndex] || '';

            // Find the prompt button in the image container
            let container = element;
            for (let i = 0; i < 20; i++) {
                container = container.parentElement;
                if (!container) break;
            }

            if (container) {
                // Look for button with class sc-79194130-10 (or similar) that contains the prompt
                const promptButton = container.querySelector('button.sc-79194130-10, button[class*="79194130"]');

                if (promptButton) {
                    const buttonText = promptButton.textContent.trim();
                    console.log('[Flow Automator] Found prompt button with text:', buttonText.substring(0, 100) + '...');
                    console.log('[Flow Automator] Current prompt:', currentPrompt.substring(0, 100) + '...');

                    // Compare prompts (normalize whitespace)
                    const normalizedButtonText = buttonText.replace(/\s+/g, ' ').trim();
                    const normalizedPrompt = currentPrompt.replace(/\s+/g, ' ').trim();

                    if (!normalizedButtonText.includes(normalizedPrompt.substring(0, 50))) {
                        console.warn('[Flow Automator] ⚠️ Image does NOT match current prompt! Skipping...');
                        console.log('[Flow Automator] Expected:', normalizedPrompt.substring(0, 100));
                        console.log('[Flow Automator] Found:', normalizedButtonText.substring(0, 100));

                        // Unlock and skip this image
                        automationState.processedThisTurn = false;
                        processedVideos.delete(mediaId);
                        return;
                    } else {
                        console.log('[Flow Automator] ✅ Image matches current prompt! Proceeding with download...');
                    }
                } else {
                    console.warn('[Flow Automator] Could not find prompt button to verify. Proceeding anyway...');
                }
            }
        } else {
            // Original video logic
            await processVideoWait(element, mediaId);
        }

        // --- Notify Background to Prepare for Download (Name & TXT) ---
        if (automationState.settings.autoDownload) {
            try {
                let promptIndex = automationState.currentIndex > 0 ? automationState.currentIndex - 1 : 0;
                let currentPrompt = automationState.prompts[promptIndex] || 'Unknown Prompt';

                // For images, prefer grabbing the prompt from the DOM (alt/button text) to avoid mismatches
                if (mediaType === 'image') {
                    const domPrompt = extractPromptFromImageElement(element);
                    if (domPrompt) {
                        console.log('[Flow Automator] Using DOM prompt for image:', domPrompt);
                        currentPrompt = domPrompt;
                    }
                }

                console.log('[Flow Automator] Notifying background to prepare download for:', currentPrompt.substring(0, 30));
                console.log('[Flow Automator Debug] Settings being sent:', {
                    saveTxt: automationState.settings.saveTxt,
                    subfolder: automationState.settings.subfolder
                });

                await new Promise(resolve => {
                    chrome.runtime.sendMessage({
                        action: 'prepareDownload',
                        prompt: currentPrompt,
                        saveTxt: automationState.settings.saveTxt,
                        subfolder: automationState.settings.subfolder
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.warn('[Flow Automator] Warning: Could not notify background (naming might be generic).', chrome.runtime.lastError);
                        } else {
                            console.log('[Flow Automator] ✅ Background confirmed metadata preparation:', response);
                        }
                        resolve();
                    });
                    setTimeout(resolve, 500);
                });

            } catch (err) {
                console.warn('[Flow Automator] Error preparing download metadata:', err);
                if (err.message && err.message.includes('Extension context invalidated')) {
                    console.error('CRITICAL: Extension updated/reloaded. Please refresh the page.');
                    alert('⚠️ A extensão foi atualizada/recarregada.\n\nPor favor, recarregue esta página do Flow (F5) para continuar.');
                    // Stop automation
                    resetAutomation();
                    return;
                }
            }
        }

        // Wait a bit to ensure background has processed the metadata
        console.log('[Flow Automator] Waiting for background to process metadata...');
        await new Promise(resolve => setTimeout(resolve, 800));

        // Find the download button
        const downloadButton = await findDownloadButton(element);

        if (downloadButton && automationState.settings.autoDownload) {
            console.log('[Flow Automator] Clicking download button...');
            downloadButton.click();

            await new Promise(resolve => setTimeout(resolve, 500));

            // For images, we don't have upscale options (usually)
            if (mediaType === 'video') {
                if (automationState.settings.upscale) {
                    await clickHighResolutionOption();
                } else {
                    await clickOriginalResolutionOption();
                }
            } else {
                // For images, just click the download option
                await clickImageDownloadOption();
            }

            if (automationState.currentIndex >= automationState.prompts.length) {
                handleAutomationComplete();
            }
        } else {
            console.warn('[Flow Automator] Download button not found for media:', mediaId);
            console.log('[Flow Automator] Unlocking turn to allow retry...');
            automationState.processedThisTurn = false;
            processedVideos.delete(mediaId);
        }
    }

    // Separate function for video-specific waiting logic
    async function processVideoWait(video, videoId) {
        let retries = 0;
        const maxRetries = 60;

        while (retries < maxRetries) {
            const container = video.closest('div[data-index]') || video.parentElement.parentElement;
            if (container) {
                const text = container.innerText;
                if (/\b\d+%\b/.test(text)) {
                    console.log(`[Flow Automator] Video ${videoId} still generating (found %). Waiting...`);
                    await new Promise(r => setTimeout(r, 1000));
                    retries++;
                    continue;
                }
            }
            break;
        }

        console.log('[Flow Automator] Video gerado. Aguardando 5 segundos para estabilização da UI...');
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // New function for image download
    async function clickImageDownloadOption() {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const allMenuItems = Array.from(document.querySelectorAll('[role="menuitem"], div[role="menuitem"]'));
        console.log('[Flow Automator] Image menu items found:', allMenuItems.length);

        // Prefer the 2K option when available, otherwise fall back to any download entry
        const twoKButton = allMenuItems.find(btn => {
            const text = btn.textContent.toLowerCase();
            return text.includes('2k') && text.includes('download');
        });

        const downloadButton = twoKButton || allMenuItems.find(btn => {
            const text = btn.textContent.toLowerCase();
            return (text.includes('download') || text.includes('baixar')) && !text.includes('gif');
        });

        if (downloadButton) {
            const label = downloadButton.textContent.trim().substring(0, 50);
            console.log(`[Flow Automator] Clicking image download option: ${twoKButton ? '2K preferred' : 'fallback'} (${label})`);
            simulateSafeClick(downloadButton);

            sendMessageToBackground({
                action: 'updateStatus',
                message: twoKButton ? 'Download 2K (Imagem)' : 'Download iniciado (Imagem)',
                type: 'running'
            });

            // If we clicked the 2K option, wait for upscale completion before advancing
            if (twoKButton) {
                automationState.waitingForUpscaleToast = true;
                await monitorUpscaleNotification({ mediaType: 'image' }).catch(err => console.error(err));
            } else {
                setTimeout(() => scheduleNextPrompt(), 3000);
            }
        } else {
            console.warn('[Flow Automator] Image download option not found. Skipping...');
            scheduleNextPrompt();
        }
    }

    // Keep original function name for backward compatibility
    async function processVideoDownload(video, videoId) {
        return processMediaDownload(video, videoId, 'video');
    }


    async function findDownloadButton(mediaElement) {
        console.log('[Flow Automator] Finding download button for element:', mediaElement.tagName);

        const isDownloadButton = (btn) => {
            // Must be visible
            const rect = btn.getBoundingClientRect();
            if (!rect || rect.width === 0 || rect.height === 0) return false;

            const icon = btn.querySelector('i.google-symbols, i.material-icons, i.material-icons-outlined');
            if (icon && icon.textContent.trim().toLowerCase() === 'download') return true;

            const text = (btn.textContent || '').toLowerCase();
            if (text.includes('download') || text.includes('baixar')) return true;

            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (label.includes('download') || label.includes('baixar')) return true;

            return false;
        };

        // 1) Closest-ancestor first: walk up and search within that subtree to avoid picking the other card's button
        let ancestor = mediaElement;
        const maxLevels = mediaElement.tagName === 'IMG' ? 25 : 15; // Go higher for images
        for (let i = 0; i < maxLevels && ancestor; i++) {
            const buttons = Array.from(ancestor.querySelectorAll('button'));
            const localTarget = buttons.find(isDownloadButton);
            if (localTarget) {
                console.log(`[Flow Automator] Found download button in nearest ancestor at level ${i}`);
                return localTarget;
            }
            ancestor = ancestor.parentElement;
        }

        // Fallback to previous broader search
        // Navigate up to find the media card container
        let container = mediaElement;

        for (let i = 0; i < maxLevels; i++) {
            container = container.parentElement;
            if (!container) break;

            // Look for a container that has download buttons
            const hasDownloadButton = container.querySelector('button i[class*="google-symbols"], button i[class*="material-icons"]');
            if (hasDownloadButton && i > 3) { // Skip immediate parents
                console.log(`[Flow Automator] Found potential container at level ${i}`);
                break;
            }
        }

        if (!container) {
            console.warn('[Flow Automator] Could not find container for element');
            container = document.body; // Fallback to searching entire document
        }

        // Find all buttons in the container
        const buttons = Array.from(container.querySelectorAll('button'));
        console.log(`[Flow Automator] Found ${buttons.length} buttons in container`);

        // Strategy 1: Look for standard download icons (both google-symbols and material-icons)
        let target = buttons.find(btn => {
            const icon = btn.querySelector('i.google-symbols, i.material-icons, i.material-icons-outlined');
            if (icon) {
                const txt = icon.textContent.trim();
                console.log(`[Flow Automator Debug] Button icon text: "${txt}"`);
                if (txt === 'download') {
                    console.log('[Flow Automator] ✅ Found download button by icon!');
                    return true;
                }
            }
            return false;
        });

        if (target) return target;

        // Strategy 2: Look for button text content (Download / Baixar)
        target = buttons.find(btn => {
            const text = btn.textContent.toLowerCase();
            if (text.includes('download') || text.includes('baixar')) {
                console.log('[Flow Automator] ✅ Found download button by text!');
                return true;
            }
            return false;
        });

        if (target) return target;

        // Strategy 3: Look for aria-label
        target = buttons.find(btn => {
            const label = btn.getAttribute('aria-label');
            if (label && (label.toLowerCase().includes('download') || label.toLowerCase().includes('baixar'))) {
                console.log('[Flow Automator] ✅ Found download button by aria-label!');
                return true;
            }
            return false;
        });

        if (target) return target;

        // Strategy 4: If still not found, search in the entire document
        console.warn('[Flow Automator] Download button not found in container, searching entire document...');
        const allButtons = Array.from(document.querySelectorAll('button'));

        target = allButtons.find(btn => {
            const icon = btn.querySelector('i.google-symbols, i.material-icons, i.material-icons-outlined');
            if (icon && icon.textContent.trim() === 'download') {
                // Make sure this button is visible
                const rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    console.log('[Flow Automator] ✅ Found download button in document!');
                    return true;
                }
            }
            return false;
        });

        if (!target) {
            console.error('[Flow Automator] ❌ Download button NOT found anywhere!');
            console.log('[Flow Automator Debug] Dumping first 10 buttons with icons:');
            allButtons.slice(0, 10).forEach((btn, idx) => {
                const icon = btn.querySelector('i');
                if (icon) {
                    const rect = btn.getBoundingClientRect();
                    console.log(`  Button ${idx}: icon="${icon.textContent.trim()}", class="${icon.className}", visible=${rect.width > 0}`);
                }
            });
        }

        return target;
    }

    async function clickOriginalResolutionOption() {
        // Wait for menu to be visible (increased time for stability)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // CRITICAL FIX: Only select actual menu items, IGNORE the trigger button (aria-haspopup)
        const allMenuItems = Array.from(document.querySelectorAll('[role="menuitem"], div[role="menuitem"]'));

        console.log('[Flow Automator] Menu items found:', allMenuItems.length, allMenuItems);

        // Try to find "Tamanho original (720p)" specifically first
        const standardButton = allMenuItems.find(btn => {
            const text = btn.textContent.toLowerCase();

            // Priority 1: Exact match as per user request
            if (text.includes('tamanho original') && text.includes('720p')) return true;

            // Priority 2: Standard fallback
            return (text.includes('tamanho original') || text.includes('original') || text.includes('baixar') || text.includes('download'))
                && !text.includes('ampliada')
                && !text.includes('1080')
                && !text.includes('enhanced')
                && !text.includes('gif');
        });

        if (standardButton) {
            console.log('[Flow Automator] Clicking original resolution option (simulated)...', standardButton);

            // Use safe click simulation
            simulateSafeClick(standardButton);

            sendMessageToBackground({
                action: 'updateStatus',
                message: 'Download iniciado (Original)',
                type: 'running'
            });

            // Since there is no toast to wait for, we just wait a bit and schedule next
            setTimeout(() => scheduleNextPrompt(), 5000);
        } else {
            console.warn('[Flow Automator] Original resolution option not found in menu items. Trying fallback via text content...');

            // Fallback 1: Re-scan document for ANY element containing "Tamanho original" visible on screen
            // This is useful if role="menuitem" is not yet applied or finding failing
            const allElements = Array.from(document.body.getElementsByTagName('*'));
            const textMatch = allElements.find(el => {
                // Check if element has direct text content matching what we want
                // and is likely a menu item (e.g. div or span with some text)
                if (el.children.length > 1) return false; // Skip containers
                const txt = el.textContent ? el.textContent.toLowerCase() : '';
                return txt.includes('tamanho original') && txt.includes('720p');
            });

            if (textMatch) {
                console.log('[Flow Automator] Fallback found element by text:', textMatch);
                simulateSafeClick(textMatch);
                setTimeout(() => scheduleNextPrompt(), 5000);
            } else {
                console.warn('[Flow Automator] CRITICAL: Could not find download option. Skipping.');
                scheduleNextPrompt();
            }
        }
    }

    async function clickHighResolutionOption() {
        // Wait for menu to be visible
        await new Promise(resolve => setTimeout(resolve, 300));

        // Look for menu items containing "1080p" or "Resolução ampliada"
        const allButtons = Array.from(document.querySelectorAll('button, [role="menuitem"]'));

        const highResButton = allButtons.find(btn => {
            const text = btn.textContent.toLowerCase();
            return text.includes('1080p') ||
                text.includes('resolução ampliada') ||
                text.includes('resolucion ampliada') ||
                text.includes('high resolution') ||
                text.includes('enhanced resolution');
        });

        if (highResButton) {
            console.log('[Flow Automator] Clicking high resolution option...');
            highResButton.click();

            // Wait for download to start
            await new Promise(resolve => setTimeout(resolve, 1000));

            sendMessageToBackground({
                action: 'updateStatus',
                message: 'Upscaling... Monitorando conclusão',
                type: 'running'
            });

            // Start monitoring for success toast
            automationState.waitingForUpscaleToast = true;
            monitorUpscaleNotification().catch(err => console.error(err));

        } else {
            console.warn('[Flow Automator] High resolution option not found in menu');
            // Try to find any download option
            const anyDownloadOption = allButtons.find(btn => {
                const text = btn.textContent.toLowerCase();
                return text.includes('download') || text.includes('baixar');
            });

            if (anyDownloadOption) {
                console.log('[Flow Automator] Clicking default download option...');
                anyDownloadOption.click();
                // If we clicked default download, we assume it's done quickly or we can't track it easily without toast
                // So we schedule next prompt anyway after a safe buffer
                setTimeout(() => scheduleNextPrompt(), 5000);
            } else {
                // Nothing found, continue
                scheduleNextPrompt();
            }
        }
    }

    async function monitorUpscaleNotification(options = {}) {
        const { mediaType = 'video' } = options;

        console.log(`[Flow Automator] Monitoring for upscale completion toast (${mediaType})...`);
        const maxWaitTime = 600000; // Wait up to 10 minutes
        const checkInterval = 1000;
        const startTime = Date.now();

        // Error keywords to detect (accent-insensitive)
        const errorKeywords = [
            'erro',
            'error',
            'indisponivel',
            'unavailable',
            'falhou',
            'failed',
            'tente novamente',
            'try again'
        ];

        const successKeywords = [
            'resolucao foi aumentada',
            'resolution has been enhanced',
            'upscaling complete',
            'upscaling completed',
            'image has been downloaded'
        ];

        return new Promise((resolve) => {
            const findDismissButton = (toast) => {
                return Array.from(toast.querySelectorAll('button')).find(btn => {
                    const t = btn.textContent.trim().toLowerCase();
                    return t.includes('dispensar') || t.includes('dismiss');
                });
            };

            const clickDismissAndWait = async (toast) => {
                const start = Date.now();
                return new Promise((dismissResolve) => {
                    const tryClick = () => {
                        const dismissBtn = findDismissButton(toast);
                        if (dismissBtn) {
                            if (typeof simulateSafeClick === 'function') {
                                simulateSafeClick(dismissBtn);
                            } else {
                                dismissBtn.click();
                            }
                            console.log('[Flow Automator] Dismiss clicked.');
                            setTimeout(dismissResolve, 600); // allow download trigger
                            return;
                        }

                        if (Date.now() - start > 5000) {
                            console.warn('[Flow Automator] Dismiss button not found on toast; proceeding.');
                            dismissResolve();
                            return;
                        }

                        setTimeout(tryClick, 200);
                    };

                    tryClick();
                });
            };

            const intervalId = setInterval(() => {
                // Find all list items using the data attributes from user example
                const toasts = Array.from(document.querySelectorAll('li[data-sonner-toast]'));

                for (const toast of toasts) {
                    const textContent = (toast.innerText || '').toLowerCase();
                    const normalizedText = textContent.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

                    // Check if this is an ERROR toast
                    if (errorKeywords.some(kw => textContent.includes(kw) || normalizedText.includes(kw))) {
                        console.log('[Flow Automator] Upscale ERROR detected! Skipping to next prompt...');
                        clearInterval(intervalId);

                        // Try to dismiss the error toast
                        const dismissBtn = Array.from(toast.querySelectorAll('button')).find(btn =>
                            btn.textContent.trim().toLowerCase().includes('dispensar') ||
                            btn.textContent.trim().toLowerCase().includes('dismiss')
                        );
                        if (dismissBtn) dismissBtn.click();

                        // Unlock turn and skip
                        automationState.processedThisTurn = false;
                        automationState.waitingForUpscaleToast = false;
                        resolve(false);
                        scheduleNextPrompt();
                        return;
                    }

                    // Check if this is the SUCCESS toast
                    if (successKeywords.some(kw => normalizedText.includes(kw) || textContent.includes(kw))) {
                        console.log('[Flow Automator] Upscale success detected!');
                        clearInterval(intervalId);

                        const finalizeSuccess = async () => {
                            if (mediaType === 'video') {
                                // CRITICAL: Re-send prepareDownload BEFORE the download starts
                                let promptIndex = automationState.currentIndex > 0 ? automationState.currentIndex - 1 : 0;
                                const currentPrompt = automationState.prompts[promptIndex] || 'Unknown Prompt';

                                console.log('[Flow Automator] Re-sending prepareDownload for upscaled video...');
                                await new Promise((done) => {
                                    chrome.runtime.sendMessage({
                                        action: 'prepareDownload',
                                        prompt: currentPrompt,
                                        saveTxt: automationState.settings.saveTxt,
                                        subfolder: automationState.settings.subfolder
                                    }, () => done());
                                    setTimeout(done, 300);
                                });
                            }

                            await clickDismissAndWait(toast);

                            automationState.waitingForUpscaleToast = false;
                            resolve(true);
                            scheduleNextPrompt();
                        };

                        finalizeSuccess();

                        return;
                    }
                }

                if (Date.now() - startTime > maxWaitTime) {
                    console.log('[Flow Automator] Upscale monitoring timeout. Skipping to next...');
                    clearInterval(intervalId);
                    automationState.processedThisTurn = false;
                    automationState.waitingForUpscaleToast = false;
                    resolve(false);
                    scheduleNextPrompt(); // Move on even if timeout
                }
            }, checkInterval);
        });
    }


    // --- Floating UI Logic ---
    let uiTimerInterval = null;
    let uiSeconds = 0;

    const UI_STYLES = `
    #flow-automator-ui {
        position: fixed; bottom: 20px; right: 20px; width: 300px;
        background-color: #1a1b1e; color: #fff; border-radius: 12px;
        font-family: 'Segoe UI', sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        z-index: 99999; border: 1px solid #333; overflow: hidden;
        transition: opacity 0.3s;
    }
    .flow-ui-header {
        background: linear-gradient(90deg, #00C6FF 0%, #0072FF 100%);
        padding: 10px 15px; display: flex; justify-content: space-between; align-items: center;
        font-weight: 700; font-size: 13px;
        transition: background 0.3s;
    }
    .flow-ui-header.success {
        background: linear-gradient(90deg, #00C853 0%, #00E676 100%);
    }
    .flow-ui-header.error {
        background: linear-gradient(90deg, #FF5252 0%, #FF1744 100%);
    }
    .flow-badge { background: rgba(255,255,255,0.2); padding: 2px 8px; border-radius: 10px; font-size: 10px; }
    .flow-badge.success { background: rgba(0,200,83,0.3); }
    .flow-badge.error { background: rgba(255,82,82,0.3); }
    .flow-ui-close { background: none; border: none; color: white; cursor: pointer; font-size: 16px; margin-left: 8px; }
    .flow-ui-body { padding: 15px; }
    .flow-prompt-box {
        background: #25262b; border: 1px solid #373a40; border-radius: 6px; padding: 10px;
        font-size: 12px; color: #c1c2c5; margin-bottom: 12px; max-height: 70px; overflow-y: auto;
    }
    .flow-stats { display: flex; flex-direction: column; gap: 5px; font-size: 12px; margin-bottom: 10px; }
    .flow-stat-row { display: flex; justify-content: space-between; color: #909296; }
    .flow-stat-val { color: #fff; font-weight: 600; }
    .flow-progress-container { height: 4px; background: #373a40; border-radius: 2px; overflow: hidden; }
    .flow-progress-bar { height: 100%; background: #0072FF; width: 0%; transition: width 0.3s; }
    .flow-ui-footer { padding: 8px; background: #141517; text-align: center; font-size: 10px; color: #555; border-top: 1px solid #333; }
    .flow-ui-footer a { color: #00C6FF; text-decoration: none; }
    `;

    function injectFloatingUI() {
        if (document.getElementById('flow-automator-ui')) {
            document.getElementById('flow-automator-ui').style.display = 'block';
            return;
        }

        const style = document.createElement('style');
        style.textContent = UI_STYLES;
        document.head.appendChild(style);

        const container = document.createElement('div');
        container.id = 'flow-automator-ui';
        container.innerHTML = `
            <div class="flow-ui-header">
                <span>FLOW AUTOMATOR</span>
                <div style="display:flex; align-items:center">
                    <span id="flow-status-badge" class="flow-badge">Iniciando</span>
                    <button id="flow-ui-close" class="flow-ui-close">×</button>
                </div>
            </div>
            <div class="flow-ui-body">
                <div id="flow-prompt-text" class="flow-prompt-box">Prepare-se...</div>
                <div class="flow-stats">
                    <div class="flow-stat-row"><span>Progresso</span><span class="flow-stat-val" id="flow-counter">0 / 0</span></div>
                    <div class="flow-stat-row"><span>Tempo</span><span class="flow-stat-val" id="flow-timer">00:00</span></div>
                    <div class="flow-stat-row" id="flow-break-info" style="display: none;">
                        <span style="font-size: 11px; color: #ffcc80;">⏱️</span>
                        <span class="flow-stat-val" id="flow-break-text" style="font-size: 11px; color: #ffcc80;">-</span>
                    </div>
                </div>
                <div class="flow-progress-container"><div id="flow-progress-bar" class="flow-progress-bar"></div></div>
            </div>
            <div class="flow-ui-footer">
                Gosta do projeto? ♥ <a href="https://ko-fi.com/dentparanoide" target="_blank">Me paga um cafezinho</a>
            </div>
        `;
        document.body.appendChild(container);

        document.getElementById('flow-ui-close').addEventListener('click', () => {
            container.style.display = 'none';
        });
    }

    function updateFloatingUI({ status, prompt, progress, total, state }) {
        const ui = document.getElementById('flow-automator-ui');
        if (!ui) return;

        const header = ui.querySelector('.flow-ui-header');
        const badge = document.getElementById('flow-status-badge');

        if (status) badge.textContent = status;
        if (prompt) document.getElementById('flow-prompt-text').textContent = prompt;

        // Apply visual state classes
        if (state) {
            header.classList.remove('success', 'error');
            badge.classList.remove('success', 'error');
            if (state === 'success') {
                header.classList.add('success');
                badge.classList.add('success');
            } else if (state === 'error') {
                header.classList.add('error');
                badge.classList.add('error');
            }
        }

        if (progress !== undefined && total !== undefined) {
            document.getElementById('flow-counter').textContent = `${progress} / ${total}`;
            const pct = Math.round((progress / total) * 100);
            document.getElementById('flow-progress-bar').style.width = `${pct}%`;
        }

        // Update break info
        const breakInfoRow = document.getElementById('flow-break-info');
        const breakText = document.getElementById('flow-break-text');

        if (breakInfoRow && breakText && automationState.settings.breakEnabled && total > automationState.settings.breakPrompts) {
            breakInfoRow.style.display = 'flex';

            if (automationState.isOnBreak && automationState.breakEndTime) {
                // During break: show countdown
                const remainingMs = automationState.breakEndTime - Date.now();
                if (remainingMs > 0) {
                    const remainingMin = Math.ceil(remainingMs / 60000);
                    breakText.textContent = `☕ Pausa: ${remainingMin} min restantes`;
                    breakText.style.color = '#ff9800';
                } else {
                    breakText.textContent = '☕ Retomando...';
                }
            } else {
                // During processing: show prompts until next break
                const promptsUntilBreak = automationState.settings.breakPrompts - automationState.promptsSinceLastBreak;
                breakText.textContent = `Próxima pausa em ${promptsUntilBreak} prompts`;
                breakText.style.color = '#ffcc80';
            }
        } else if (breakInfoRow) {
            breakInfoRow.style.display = 'none';
        }
    }

    function startTimer() {
        // Don't reset if timer is already running - keep accumulating time
        if (uiTimerInterval) {
            console.log('[Flow Automator] Timer already running, continuing...');
            return;
        }

        // Only reset to 0 if starting fresh
        uiSeconds = 0;
        const timerEl = document.getElementById('flow-timer');
        if (timerEl) timerEl.textContent = "00:00";

        uiTimerInterval = setInterval(() => {
            uiSeconds++;
            const mins = Math.floor(uiSeconds / 60).toString().padStart(2, '0');
            const secs = (uiSeconds % 60).toString().padStart(2, '0');
            const el = document.getElementById('flow-timer');
            if (el) el.textContent = `${mins}:${secs}`;
        }, 1000);
    }

    function stopTimer() {
        if (uiTimerInterval) clearInterval(uiTimerInterval);
    }

    function initialize() {
        console.log('[Flow Automator] Initializing...');
        try {
            const observer = new MutationObserver(handleMediaGeneration);
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src']
            });
            // Try to inject UI
            if (typeof injectFloatingUI === 'function') {
                injectFloatingUI();
            }
            sendMessageToBackground({ action: 'contentScriptReady' });
            console.log('[Flow Automator] Initialization complete.');
        } catch (e) {
            console.error('[Flow Automator] CRITICAL INIT ERROR:', e);
        }
    }

    if (document.readyState === 'complete') {
        initialize();
    } else {
        window.addEventListener('load', initialize);
    }
})();
