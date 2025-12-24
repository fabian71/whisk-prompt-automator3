document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const runningControls = document.getElementById('runningControls');
    const pauseBtn = document.getElementById('pauseBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const promptsInput = document.getElementById('prompts');
    const delayInput = document.getElementById('delay');
    const delayLabel = document.getElementById('delayLabel');
    const subfolderInput = document.getElementById('downloadSubfolder');
    const autoDownloadCheckbox = document.getElementById('autoDownload');
    const upscaleCheckbox = document.getElementById('upscaleVideo');
    const saveTxtCheckbox = document.getElementById('saveTxtPrompt');
    const statusDiv = document.getElementById('status');
    const upscaleGroup = document.getElementById('upscaleGroup');
    const generationModeSelect = document.getElementById('generationMode');

    // Break settings elements
    const breakEnabledCheckbox = document.getElementById('breakEnabled');
    const breakSettingsDiv = document.getElementById('breakSettings');
    const breakPromptsInput = document.getElementById('breakPrompts');
    const breakDurationInput = document.getElementById('breakDuration');

    // --- Dynamic Logic ---
    function updateUI() {
        const isVideoMode = generationModeSelect.value === 'TEXT_TO_VIDEO';

        // Show/hide upscale option only for video mode
        if (autoDownloadCheckbox.checked && isVideoMode) {
            upscaleGroup.style.display = 'flex';
            upscaleCheckbox.disabled = false;
        } else {
            upscaleGroup.style.display = 'none';
            upscaleCheckbox.disabled = true;
        }

        // Update Label
        if (autoDownloadCheckbox.checked) {
            delayLabel.textContent = 'Delay após download (segundos):';
        } else {
            delayLabel.textContent = 'Delay após geração (segundos):';
        }
    }

    function updateBreakUI() {
        if (breakEnabledCheckbox.checked) {
            breakSettingsDiv.style.display = 'block';
        } else {
            breakSettingsDiv.style.display = 'none';
        }
    }

    autoDownloadCheckbox.addEventListener('change', updateUI);
    generationModeSelect.addEventListener('change', () => {
        updateUI();
        chrome.storage.local.set({ generationMode: generationModeSelect.value });
    });
    breakEnabledCheckbox.addEventListener('change', () => {
        updateBreakUI();
        saveBreakSettings();
    });
    breakPromptsInput.addEventListener('input', saveBreakSettings);
    breakDurationInput.addEventListener('input', saveBreakSettings);

    function saveBreakSettings() {
        chrome.storage.local.set({
            breakEnabled: breakEnabledCheckbox.checked,
            breakPrompts: parseInt(breakPromptsInput.value) || 15,
            breakDuration: parseInt(breakDurationInput.value) || 3
        });
    }

    // Load saved settings
    chrome.storage.local.get([
        'prompts', 'delay', 'downloadSubfolder', 'autoDownload', 'upscaleVideo', 'saveTxtPrompt',
        'breakEnabled', 'breakPrompts', 'breakDuration', 'generationMode'
    ], (result) => {
        if (result.prompts) promptsInput.value = result.prompts;
        if (result.delay) delayInput.value = result.delay;
        if (result.downloadSubfolder) subfolderInput.value = result.downloadSubfolder;
        if (result.autoDownload !== undefined) autoDownloadCheckbox.checked = result.autoDownload;
        if (result.upscaleVideo !== undefined) upscaleCheckbox.checked = result.upscaleVideo;
        if (result.saveTxtPrompt !== undefined) saveTxtCheckbox.checked = result.saveTxtPrompt;
        if (result.generationMode) generationModeSelect.value = result.generationMode;

        // Load break settings
        if (result.breakEnabled !== undefined) breakEnabledCheckbox.checked = result.breakEnabled;
        if (result.breakPrompts) breakPromptsInput.value = result.breakPrompts;
        if (result.breakDuration) breakDurationInput.value = result.breakDuration;

        updateUI();
        updateBreakUI();
    });

    // Check automation status on open (ask the active tab, not background)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'getStatus' }, (response) => {
                // Ignore errors if content script is not ready
                if (chrome.runtime.lastError) {
                    updateButtons('stopped'); // Assume stopped if content script not ready
                    return;
                }

                if (response && response.isRunning) {
                    updateButtons(response.isPaused ? 'paused' : 'running');
                    updateStatus(response.statusMessage || 'Em execução...', response.statusType);
                } else {
                    updateButtons('stopped');
                }
            });
        }
    });

    // --- Button Listeners ---

    // START
    startBtn.addEventListener('click', () => {
        const prompts = promptsInput.value.split('\n').filter(p => p.trim() !== '');
        if (prompts.length === 0) {
            updateStatus('Adicione pelo menos um prompt!', 'error');
            return;
        }

        const delay = parseInt(delayInput.value, 10);
        if (isNaN(delay) || delay < 1) {
            updateStatus('Delay inválido!', 'error');
            return;
        }

        const settings = {
            subfolder: subfolderInput.value.trim(),
            autoDownload: autoDownloadCheckbox.checked,
            upscale: upscaleCheckbox.checked,
            saveTxt: saveTxtCheckbox.checked,
            aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
            breakEnabled: breakEnabledCheckbox.checked,
            breakPrompts: parseInt(breakPromptsInput.value) || 15,
            breakDuration: parseInt(breakDurationInput.value) || 3,
            generationMode: generationModeSelect.value
        };

        // Save settings
        chrome.storage.local.set({
            prompts: promptsInput.value,
            delay: delay,
            downloadSubfolder: subfolderInput.value.trim(),
            autoDownload: autoDownloadCheckbox.checked,
            upscaleVideo: upscaleCheckbox.checked,
            saveTxtPrompt: saveTxtCheckbox.checked,
            breakEnabled: breakEnabledCheckbox.checked,
            breakPrompts: parseInt(breakPromptsInput.value) || 15,
            breakDuration: parseInt(breakDurationInput.value) || 3,
            generationMode: generationModeSelect.value
        });

        // Send logic to content script
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                const tabId = tabs[0].id;

                chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
                    if (chrome.runtime.lastError) {
                        updateStatus('Erro: Recarregue a página do Flow.', 'error');
                        return;
                    }

                    chrome.tabs.sendMessage(tabId, {
                        action: 'startAutomation',
                        prompts: prompts,
                        delay: delay,
                        settings: settings
                    });

                    updateButtons('running');
                    updateStatus('Iniciando...', 'running');
                });
            }
        });
    });

    // PAUSE
    pauseBtn.addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'pauseAutomation' }, () => {
                    updateButtons('paused');
                });
            }
        });
    });

    // RESUME
    resumeBtn.addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'resumeAutomation' }, () => {
                    updateButtons('running');
                });
            }
        });
    });

    // CANCEL
    cancelBtn.addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'cancelAutomation' }, () => {
                    updateButtons('stopped');
                    updateStatus('Cancelado pelo usuário', 'error');
                });
            }
        });
    });

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'updateStatus') {
            updateStatus(request.message, request.type);
            if (request.type === 'stopped' || request.type === 'completed') {
                updateButtons('stopped');
            }
        }
        if (request.action === 'automationComplete') {
            updateButtons('stopped');
            updateStatus(`Concluído! ${request.totalPrompts} prompts processados.`, 'success');
        }
    });

    function updateButtons(state) {
        // Reset all states first
        startBtn.style.display = 'none';
        runningControls.style.display = 'none';
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
        cancelBtn.style.display = 'none'; // Ensure cancel button is also hidden by default

        // Define common disabled state for inputs
        const disableInputs = (disable) => {
            promptsInput.disabled = disable;
            delayInput.disabled = disable;
            subfolderInput.disabled = disable;
            autoDownloadCheckbox.disabled = disable;
            upscaleCheckbox.disabled = disable;
            saveTxtCheckbox.disabled = disable;
        };

        if (state === 'running') {
            runningControls.style.display = 'flex';
            pauseBtn.style.display = 'block';
            cancelBtn.style.display = 'block';
            disableInputs(true);
        } else if (state === 'paused') {
            runningControls.style.display = 'flex';
            resumeBtn.style.display = 'block';
            cancelBtn.style.display = 'block';
            disableInputs(true); // Keep disabled while paused to ensure state consistency
            updateStatus('Pausado', 'warning');
        } else {
            // Stopped or ready
            startBtn.style.display = 'block';
            disableInputs(false);
            if (autoDownloadCheckbox.checked) updateUI(); // Re-apply UI logic
        }
    }

    function updateStatus(message, type) {
        statusDiv.textContent = message;
        statusDiv.className = 'status ' + (type || '');

        if (type === 'error') statusDiv.style.color = 'red';
        else if (type === 'success') statusDiv.style.color = 'green';
        else if (type === 'running') statusDiv.style.color = '#6200ea';
        else statusDiv.style.color = '#666';
    }
});
