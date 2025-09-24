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

      // Tentar enviar a mensagem
      await chrome.tabs.sendMessage(tabId, message);
      return true;
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

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === "startAutomation") {
    try {
      const tabs = await chrome.tabs.query({active: true, currentWindow: true});
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
      }).catch(() => {}); // Ignorar erro se popup não estiver aberto
    }
  }
  
  if (request.action === "stopAutomation") {
    try {
      const tabs = await chrome.tabs.query({active: true, currentWindow: true});
      const currentTab = tabs[0];
      
      if (currentTab && currentTab.url.includes("labs.google")) {
        await sendMessageWithRetry(currentTab.id, {
          action: "stopAutomation"
        });
      }
    } catch (error) {
      console.error('Erro ao parar automação:', error);
    }
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
    chrome.storage.local.get(['autoDownload', 'downloadSubfolder']).then(settings => {
        if (settings.autoDownload) {
            const subfolder = settings.downloadSubfolder ? settings.downloadSubfolder.trim() : '';

            // Limpa o nome do arquivo para evitar caracteres inválidos
            const safePrompt = request.prompt
                .replace(/[\\/:*?"<>|]/g, '_') // Substitui caracteres inválidos
                .replace(/[^a-zA-Z0-9_\s\-]/g, '') // Remove outros caracteres não comuns
                .trim()
                .substring(0, 100);
            
            let filename = `${safePrompt}_${Date.now()}.png`;

            // Adiciona a subpasta se ela existir
            if (subfolder) {
                // Usa / como separador. O Chrome trata isso corretamente em todos os SOs.
                filename = `${subfolder}/${filename}`;
            }

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
                }
            });
        }
    });
  }
  
  // Para MV3, retornar true para manter o canal de mensagem aberto
  return true;
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

