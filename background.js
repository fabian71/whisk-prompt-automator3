// Background Service Worker para MV3 - Comunicação robusta entre popup e content script
let contentScriptReady = new Map(); // Rastrear quais abas têm content script pronto

// Função para verificar se o content script está pronto
async function isContentScriptReady(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return true;
  } catch (error) {
    return false;
  }
}

// Função para injetar content script se necessário
async function ensureContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url.includes("labs.google")) {
      throw new Error("Não está na página do Google Whisk");
    }

    // Verificar se já está pronto
    if (await isContentScriptReady(tabId)) {
      return true;
    }

    // Tentar injetar o script
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });

    // Aguardar um pouco para o script carregar
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verificar novamente
    return await isContentScriptReady(tabId);
  } catch (error) {
    console.error('Erro ao garantir content script:', error);
    return false;
  }
}

// Função para enviar mensagem com retry
async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Garantir que o content script está pronto
      const isReady = await ensureContentScript(tabId);
      if (!isReady) {
        throw new Error(`Content script não está pronto na aba ${tabId}`);
      }

      // Tentar enviar a mensagem - wrap in promise to handle properly
      return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    } catch (error) {
      console.warn(`Tentativa ${attempt}/${maxRetries} falhou:`, error.message);

      if (attempt === maxRetries) {
        throw error;
      }

      // Aguardar antes da próxima tentativa
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startAutomation") {
    // Handle async operation properly
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTab = tabs[0];

        if (!currentTab || !currentTab.url.includes("labs.google")) {
          throw new Error("Abra a página do Google Whisk primeiro!");
        }

        await sendMessageWithRetry(currentTab.id, {
          action: "startAutomation",
          prompts: request.prompts,
          delay: request.delay,
          settings: request.settings // Forward the settings object
        });

      } catch (error) {
        console.error('Erro ao iniciar automação:', error);
        // Enviar erro de volta para o popup
        chrome.runtime.sendMessage({
          action: 'automationError',
          error: error.message
        }).catch(() => { }); // Ignorar erro se popup não estiver aberto
      }
    })();
    return false; // Don't keep channel open
  }

  if (request.action === "stopAutomation") {
    // Handle async operation properly
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTab = tabs[0];

        if (currentTab && currentTab.url.includes("labs.google")) {
          await sendMessageWithRetry(currentTab.id, {
            action: "stopAutomation"
          });
        }
      } catch (error) {
        console.error('Erro ao parar automação:', error);
      }
    })();
    return false; // Don't keep channel open
  }

  // Ping do content script para confirmar que está pronto
  if (request.action === "contentScriptReady" && sender.tab) {
    contentScriptReady.set(sender.tab.id, true);
  }

  // Repassar mensagens do content script para o popup
  if (request.action === "updateStatus" ||
    request.action === "automationComplete" ||
    request.action === "automationError") {

    // Tentar enviar para o popup (pode não estar aberto)
    chrome.runtime.sendMessage(request).catch(() => {
      // Ignorar erro se popup não estiver aberto
    });
  }

  if (request.action === "downloadImage") {
    chrome.storage.local.get(['autoDownload', 'downloadSubfolder', 'savePromptTxt']).then(settings => {
      if (settings.autoDownload) {
        const subfolder = settings.downloadSubfolder ? settings.downloadSubfolder.trim() : '';

        // Limpa o nome do arquivo para evitar caracteres inválidos
        const safePrompt = request.prompt
          .replace(/[\\/:*?"<>|]/g, '_') // Substitui caracteres inválidos
          .replace(/[^a-zA-Z0-9_\s\-]/g, '') // Remove outros caracteres não comuns
          .trim()
          .substring(0, 100);

        // Gera timestamp único para este download
        const timestamp = Date.now();
        let filename = `${safePrompt}_${timestamp}.png`;

        // Adiciona a subpasta se ela existir
        if (subfolder) {
          // Usa / como separador. O Chrome trata isso corretamente em todos os SOs.
          filename = `${subfolder}/${filename}`;
        }

        // Baixa a imagem
        chrome.downloads.download({
          url: request.url,
          filename: filename
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error(`Falha ao baixar imagem: ${chrome.runtime.lastError.message}`, `Caminho: ${filename}`);
            chrome.runtime.sendMessage({
              action: 'updateStatus',
              message: `Erro ao salvar: ${chrome.runtime.lastError.message.split(': ')[1]}`,
              type: 'error'
            });
          } else {
            // Se a opção de salvar prompt em .txt estiver ativada
            if (settings.savePromptTxt) {
              // Cria arquivo .txt com o mesmo nome
              const txtFilename = filename.replace('.png', '.txt');

              // Converte o prompt para Data URL (compatível com service workers)
              const textContent = request.prompt;
              const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(textContent);

              // Baixa o arquivo .txt
              chrome.downloads.download({
                url: dataUrl,
                filename: txtFilename
              }, (txtDownloadId) => {
                if (chrome.runtime.lastError) {
                  console.error(`Falha ao baixar arquivo .txt: ${chrome.runtime.lastError.message}`);
                } else {
                  console.log(`Arquivo .txt salvo: ${txtFilename}`);
                }
              });
            }
          }
        });
      }
    });
  }

  return false; // Don't keep message channel open
});

// Limpar estado quando aba é fechada
chrome.tabs.onRemoved.addListener((tabId) => {
  contentScriptReady.delete(tabId);
});

// Limpar estado quando aba é atualizada
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    contentScriptReady.delete(tabId);
  }
});

