// Background Service Worker para MV3 - comunicacao entre popup e content script no Google Flow
const contentScriptReady = new Map();
// Updated to support language codes in URL (e.g., /fx/pt/tools/flow/ or /fx/tools/flow/)
const FLOW_URL_PATTERN = /labs\.google\/fx\/(.*\/)?tools\/flow\/project/;

async function isContentScriptReady(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!FLOW_URL_PATTERN.test(tab.url)) {
      throw new Error("Abra a pagina do Google Flow no projeto correto.");
    }

    if (await isContentScriptReady(tabId)) {
      return true;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });

    await new Promise(resolve => setTimeout(resolve, 1000));
    return await isContentScriptReady(tabId);
  } catch (error) {
    console.error('Erro ao garantir content script:', error);
    return false;
  }
}

async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const isReady = await ensureContentScript(tabId);
      if (!isReady) {
        throw new Error(`Content script nao esta pronto na aba ${tabId}`);
      }

      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (error) {
      console.warn(`Tentativa ${attempt}/${maxRetries} falhou:`, error.message);

      if (attempt === maxRetries) {
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startAutomation") {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];

      if (!currentTab || !FLOW_URL_PATTERN.test(currentTab.url)) {
        throw new Error("Abra a pagina do Google Flow primeiro!");
      }

      sendMessageWithRetry(currentTab.id, {
        action: "startAutomation",
        prompts: request.prompts,
        delay: request.delay,
        settings: request.settings
      });

    } catch (error) {
      console.error('Erro ao iniciar automacao:', error);
      chrome.runtime.sendMessage({
        action: 'automationError',
        error: error.message
      }).catch(() => { });
    }
  }

  if (request.action === "stopAutomation") {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];

      if (currentTab && FLOW_URL_PATTERN.test(currentTab.url)) {
        sendMessageWithRetry(currentTab.id, {
          action: "stopAutomation"
        });
      }
    } catch (error) {
      console.error('Erro ao parar automacao:', error);
    }
  }

  if (request.action === "contentScriptReady" && sender.tab) {
    contentScriptReady.set(sender.tab.id, true);
  }

  if (request.action === "updateStatus" ||
    request.action === "automationComplete" ||
    request.action === "automationError") {
    chrome.runtime.sendMessage(request).catch(() => { });
  }

  if (request.action === "downloadImage") {
    // Direct download request from content script
    handleDirectDownload(request);
  }

  // --- Prepare for download triggered by page click ---
  if (request.action === "prepareDownload") {
    console.log('[Background] Received prepareDownload:', request);

    const safePrompt = (request.prompt || 'video')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[^a-zA-Z0-9_\s-\u00C0-\u00FF]/g, '')
      .trim()
      .substring(0, 100) || 'video';

    const timestamp = Date.now();
    const baseFilename = `${safePrompt}_${timestamp}`;

    // Get subfolder from request
    const subfolder = request.subfolder ? request.subfolder.trim() : '';

    const newMetadata = {
      filenameBase: baseFilename,
      saveTxt: request.saveTxt === true,
      promptContent: request.prompt || '',
      subfolder: subfolder,
      timestamp: Date.now()
    };

    chrome.storage.local.set({ pendingDownloadMetadata: newMetadata }, () => {
      console.log('[Background] Metadata saved to storage:', newMetadata);
      sendResponse({ status: 'prepared', filename: baseFilename });
    });

    return true; // Keep channel open for async response
  }

  return true;
});

// --- Download Handling Logic ---

// let pendingDownloadMetadata = null; // Removed in favor of storage
// let lastMetadataTime = 0; // Removed in favor of storage
let pendingTxtDownload = null; // Track TXT downloads to rename them

