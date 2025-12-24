
// --- Floating UI Styles & Template ---
const UI_STYLES = `
#flow-automator-ui {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 320px;
    background-color: #1a1b1e;
    color: #ffffff;
    border-radius: 12px;
    font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    z-index: 99999;
    overflow: hidden;
    transition: transform 0.3s ease, opacity 0.3s ease;
    border: 1px solid #333;
}

#flow-automator-ui.minimized {
    transform: translateY(calc(100% + 20px)); /* Hide almost completely */
    opacity: 0; 
    pointer-events: none;
}

.flow-ui-header {
    background: linear-gradient(90deg, #00C6FF 0%, #0072FF 100%);
    padding: 12px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.5px;
}

.flow-badge {
    background: rgba(255,255,255,0.2);
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
}

.flow-ui-close {
    cursor: pointer;
    opacity: 0.8;
    background: none;
    border: none;
    color: white;
    font-size: 16px;
    font-weight: bold;
    padding: 0;
    margin-left: 10px;
}

.flow-ui-close:hover { opacity: 1; }

.flow-ui-body {
    padding: 16px;
}

.flow-prompt-box {
    background-color: #25262b;
    border-radius: 8px;
    padding: 12px;
    font-size: 13px;
    color: #c1c2c5;
    margin-bottom: 12px;
    max-height: 80px;
    overflow-y: auto;
    border: 1px solid #373a40;
    line-height: 1.4;
}

/* Scrollbar for prompt box */
.flow-prompt-box::-webkit-scrollbar { width: 6px; }
.flow-prompt-box::-webkit-scrollbar-track { background: #25262b; }
.flow-prompt-box::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

.flow-stats {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 12px;
}

.flow-stat-row {
    display: flex;
    justify-content: space-between;
}

.flow-progress-container {
    height: 6px;
    background-color: #373a40;
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 12px;
}

.flow-progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #00C6FF 0%, #0072FF 100%);
    width: 0%;
    transition: width 0.3s ease;
    border-radius: 3px;
}

.flow-ui-footer {
    padding: 10px 16px;
    background-color: #141517;
    text-align: center;
    font-size: 11px;
    color: #909296;
    border-top: 1px solid #333;
}

.flow-ui-footer a {
    color: #00C6FF;
    text-decoration: none;
}
`;

function injectFloatingUI() {
    if (document.getElementById('flow-automator-ui')) return;

    // Inject CSS
    const style = document.createElement('style');
    style.textContent = UI_STYLES;
    document.head.appendChild(style);

    // Create Container
    const container = document.createElement('div');
    container.id = 'flow-automator-ui';
    container.innerHTML = `
        <div class="flow-ui-header">
            <span>FLOW AUTOMATOR</span>
            <div style="display:flex; align-items:center;">
                <span id="flow-status-badge" class="flow-badge">Parado</span>
                <button class="flow-ui-close" id="flow-ui-toggle">×</button>
            </div>
        </div>
        <div class="flow-ui-body">
            <div id="flow-prompt-text" class="flow-prompt-box">
                Aguardando início...
            </div>
            
            <div class="flow-stats">
                <div class="flow-stat-row">
                    <span>Progresso</span>
                    <span id="flow-counter">0 de 0</span>
                </div>
                <div class="flow-stat-row">
                    <span>Tempo</span>
                    <span id="flow-timer">00:00</span>
                </div>
            </div>

            <div class="flow-progress-container">
                <div id="flow-progress-bar" class="flow-progress-bar"></div>
            </div>
        </div>
        <div class="flow-ui-footer">
            Gosta do projeto? ♥ <a href="#" target="_blank">Me paga um cafezinho</a>
        </div>
    `;

    document.body.appendChild(container);

    // Toggle behavior (minimize/close logic)
    // For now, close just hides it. Re-opening happens on automation start.
    document.getElementById('flow-ui-toggle').addEventListener('click', () => {
        container.style.display = 'none';
        // Or toggle class minimized
    });
}
