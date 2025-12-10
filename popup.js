document.addEventListener('DOMContentLoaded', function () {
    // Set version from manifest
    const manifest = chrome.runtime.getManifest();
    const appTitle = document.getElementById('app-title');
    if (appTitle) {
        appTitle.textContent = `Whisk Automator ${manifest.version}`;
    }

    // --- Element Declarations ---
    const promptsTextarea = document.getElementById('prompts-textarea');
    const delayInput = document.getElementById('delay-input');
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const statusText = document.getElementById('status-text');
    const progressInfo = document.getElementById('progress-info');
    const statusDiv = document.querySelector('.status');

    // Download elements
    const autoDownloadCheckbox = document.getElementById('auto-download-checkbox');
    const downloadSubfolderName = document.getElementById('downloadSubfolderName');
    const saveDownloadFolder = document.getElementById('saveDownloadFolder');
    const downloadFolderStatus = document.getElementById('downloadFolderStatus');
    const imagesPerPromptSelect = document.getElementById('images-per-prompt');
    const savePromptTxtCheckbox = document.getElementById('save-prompt-txt');
    const savePromptTxtSection = document.getElementById('save-prompt-txt-section');

    // --- Randomize Elements ---
    const randomizeToggle = document.getElementById('toggle-randomize');
    const randomizeSection = document.getElementById('randomize-section');
    const randomAllCheckbox = document.getElementById('random-all');
    const randomOptionCheckboxes = document.querySelectorAll('.random-option');

    let isRunning = false;

    // --- Function to sync state with content script ---
    async function checkAutomationState() {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0] && tabs[0].url && tabs[0].url.includes('labs.google')) {
                const response = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getAutomationState' });
                if (response && response.isRunning) {
                    isRunning = true;
                    updateUI();
                    if (response.totalPrompts > 0) {
                        progressInfo.textContent = `Prompt ${response.currentIndex + 1} de ${response.totalPrompts}`;
                    }
                }
            }
        } catch (error) {
            // Content script may not be loaded yet, ignore
            console.log('Não foi possível verificar estado da automação:', error.message);
        }
    }

    // --- Function Definitions ---

    function loadSettings() {
        const keys = [
            'prompts', 'delay', 'autoDownload', 'downloadSubfolder',
            'randomizeToggle', 'randomizeAll', 'randomizeOptions', 'imagesPerPrompt', 'savePromptTxt'
        ];
        chrome.storage.local.get(keys).then((result) => {
            promptsTextarea.value = result.prompts || '';
            delayInput.value = result.delay || 20;
            autoDownloadCheckbox.checked = result.autoDownload || false;
            downloadSubfolderName.value = result.downloadSubfolder || '';
            imagesPerPromptSelect.value = result.imagesPerPrompt || '2';
            savePromptTxtCheckbox.checked = result.savePromptTxt || false;

            if (result.downloadSubfolder) {
                downloadFolderStatus.textContent = `Salvo em: 'Downloads/${result.downloadSubfolder}'`;
            }

            randomizeToggle.checked = result.randomizeToggle || false;
            randomAllCheckbox.checked = result.randomizeAll === undefined ? true : result.randomizeAll;

            if (result.randomizeOptions) {
                randomOptionCheckboxes.forEach(box => {
                    box.checked = result.randomizeOptions[box.id] || false;
                });
            } else {
                randomOptionCheckboxes.forEach(box => { box.checked = true; });
            }

            updateRandomizeUI();
            updateSavePromptTxtVisibility();
        }).catch(error => console.error('Erro ao carregar dados:', error));
    }

    function saveSettings() {
        let randomizeOptions = {};
        randomOptionCheckboxes.forEach(box => {
            randomizeOptions[box.id] = box.checked;
        });

        chrome.storage.local.set({
            prompts: promptsTextarea.value.trim(),
            delay: parseInt(delayInput.value) || 20,
            autoDownload: autoDownloadCheckbox.checked,
            downloadSubfolder: downloadSubfolderName.value.trim(),
            randomizeToggle: randomizeToggle.checked,
            randomizeAll: randomAllCheckbox.checked,
            randomizeOptions: randomizeOptions,
            imagesPerPrompt: parseInt(imagesPerPromptSelect.value) || 2,
            savePromptTxt: savePromptTxtCheckbox.checked
        }).catch(error => console.error('Erro no auto-save:', error));
    }

    function updateRandomizeUI() {
        randomizeSection.style.display = randomizeToggle.checked ? 'block' : 'none';
        const isRandomAll = randomAllCheckbox.checked;
        randomOptionCheckboxes.forEach(box => {
            box.disabled = isRandomAll;
            if (isRandomAll) {
                box.checked = true;
            }
        });
    }

    function updateSavePromptTxtVisibility() {
        savePromptTxtSection.style.display = autoDownloadCheckbox.checked ? 'block' : 'none';
        // Se desmarcar auto-download, também desmarca save-prompt-txt
        if (!autoDownloadCheckbox.checked) {
            savePromptTxtCheckbox.checked = false;
        }
    }

    async function startAutomation() {
        const prompts = promptsTextarea.value.trim();
        if (!prompts) {
            showStatus('Por favor, adicione pelo menos um prompt!', 'error');
            return;
        }

        let ratiosToRandomize = [];
        if (randomizeToggle.checked) {
            if (randomAllCheckbox.checked) {
                randomOptionCheckboxes.forEach(box => ratiosToRandomize.push(box.value));
            } else {
                randomOptionCheckboxes.forEach(box => {
                    if (box.checked) {
                        ratiosToRandomize.push(box.value);
                    }
                });
            }
            if (ratiosToRandomize.length === 0) {
                showStatus('Selecione ao menos uma proporção para randomizar!', 'error');
                return;
            }
        }

        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs[0] || !tabs[0].url.includes('labs.google')) {
                showStatus('Abra a página do Google Whisk primeiro!', 'error');
                return;
            }

            isRunning = true;
            updateUI();

            await chrome.runtime.sendMessage({
                action: 'startAutomation',
                prompts: prompts.split('\n').filter(p => p.trim()),
                delay: parseInt(delayInput.value) || 20,
                settings: {
                    randomize: randomizeToggle.checked,
                    aspectRatios: ratiosToRandomize,
                    imagesPerPrompt: parseInt(imagesPerPromptSelect.value) || 2
                }
            });

            showStatus(`Iniciando automação...`, 'running');
        } catch (error) {
            console.error('Erro ao iniciar automação:', error);
            showStatus(`Erro: ${error.message}`, 'error');
            isRunning = false;
            updateUI();
        }
    }

    async function stopAutomation() {
        try {
            isRunning = false;
            updateUI();
            await chrome.runtime.sendMessage({ action: 'stopAutomation' });
            showStatus('Automação interrompida pelo usuário', 'stopped');
            progressInfo.textContent = '';
        } catch (error) {
            console.error('Erro ao parar automação:', error);
            showStatus('Erro ao parar automação', 'error');
        }
    }

    function saveSubfolder() {
        const subfolder = downloadSubfolderName.value.trim();
        chrome.storage.local.set({ downloadSubfolder: subfolder }).then(() => {
            downloadFolderStatus.textContent = `Salvo! As imagens irão para 'Downloads/${subfolder}'`;
            downloadFolderStatus.style.color = 'green';
            setTimeout(() => {
                downloadFolderStatus.textContent = subfolder ? `Salvo em: 'Downloads/${subfolder}'` : '';
                downloadFolderStatus.style.color = '';
            }, 3000);
        }).catch(error => {
            downloadFolderStatus.textContent = 'Erro ao salvar.';
            downloadFolderStatus.style.color = 'red';
            console.error('Erro ao salvar subpasta:', error);
        });
    }

    function updateUI() {
        const elementsToDisable = [
            startBtn, promptsTextarea, delayInput, autoDownloadCheckbox, downloadSubfolderName,
            saveDownloadFolder, randomizeToggle, randomAllCheckbox, ...randomOptionCheckboxes
        ];
        if (isRunning) {
            elementsToDisable.forEach(el => el.disabled = true);
            stopBtn.disabled = false;
            statusDiv.classList.add('running');
        } else {
            elementsToDisable.forEach(el => el.disabled = false);
            stopBtn.disabled = true;
            statusDiv.classList.remove('running');
            updateRandomizeUI();
        }
    }

    function showStatus(message, type) {
        statusText.textContent = message;
        statusDiv.classList.remove('success', 'error', 'running', 'stopped');
        if (type) {
            statusDiv.classList.add(type);
        }
        if (type === 'success' || type === 'error') {
            setTimeout(() => {
                if (!isRunning) {
                    statusText.textContent = 'Pronto para iniciar';
                    statusDiv.classList.remove(type);
                }
            }, 3000);
        }
    }

    // --- Event Listeners ---
    loadSettings();
    checkAutomationState(); // Check if automation is already running

    // Update save prompt txt visibility on load
    updateSavePromptTxtVisibility();

    startBtn.addEventListener('click', startAutomation);
    stopBtn.addEventListener('click', stopAutomation);
    saveDownloadFolder.addEventListener('click', saveSubfolder);

    const elementsToAutoSave = [
        promptsTextarea, delayInput, autoDownloadCheckbox,
        randomizeToggle, randomAllCheckbox, imagesPerPromptSelect, savePromptTxtCheckbox, ...randomOptionCheckboxes
    ];
    elementsToAutoSave.forEach(el => {
        const eventType = el.type === 'textarea' || el.type === 'number' ? 'input' : 'change';
        el.addEventListener(eventType, saveSettings);
    });

    // Add listener to auto-download checkbox to toggle save-prompt-txt visibility
    autoDownloadCheckbox.addEventListener('change', updateSavePromptTxtVisibility);

    randomizeToggle.addEventListener('change', updateRandomizeUI);
    randomAllCheckbox.addEventListener('change', () => {
        updateRandomizeUI();
    });
    randomOptionCheckboxes.forEach(box => {
        box.addEventListener('change', () => {
            if (box.checked) {
                randomAllCheckbox.checked = false;
            }
            updateRandomizeUI();
        });
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'updateStatus') {
            showStatus(request.message, request.type);
            if (request.progress) {
                progressInfo.textContent = request.progress;
            }
        }
        if (request.action === 'automationComplete') {
            isRunning = false;
            updateUI();
            showStatus('Automação concluída!', 'success');
            progressInfo.textContent = `Todos os ${request.totalPrompts} prompts foram enviados`;
        }
        if (request.action === 'automationError') {
            isRunning = false;
            updateUI();
            showStatus(`Erro: ${request.error}`, 'error');
            progressInfo.textContent = '';
        }
        return true;
    });

    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
        const currentTab = tabs[0];
        if (currentTab && currentTab.url && currentTab.url.includes('labs.google')) {
            showStatus('Conectado à página do Whisk', 'success');
        } else {
            showStatus('Abra a página do Google Whisk para usar', 'error');
        }
    }).catch(error => {
        console.error('Erro ao verificar aba:', error);
    });
});