function handleDirectDownload(request) {
  chrome.storage.local.get(['autoDownload', 'saveTxt', 'downloadSubfolder']).then(settings => {
    if (!settings.autoDownload) return;

    const subfolder = settings.downloadSubfolder ? settings.downloadSubfolder.trim() : '';
    const originalPrompt = request.prompt || 'video';

    const safePrompt = originalPrompt
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[^a-zA-Z0-9_\s-\u00C0-\u00FF]/g, '')
      .trim()
      .substring(0, 100);

    const timestamp = Date.now();
    const baseFilename = `${safePrompt}_${timestamp}`;
    const extension = request.mediaType === 'video' ? 'mp4' : 'png';

    let filename = `${baseFilename}.${extension}`;
    let txtFilename = `${baseFilename}.txt`;

    if (subfolder) {
      filename = `${subfolder}/${filename}`;
      txtFilename = `${subfolder}/${txtFilename}`;
    }

    // Download the video/image
    chrome.downloads.download({
      url: request.url,
      filename: filename,
      conflictAction: 'uniquify',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(`[Background] Failed to download: ${chrome.runtime.lastError.message}`);
        chrome.runtime.sendMessage({
          action: 'updateStatus',
          message: `Erro ao salvar: ${chrome.runtime.lastError.message}`,
          type: 'error'
        }).catch(() => { });
      } else {
        console.log(`[Background] Download started. ID: ${downloadId}, Path: ${filename}`);

        // Create and download the .txt file (if enabled)
        if (settings.saveTxt) {
          const base64Content = btoa(unescape(encodeURIComponent(originalPrompt)));
          const txtDataUrl = `data:text/plain;base64,${base64Content}`;

          // Register TXT download metadata BEFORE downloading
          pendingTxtDownload = {
            filename: txtFilename,
            timestamp: Date.now()
          };

          chrome.downloads.download({
            url: txtDataUrl,
            filename: txtFilename,
            conflictAction: 'uniquify',
            saveAs: false
          }, (txtDownloadId) => {
            if (chrome.runtime.lastError) {
              console.error(`[Background] Failed to save TXT: ${chrome.runtime.lastError.message}`);
              pendingTxtDownload = null; // Clear on error
            } else {
              console.log(`[Background] TXT download initiated. ID: ${txtDownloadId}, Path: ${txtFilename}`);
              // Don't clear pendingTxtDownload here - let onDeterminingFilename handle it
            }
          });
        }
      }
    });
  });
}

