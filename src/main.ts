/**
 * Demo app for Eros Charts
 */

import { ErosChart } from './lib/api/ErosChart';

// ==========================================
// GLOBAL STATE
// ==========================================
let chart: ErosChart | null = null;
let isStreaming = false;

const DEFAULT_GRPC_URL = 'http://localhost:50051';
const EROS_BINARY_EXTENSION = '.erosb';

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
            START STREAM
        </button>
        <button id="resetZoomBtn"
                style="width: 100%; padding: 8px; background: #444; color: #0f0; border: 1px solid #0f0; cursor: pointer; font-weight: bold; font-size: 12px; border-radius: 5px;">
            RESET ZOOM
        </button>
        <button id="downloadBinaryBtn"
                style="width: 100%; margin-top: 8px; padding: 8px; background: #1f5f1f; color: #d5ffd5; border: 1px solid #0f0; cursor: pointer; font-weight: bold; font-size: 12px; border-radius: 5px;">
            DOWNLOAD .EROSB
        </button>
        <button id="loadBinaryBtn"
                style="width: 100%; margin-top: 8px; padding: 8px; background: #1f3f6f; color: #d5e8ff; border: 1px solid #4aa3ff; cursor: pointer; font-weight: bold; font-size: 12px; border-radius: 5px;">
            LOAD .EROSB
        </button>
        <input id="loadBinaryInput" type="file" accept=".erosb,application/octet-stream" style="display: none;" />
        <div id="statsPanel" style="margin-top: 15px; font-size: 11px; color: #0f0; border-top: 1px solid #333; padding-top: 10px;">
            <div id="statusText">Ready | Scroll to zoom, drag to pan</div>
            <div id="dataStats" style="margin-top: 5px; color: #888; font-family: monospace;">
                - Total: 0 samples<br>
                - Visible: 0 samples<br>
                - Buffer: 0 / 0 (0%)
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

        const totalBytes = stats.totalSamples * 4;
        const bufferBytes = stats.bufferSize * 4;
        const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
        const bufferMB = (bufferBytes / 1024 / 1024).toFixed(2);

        dataStatsEl.innerHTML = `
            - Total: ${stats.totalSamples.toLocaleString()} samples (${totalMB} MB)<br>
            - Visible: ${stats.visibleSamples.toLocaleString()} samples (${zoomFactor}x zoom)<br>
            - Rendered: ${stats.renderedVertices.toLocaleString()} vertices (${stats.isDownsampled ? 'DOWNSAMPLED' : 'EXACT'})<br>
            - Buffer: ${stats.totalSamples.toLocaleString()} / ${stats.bufferSize.toLocaleString()} (${bufferUsage}%)<br>
            - Memory: ${totalMB} / ${bufferMB} MB
        `;
    }
}

async function createOrReplaceChart(sampleRate: number, bufferSize: number): Promise<ErosChart> {
    if (chart) {
        chart.destroy();
    }

    const nextChart = new ErosChart('#plotCanvas', {
        grpcUrl: DEFAULT_GRPC_URL,
        bufferSize,
        sampleRate,
        lineColor: '#0080ff'
    });

    await nextChart.initialize();
    chart = nextChart;
    return nextChart;
}

// Update stats every 200ms
setInterval(() => {
    if (chart) updateDataStats();
}, 200);

// ==========================================
// BUTTON EVENT HANDLERS
// ==========================================
function setupButtonHandlers(): void {
    const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
    const resetZoomBtn = document.getElementById('resetZoomBtn') as HTMLButtonElement;
    const downloadBinaryBtn = document.getElementById('downloadBinaryBtn') as HTMLButtonElement;
    const loadBinaryBtn = document.getElementById('loadBinaryBtn') as HTMLButtonElement;
    const loadBinaryInput = document.getElementById('loadBinaryInput') as HTMLInputElement;
    const durationInput = document.getElementById('durationInput') as HTMLInputElement;
    const sampleRateInput = document.getElementById('sampleRateInput') as HTMLInputElement;

    startBtn.addEventListener('click', async () => {
        if (isStreaming) return;

        const duration = parseFloat(durationInput.value);
        const sampleRate = parseInt(sampleRateInput.value, 10);

        try {
            updateStatus('Creating new chart...');

            const bufferSize = Math.ceil(duration * sampleRate * 1.1);
            const activeChart = await createOrReplaceChart(sampleRate, bufferSize);

            updateStatus('Configuring server...');
            await activeChart.startStream({ duration });

            isStreaming = true;
            startBtn.disabled = true;
            startBtn.textContent = 'STREAMING...';
            startBtn.style.background = '#666';
            updateStatus(`Streaming: ${duration}s (${bufferSize.toLocaleString()} samples buffer)`);

            setTimeout(() => {
                isStreaming = false;
                startBtn.disabled = false;
                startBtn.textContent = 'START STREAM';
                startBtn.style.background = '#00ff00';
                updateStatus('Stream completed | Scroll to zoom, drag to pan');
            }, duration * 1000 + 2500);

        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            updateStatus(`Error: ${message}`);
            isStreaming = false;
            startBtn.disabled = false;
            startBtn.textContent = 'START STREAM';
            startBtn.style.background = '#00ff00';
        }
    });

    resetZoomBtn.addEventListener('click', () => {
        chart?.resetViewport();
        updateStatus('Viewport reset');
    });

    downloadBinaryBtn.addEventListener('click', () => {
        if (!chart) {
            updateStatus('Nothing to export. Start a stream or load a file first.');
            return;
        }

        try {
            const fileBuffer = chart.exportBinary();
            const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const fileName = `eros-curve-${timestamp}${EROS_BINARY_EXTENSION}`;

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);

            updateStatus(`Exported ${fileName}`);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            updateStatus(`Export failed: ${message}`);
        }
    });

    loadBinaryBtn.addEventListener('click', () => {
        loadBinaryInput.click();
    });

    loadBinaryInput.addEventListener('change', async () => {
        const file = loadBinaryInput.files?.[0];
        if (!file) return;

        try {
            updateStatus(`Loading ${file.name}...`);

            const fileBuffer = await file.arrayBuffer();
            const decoded = ErosChart.decodeBinary(fileBuffer);

            const sampleCount = decoded.values.length;
            const bufferSize = Math.max(1024, Math.ceil(sampleCount * 1.1));

            const importedChart = await createOrReplaceChart(decoded.sampleRate, bufferSize);
            importedChart.loadData(decoded.values);

            isStreaming = false;
            startBtn.disabled = false;
            startBtn.textContent = 'START STREAM';
            startBtn.style.background = '#00ff00';

            sampleRateInput.value = String(decoded.sampleRate);

            const durationSeconds = decoded.sampleRate > 0
                ? decoded.values.length / decoded.sampleRate
                : 0;

            updateStatus(
                `Loaded ${sampleCount.toLocaleString()} samples (${durationSeconds.toFixed(2)}s @ ${decoded.sampleRate.toLocaleString()} Hz)`
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            updateStatus(`Load failed: ${message}`);
        } finally {
            loadBinaryInput.value = '';
        }
    });
}

// ==========================================
// MAIN ENTRY POINT
// ==========================================
async function startApp(): Promise<void> {
    try {
        updateStatus('Initializing...');

        const controlPanel = createControlPanel();
        document.body.appendChild(controlPanel);
        setupButtonHandlers();

        updateStatus('Ready | Configure duration & sample rate, then click START');
    } catch (error) {
        console.error('Initialization failed:', error);
        updateStatus(`Initialization failed: ${error}`);
    }
}

startApp();
