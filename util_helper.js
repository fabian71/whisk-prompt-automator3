function sendMessageToBackground(message) {
    try {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                // console.warn('Runtime error sending message:', chrome.runtime.lastError);
            }
        });
    } catch (e) {
        console.warn('Extension context invalid/disconnected.');
    }
}