// Listen for downloads initiated by the page (via click)
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  console.log('[Background] ========================================');
  console.log('[Background] Download detected:', downloadItem.filename);

  // Use storage to retrieve metadata
  chrome.storage.local.get(['pendingDownloadMetadata'], (result) => {
    const pendingDownloadMetadata = result.pendingDownloadMetadata;

    console.log('[Background] MIME type:', downloadItem.mime);
    console.log('[Background] URL:', downloadItem.url);
    console.log('[Background] Storage pendingDownloadMetadata:', pendingDownloadMetadata);
    console.log('[Background] ========================================');

    // Check if this is a video download and we have metadata
    // Prioritize file extension over MIME type (Google Flow sometimes returns incorrect MIME types)
    const filename = downloadItem.filename.toLowerCase();
    const isVideo = filename.endsWith('.mp4') ||
      filename.endsWith('.webm') ||
      downloadItem.mime.includes('video');

    // Check if this is an image download
    const isImage = filename.endsWith('.png') ||
      filename.endsWith('.jpg') ||
      filename.endsWith('.jpeg') ||
      filename.endsWith('.webp') ||
      downloadItem.mime.includes('image');

    console.log('[Background] Detection results - isVideo:', isVideo, 'isImage:', isImage);

    // Handle both video and image downloads
    if (pendingDownloadMetadata && (isVideo || isImage)) {
      console.log(`[Background] Detected ${isVideo ? 'VIDEO' : 'IMAGE'} download with metadata`);
      const meta = pendingDownloadMetadata;

      // Check if metadata is still valid (within 60 minutes)
      const now = Date.now();
      if (now - meta.timestamp > 3600000) {
        console.log('[Background] Metadata expired (60m limit), clearing.');
        chrome.storage.local.remove('pendingDownloadMetadata');
        suggest();
        return;
      }

      // Determine file extension
      let extension = 'mp4'; // default for video
      if (isImage) {
        // Try to get extension from original filename or MIME type
        if (downloadItem.filename.toLowerCase().endsWith('.png')) extension = 'png';
        else if (downloadItem.filename.toLowerCase().endsWith('.jpg')) extension = 'jpg';
        else if (downloadItem.filename.toLowerCase().endsWith('.jpeg')) extension = 'jpeg';
        else if (downloadItem.filename.toLowerCase().endsWith('.webp')) extension = 'webp';
        else if (downloadItem.mime.includes('png')) extension = 'png';
        else if (downloadItem.mime.includes('jpeg') || downloadItem.mime.includes('jpg')) extension = 'jpg';
        else if (downloadItem.mime.includes('webp')) extension = 'webp';
        else extension = 'png'; // fallback
      }

      // Build path with subfolder if exists
      let newFilename = `${meta.filenameBase}.${extension}`;
      if (meta.subfolder) {
        newFilename = `${meta.subfolder}/${newFilename}`;
        console.log(`[Background] Using subfolder: ${meta.subfolder}`);
      }

      console.log(`[Background] Renaming ${isVideo ? 'video' : 'image'} download to:`, newFilename);

      // Rename the media file
      suggest({ filename: newFilename, conflictAction: 'uniquify' });

      // Create TXT file if enabled
      if (meta.saveTxt) {
        let txtFilename = `${meta.filenameBase}.txt`;
        if (meta.subfolder) {
          txtFilename = `${meta.subfolder}/${txtFilename}`;
        }

        const base64Content = btoa(unescape(encodeURIComponent(meta.promptContent)));
        const txtDataUrl = `data:text/plain;base64,${base64Content}`;

        // Register TXT download metadata BEFORE downloading
        pendingTxtDownload = {
          filename: txtFilename,
          timestamp: Date.now()
        };

        chrome.downloads.download({
          url: txtDataUrl,
          filename: txtFilename,
          conflictAction: 'uniquify',
          saveAs: false
        }, (txtDownloadId) => {
          if (chrome.runtime.lastError) {
            console.error(`[Background] Failed to save TXT: ${chrome.runtime.lastError.message}`);
            pendingTxtDownload = null; // Clear on error
          } else {
            console.log(`[Background] TXT download initiated. ID: ${txtDownloadId}, Path: ${txtFilename}`);
            // Don't clear pendingTxtDownload here - let onDeterminingFilename handle it
          }
        });
      }

      // DON'T clear metadata here - keep it for potential upscale downloads
      // It will just be overwritten by next prompt or expire
      console.log('[Background] Metadata preserved for potential additional downloads (e.g., upscale)');
      return;
    }

    // Handle TXT file downloads (from data URLs)
    const isTxt = downloadItem.mime === 'text/plain' ||
      downloadItem.mime === 'application/octet-stream' ||
      downloadItem.filename.toLowerCase().endsWith('.txt');

    if (pendingTxtDownload && isTxt) {
      const txtMeta = pendingTxtDownload;

      // Check if metadata is still valid (within 30 seconds - TXT downloads are fast)
      const now = Date.now();
      if (now - txtMeta.timestamp > 30000) {
        console.log('[Background] TXT metadata expired, clearing.');
        pendingTxtDownload = null;
        suggest();
        return;
      }

      console.log('[Background] Renaming TXT download to:', txtMeta.filename);
      suggest({ filename: txtMeta.filename, conflictAction: 'uniquify' });

      // Consume the metadata
      pendingTxtDownload = null;
      return;
    }

    // Not our download, or no metadata set
    console.log('[Background] No special handling for this download.');
    suggest();
  });

  return true; // Return true to indicate async response for suggest()
});

chrome.tabs.onRemoved.addListener((tabId) => {
  contentScriptReady.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    contentScriptReady.delete(tabId);
  }
});
