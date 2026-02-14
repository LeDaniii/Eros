/**
 * Demo-App für Eros Charts
 *
 * VORHER: 270 Zeilen Code mit allem durcheinander
 * NACHHER: ~100 Zeilen, nutzt die saubere ErosChart API
 */

import { ErosChart } from './lib/api/ErosChart';

// ==========================================
// GLOBAL STATE
// ==========================================
let chart: ErosChart | null = null;
let isStreaming = false;

// ==========================================
// UI CONTROL PANEL
// ==========================================
function createControlPanel(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.9);
        border: 2px solid #00ff00;
        padding: 20px;
        border-radius: 10px;
        font-family: monospace;
        z-index: 1000;
        min-width: 250px;
    `;

    panel.innerHTML = `
        <div style="margin-bottom: 15px; color: #00ff00; font-weight: bold; font-size: 16px;">
            EROS MEASUREMENT CONTROL
        </div>
        <div style="margin-bottom: 10px;">
            <label style="display: block; margin-bottom: 5px; color: #aaa;">Duration (s):</label>
            <input type="number" id="durationInput" value="30" min="1" max="300"
                   style="width: 100%; padding: 8px; background: #222; color: #0f0; border: 1px solid #0f0; font-family: monospace;">
        </div>
        <div style="margin-bottom: 15px;">
            <label style="display: block; margin-bottom: 5px; color: #aaa;">Sample Rate (Hz):</label>
            <input type="number" id="sampleRateInput" value="10000" step="1000"
                   style="width: 100%; padding: 8px; background: #222; color: #0f0; border: 1px solid #0f0; font-family: monospace;">
        </div>
        <button id="startBtn"
                style="width: 100%; padding: 12px; background: #00ff00; color: black; border: none; cursor: pointer; font-weight: bold; font-size: 14px; border-radius: 5px; margin-bottom: 10px;">
            ▶ START STREAM
        </button>
        <button id="resetZoomBtn"
                style="width: 100%; padding: 8px; background: #444; color: #0f0; border: 1px solid #0f0; cursor: pointer; font-weight: bold; font-size: 12px; border-radius: 5px;">
            ↺ RESET ZOOM
        </button>
        <div id="statsPanel" style="margin-top: 15px; font-size: 11px; color: #0f0; border-top: 1px solid #333; padding-top: 10px;">
            <div id="statusText">Ready | Scroll to zoom, drag to pan</div>
            <div id="dataStats" style="margin-top: 5px; color: #888; font-family: monospace;">
                • Total: 0 samples<br>
                • Visible: 0 samples<br>
                • Buffer: 0 / 0 (0%)
            </div>
        </div>
    `;

    return panel;
}

function updateStatus(message: string): void {
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.textContent = message;
}

function updateDataStats(): void {
    if (!chart) return;

    const stats = chart.getStats();
    const dataStatsEl = document.getElementById('dataStats');

    if (dataStatsEl) {
        const bufferUsage = ((stats.totalSamples / stats.bufferSize) * 100).toFixed(1);
        const zoomFactor = stats.bufferSize > 0
            ? (stats.bufferSize / Math.max(stats.visibleSamples, 1)).toFixed(1)
            : '1.0';

        // Memory Berechnung (Float32 = 4 Bytes pro Sample)
        const totalBytes = stats.totalSamples * 4;
        const bufferBytes = stats.bufferSize * 4;
        const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
        const bufferMB = (bufferBytes / 1024 / 1024).toFixed(2);

        dataStatsEl.innerHTML = `
            • Total: ${stats.totalSamples.toLocaleString()} samples (${totalMB} MB)<br>
            • Visible: ${stats.visibleSamples.toLocaleString()} samples (${zoomFactor}x zoom)<br>
            • Buffer: ${stats.totalSamples.toLocaleString()} / ${stats.bufferSize.toLocaleString()} (${bufferUsage}%)<br>
            • Memory: ${totalMB} / ${bufferMB} MB
        `;
    }
}

// Update Stats alle 200ms
setInterval(() => {
    if (chart) updateDataStats();
}, 200);

// ==========================================
// BUTTON EVENT HANDLERS
// ==========================================
function setupButtonHandlers() {
    const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
    const resetZoomBtn = document.getElementById('resetZoomBtn') as HTMLButtonElement;
    const durationInput = document.getElementById('durationInput') as HTMLInputElement;
    const sampleRateInput = document.getElementById('sampleRateInput') as HTMLInputElement;

    // Start Stream Button
    startBtn.addEventListener('click', async () => {
        if (isStreaming) return;

        const duration = parseFloat(durationInput.value);
        const sampleRate = parseInt(sampleRateInput.value);

        try {
            updateStatus('Creating new chart...');

            // ========== CHART NEU ERSTELLEN ==========
            // Warum? Buffer-Size muss zur Duration passen!
            // Vorher: Fixe 100.000 Samples (nur 10s @ 10kHz)
            // Jetzt: Dynamisch berechnet basierend auf Duration + SampleRate

            if (chart) {
                chart.destroy();  // Alte Instanz aufräumen
            }

            const bufferSize = Math.ceil(duration * sampleRate * 1.1);  // +10% Puffer

            chart = new ErosChart('#plotCanvas', {
                grpcUrl: 'http://localhost:50051',
                bufferSize: bufferSize,
                sampleRate: sampleRate,
                lineColor: '#0080ff'  // Optional: Linienfarbe (default: grün)
                // Andere Beispiele: '#ff0000' (rot), '#0080ff' (blau), '#ffff00' (gelb)
            });

            await chart.initialize();
            updateStatus('Configuring server...');

            // Stream starten
            await chart.startStream({ duration });

            isStreaming = true;
            startBtn.disabled = true;
            startBtn.textContent = '⏸ STREAMING...';
            startBtn.style.background = '#666';
            updateStatus(`Streaming: ${duration}s (${bufferSize.toLocaleString()} samples buffer)`);

            // Auto-Reset nach Stream-Ende
            setTimeout(() => {
                isStreaming = false;
                startBtn.disabled = false;
                startBtn.textContent = '▶ START STREAM';
                startBtn.style.background = '#00ff00';
                updateStatus('Stream completed | Scroll to zoom, drag to pan');
            }, duration * 1000 + 2500);

        } catch (error: any) {
            updateStatus(`Error: ${error.message}`);
            isStreaming = false;
            startBtn.disabled = false;
        }
    });

    // Reset Zoom Button
    resetZoomBtn.addEventListener('click', () => {
        chart?.resetViewport();
        updateStatus('Viewport reset');
    });
}

// ==========================================
// MAIN ENTRY POINT
// ==========================================
async function startApp() {
    try {
        updateStatus('Initializing...');

        // ========== UI SETUP ==========
        // Chart wird erst beim ersten Stream-Start erstellt
        // (damit Buffer-Size zur Duration passt!)
        const controlPanel = createControlPanel();
        document.body.appendChild(controlPanel);
        setupButtonHandlers();

        updateStatus('Ready | Configure duration & sample rate, then click START');

    } catch (error) {
        console.error('Initialization failed:', error);
        updateStatus(`Initialization failed: ${error}`);
    }
}

// ==========================================
// START!
// ==========================================
startApp();
