/**
 * Demo app for Eros Charts
 */

import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { ErosChart, type ErosBinaryCurve } from './lib/charts/ErosChart';
import { ErosStripChart } from './lib/charts/ErosStripChart';
import { MeasurementService } from './gen/measurements_pb';

// ==========================================
// GLOBAL STATE
// ==========================================
type DemoDisplayMode = 'analysis' | 'live-strip';
type DemoChart = ErosChart | ErosStripChart;

interface DemoViewportStrategyState {
    displayMode: DemoDisplayMode;
    followLatest: boolean;
    liveWindowDurationSeconds: number;
    isFrozen: boolean;
}

let chart: DemoChart | null = null;
let isStreaming = false;
let currentViewMode: 'idle' | 'live' | 'binary' = 'idle';
let binaryOverlayCharts: ErosChart[] = [];
let binaryOverlayCanvases: HTMLCanvasElement[] = [];
let binaryCompareSyncFrameId: number | null = null;
const booleanStripSamples: number[] = [];

interface ImportedBinaryEntry {
    fileName: string;
    decoded: ErosBinaryCurve;
    fileSizeBytes: number;
    color: string;
    visible: boolean;
}

let importedBinaryEntries: ImportedBinaryEntry[] = [];

const displayModePreferences: {
    mode: DemoDisplayMode;
    liveWindowSeconds: number;
} = {
    mode: 'analysis',
    liveWindowSeconds: 10,
};

const DEFAULT_GRPC_URL = 'http://localhost:50051';
const EROS_BINARY_EXTENSION = '.erosb';
const BOOLEAN_STRIP_SAMPLE_RATE = 60; // lokale Hold-Abtastung für flüssige Bewegung
const BOOLEAN_STRIP_BUFFER_SECONDS = 600; // 10 Minuten Historie
const BOOLEAN_STRIP_BUFFER_SIZE = BOOLEAN_STRIP_SAMPLE_RATE * BOOLEAN_STRIP_BUFFER_SECONDS;
const BOOLEAN_STRIP_LINE_COLOR = '#ffd166';
const BINARY_COMPARE_COLORS = [
    '#00d1ff',
    '#ff6b6b',
    '#ffd166',
    '#06d6a0',
    '#c77dff',
    '#f4a261',
    '#8ecae6',
    '#ff99c8',
];

let booleanStripRpcStreamStarted = false;
let booleanStripHoldSamplerStarted = false;
let booleanStripCurrentValue = false;
let booleanStripHoldLastTickMs: number | null = null;
let booleanStripHoldAccumulatorMs = 0;

function ensureBooleanStripBufferInitialized(): void {
    if (booleanStripSamples.length > 0) {
        return;
    }

    for (let i = 0; i < BOOLEAN_STRIP_BUFFER_SIZE; i++) {
        booleanStripSamples.push(0);
    }
}

function startBooleanStripHoldSampler(): void {
    if (booleanStripHoldSamplerStarted) {
        return;
    }

    booleanStripHoldSamplerStarted = true;
    const samplePeriodMs = 1000 / BOOLEAN_STRIP_SAMPLE_RATE;

    // Zeitbasierter Zero-Order-Hold: verhindert Drift zwischen Datenbewegung und Wall-Clock-Achse.
    const tick = (): void => {
        const nowMs = Date.now();
        if (booleanStripHoldLastTickMs === null) {
            booleanStripHoldLastTickMs = nowMs;
        }

        const deltaMs = Math.max(0, nowMs - booleanStripHoldLastTickMs);
        booleanStripHoldLastTickMs = nowMs;

        // Browser pausiert requestAnimationFrame in Hintergrund-Tabs.
        // Beim Zurückkommen ziehen wir die fehlende Zeit nach, damit der rechte Rand wieder
        // den aktuellen Zustand zeigt. Begrenzung auf Puffergröße vermeidet unnötige Arbeit
        // nach sehr langen Pausen (ältere Daten sind ohnehin aus dem Strip-Buffer gefallen).
        booleanStripHoldAccumulatorMs += deltaMs;
        let samplesToEmit = Math.floor(booleanStripHoldAccumulatorMs / samplePeriodMs);

        if (samplesToEmit > 0) {
            if (samplesToEmit > BOOLEAN_STRIP_BUFFER_SIZE) {
                samplesToEmit = BOOLEAN_STRIP_BUFFER_SIZE;
                booleanStripHoldAccumulatorMs = 0;
            } else {
                booleanStripHoldAccumulatorMs -= samplesToEmit * samplePeriodMs;
            }
            appendBooleanStripSamples(booleanStripCurrentValue, samplesToEmit);
        }

        window.requestAnimationFrame(tick);
    };

    window.requestAnimationFrame(tick);
}

function renderBooleanSamplesOnStripChart(targetChart: ErosStripChart): void {
    ensureBooleanStripBufferInitialized();

    targetChart.loadData(Float32Array.from(booleanStripSamples));
    targetChart.setYRangeOverride(-0.2, 1.2);
}

function appendBooleanStripSamples(value: boolean, sampleCount: number): void {
    if (sampleCount <= 0) {
        return;
    }

    ensureBooleanStripBufferInitialized();

    const normalizedValue = value ? 1 : 0;

    if (sampleCount >= BOOLEAN_STRIP_BUFFER_SIZE) {
        booleanStripSamples.length = 0;
        for (let i = 0; i < BOOLEAN_STRIP_BUFFER_SIZE; i++) {
            booleanStripSamples.push(normalizedValue);
        }
    } else {
        const overflowCount = Math.max(0, booleanStripSamples.length + sampleCount - BOOLEAN_STRIP_BUFFER_SIZE);
        if (overflowCount > 0) {
            booleanStripSamples.splice(0, overflowCount);
        }

        for (let i = 0; i < sampleCount; i++) {
            booleanStripSamples.push(normalizedValue);
        }
    }

    if (currentViewMode !== 'binary' && isStripChartInstance(chart)) {
        renderBooleanSamplesOnStripChart(chart);
    }
}

function startBooleanStripRpcStream(): void {
    startBooleanStripHoldSampler();

    if (booleanStripRpcStreamStarted) return;
    booleanStripRpcStreamStarted = true;

    const transport = createConnectTransport({
        baseUrl: DEFAULT_GRPC_URL,
        useBinaryFormat: true,
    });
    const client = createClient(MeasurementService, transport);

    void (async () => {
        try {
            console.log('[Frontend RPC] Starte Boolean-Status-Stream für StripChart...');

            const response = client.streamBooleanStatus({});
            for await (const tick of response) {
                const numericValue = tick.value ? 1 : 0;
                const timestampMs = Number(tick.timestamp);
                const isoTimestamp = new Date(timestampMs).toISOString();
                booleanStripCurrentValue = tick.value;
                console.log(`[Frontend RPC] Boolean-Status: ${numericValue} (${tick.value}) @ ${isoTimestamp}`);
            }

            console.warn('[Frontend RPC] Boolean-Status-Stream beendet.');
        } catch (error) {
            console.error('[Frontend RPC] Boolean-Status-Stream Fehler:', error);
            booleanStripRpcStreamStarted = false;
        }
    })();
}

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
        <div style="margin-top: 10px; border: 1px solid #2f4f2f; border-radius: 6px; padding: 8px; background: rgba(15, 30, 15, 0.55);">
            <div style="font-size: 11px; color: #9de89d; margin-bottom: 6px; font-weight: bold;">DISPLAY MODE</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                <button id="displayModeAnalysisBtn"
                        style="padding: 6px; background: #0f0; color: #000; border: 1px solid #0f0; cursor: pointer; font-weight: bold; font-size: 11px; border-radius: 4px;">
                    ANALYSIS
                </button>
                <button id="displayModeLiveStripBtn"
                        style="padding: 6px; background: #1f1f1f; color: #c8ffc8; border: 1px solid #3f6f3f; cursor: pointer; font-weight: bold; font-size: 11px; border-radius: 4px;">
                    LIVE STRIP
                </button>
            </div>
            <div style="display:flex; gap:6px; margin-top:6px; align-items:center;">
                <label for="liveWindowSelect" style="font-size:10px; color:#9fb79f;">Window</label>
                <select id="liveWindowSelect"
                        style="flex:1; min-width:0; padding:4px; background:#182218; color:#d7ffd7; border:1px solid #2f5f2f; font-family:monospace; font-size:11px;">
                    <option value="5">5s</option>
                    <option value="10" selected>10s</option>
                    <option value="30">30s</option>
                </select>
                <button id="liveFreezeBtn"
                        style="padding:4px 8px; background:#222; color:#888; border:1px solid #444; cursor:pointer; font-weight:bold; font-size:10px; border-radius:4px;">
                    FREEZE
                </button>
            </div>
            <div id="liveModeInfo" style="margin-top: 6px; font-size: 10px; color: #83a383; line-height: 1.2;">
                Mode: no chart
            </div>
        </div>
        <button id="downloadBinaryBtn"
                style="width: 100%; margin-top: 8px; padding: 8px; background: #1f5f1f; color: #d5ffd5; border: 1px solid #0f0; cursor: pointer; font-weight: bold; font-size: 12px; border-radius: 5px;">
            DOWNLOAD .EROSB
        </button>
        <button id="loadBinaryBtn"
                style="width: 100%; margin-top: 8px; padding: 8px; background: #1f3f6f; color: #d5e8ff; border: 1px solid #4aa3ff; cursor: pointer; font-weight: bold; font-size: 12px; border-radius: 5px;">
            LOAD .EROSB
        </button>
        <input id="loadBinaryInput" type="file" accept=".erosb,application/octet-stream" multiple style="display: none;" />
        <div id="binaryBrowserPanel" style="display: none; margin-top: 10px; border: 1px solid #2d4f7a; border-radius: 6px; padding: 8px; background: rgba(20, 35, 55, 0.7);">
            <div id="binaryBrowserTitle" style="font-size: 11px; color: #8cc4ff; margin-bottom: 6px; font-weight: bold;">
                BINARY FILE BROWSER
            </div>
            <div style="display: flex; gap: 6px; align-items: center;">
                <button id="binaryPrevBtn"
                        style="padding: 4px 8px; background: #1b2f47; color: #cfe7ff; border: 1px solid #4aa3ff; cursor: pointer; border-radius: 4px;">◀</button>
                <select id="binaryFileSelect"
                        style="flex: 1; min-width: 0; padding: 5px; background: #0f1b29; color: #cfe7ff; border: 1px solid #4aa3ff; font-family: monospace; font-size: 11px;">
                </select>
                <button id="binaryNextBtn"
                        style="padding: 4px 8px; background: #1b2f47; color: #cfe7ff; border: 1px solid #4aa3ff; cursor: pointer; border-radius: 4px;">▶</button>
            </div>
            <div id="binaryBrowserInfo" style="margin-top: 6px; font-size: 10px; color: #9fb7d1; line-height: 1.3;">
            </div>
        </div>
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

function isStripChartInstance(value: DemoChart | null): value is ErosStripChart {
    return value instanceof ErosStripChart;
}

function getViewportStrategyStateForUi(): DemoViewportStrategyState {
    if (isStripChartInstance(chart)) {
        return chart.getViewportStrategyState();
    }

    return {
        displayMode: 'analysis',
        followLatest: false,
        liveWindowDurationSeconds: displayModePreferences.liveWindowSeconds,
        isFrozen: false,
    };
}

function applyDisplayModePreferencesToChart(targetChart: DemoChart): void {
    if (!isStripChartInstance(targetChart)) {
        return;
    }

    targetChart.setLiveWindowDuration(displayModePreferences.liveWindowSeconds);
    targetChart.resumeFollowLatest();
}

function refreshDisplayModeControls(): void {
    const analysisBtn = document.getElementById('displayModeAnalysisBtn') as HTMLButtonElement | null;
    const liveStripBtn = document.getElementById('displayModeLiveStripBtn') as HTMLButtonElement | null;
    const liveWindowSelect = document.getElementById('liveWindowSelect') as HTMLSelectElement | null;
    const freezeBtn = document.getElementById('liveFreezeBtn') as HTMLButtonElement | null;
    const strategyInfo = document.getElementById('liveModeInfo') as HTMLDivElement | null;

    if (!analysisBtn || !liveStripBtn || !liveWindowSelect || !freezeBtn || !strategyInfo) {
        return;
    }

    const hasChart = chart !== null;
    const strategyState = chart ? getViewportStrategyStateForUi() : {
        displayMode: displayModePreferences.mode,
        followLatest: false,
        liveWindowDurationSeconds: displayModePreferences.liveWindowSeconds,
        isFrozen: false,
    };

    liveWindowSelect.value = String(displayModePreferences.liveWindowSeconds);

    const setModeButtonStyle = (btn: HTMLButtonElement, active: boolean): void => {
        btn.style.background = active ? '#0f0' : '#1f1f1f';
        btn.style.color = active ? '#000' : '#c8ffc8';
        btn.style.borderColor = active ? '#0f0' : '#3f6f3f';
    };

    setModeButtonStyle(analysisBtn, strategyState.displayMode === 'analysis');
    setModeButtonStyle(liveStripBtn, strategyState.displayMode === 'live-strip');

    analysisBtn.disabled = !hasChart;
    // Live strip can initialize a chart on demand (pre-stream), so keep it clickable.
    liveStripBtn.disabled = false;
    liveWindowSelect.disabled = hasChart && strategyState.displayMode === 'live-strip';

    const liveStripActive = hasChart && strategyState.displayMode === 'live-strip';
    freezeBtn.disabled = !liveStripActive;
    freezeBtn.textContent = liveStripActive && strategyState.isFrozen ? 'RESUME FOLLOW' : 'FREEZE';
    freezeBtn.style.background = liveStripActive
        ? (strategyState.isFrozen ? '#1f5f1f' : '#4f2f1f')
        : '#222';
    freezeBtn.style.color = liveStripActive
        ? (strategyState.isFrozen ? '#d5ffd5' : '#ffd9c7')
        : '#888';
    freezeBtn.style.borderColor = liveStripActive
        ? (strategyState.isFrozen ? '#0f0' : '#ff9d6b')
        : '#444';

    strategyInfo.textContent = hasChart
        ? `Mode: ${strategyState.displayMode} | Follow: ${strategyState.followLatest ? 'on' : 'off'} | Window: ${strategyState.liveWindowDurationSeconds}s`
        : 'Mode: no chart';
}

async function createOrReplaceAnalysisChart(sampleRate: number, bufferSize: number): Promise<ErosChart> {
    destroyBinaryOverlayCharts();

    const baseCanvas = document.getElementById('plotCanvas');
    if (baseCanvas instanceof HTMLCanvasElement) {
        baseCanvas.style.opacity = '1';
    }

    if (chart) {
        chart.setViewportChangeListener(null);
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
    refreshDisplayModeControls();
    return nextChart;
}

async function createOrReplaceStripChart(_sampleRate: number, _bufferSize: number): Promise<ErosStripChart> {
    destroyBinaryOverlayCharts();

    const baseCanvas = document.getElementById('plotCanvas');
    if (baseCanvas instanceof HTMLCanvasElement) {
        baseCanvas.style.opacity = '1';
    }

    if (chart) {
        chart.setViewportChangeListener(null);
        chart.destroy();
    }

    const nextChart = new ErosStripChart('#plotCanvas', {
        grpcUrl: DEFAULT_GRPC_URL,
        bufferSize: BOOLEAN_STRIP_BUFFER_SIZE,
        sampleRate: BOOLEAN_STRIP_SAMPLE_RATE,
        lineColor: BOOLEAN_STRIP_LINE_COLOR,
        liveWindowDurationSeconds: displayModePreferences.liveWindowSeconds,
        enableWorker: false,
    });

    await nextChart.initialize();
    applyDisplayModePreferencesToChart(nextChart);
    nextChart.setYRangeOverride(-0.2, 1.2);
    renderBooleanSamplesOnStripChart(nextChart);
    chart = nextChart;
    refreshDisplayModeControls();
    return nextChart;
}

async function createOrReplaceStreamingChart(sampleRate: number, bufferSize: number): Promise<DemoChart> {
    if (displayModePreferences.mode === 'live-strip') {
        return createOrReplaceStripChart(sampleRate, bufferSize);
    }

    return createOrReplaceAnalysisChart(sampleRate, bufferSize);
}

function destroyBinaryOverlayCharts(): void {
    if (binaryCompareSyncFrameId !== null) {
        cancelAnimationFrame(binaryCompareSyncFrameId);
        binaryCompareSyncFrameId = null;
    }

    for (const overlayChart of binaryOverlayCharts) {
        overlayChart.setViewportChangeListener(null);
        overlayChart.destroy();
    }
    binaryOverlayCharts = [];

    for (const overlayCanvas of binaryOverlayCanvases) {
        overlayCanvas.remove();
    }
    binaryOverlayCanvases = [];
}

function getPlotContainer(): HTMLDivElement {
    const container = document.getElementById('canvas-container');
    if (!(container instanceof HTMLDivElement)) {
        throw new Error('Canvas container not found.');
    }
    return container;
}

function createBinaryOverlayCanvas(_zIndex: number): HTMLCanvasElement {
    const container = getPlotContainer();
    const canvas = document.createElement('canvas');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '1';
    canvas.dataset.role = 'binary-overlay';
    container.appendChild(canvas);
    return canvas;
}

function formatBinaryDuration(seconds: number): string {
    if (!Number.isFinite(seconds)) return '0s';
    if (seconds >= 10) return `${seconds.toFixed(2)}s`;
    if (seconds >= 1) return `${seconds.toFixed(3)}s`;
    return `${seconds.toFixed(4)}s`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getBinaryCurveColor(index: number): string {
    return BINARY_COMPARE_COLORS[index % BINARY_COMPARE_COLORS.length];
}

function applyBinaryCurveStyles(): void {
    const primaryCanvas = document.getElementById('plotCanvas');
    if (primaryCanvas instanceof HTMLCanvasElement) {
        const primaryEntry = importedBinaryEntries[0];
        primaryCanvas.style.opacity = primaryEntry?.visible === false ? '0' : '1';
    }

    if (chart && importedBinaryEntries[0]) {
        chart.setLineColor(importedBinaryEntries[0].color);
    }

    for (let i = 0; i < binaryOverlayCharts.length; i++) {
        const entry = importedBinaryEntries[i + 1];
        if (!entry) {
            continue;
        }

        binaryOverlayCharts[i].setLineColor(entry.color);

        const overlayCanvas = binaryOverlayCanvases[i];
        if (overlayCanvas) {
            overlayCanvas.style.opacity = entry.visible ? '1' : '0';
        }
    }

    updateBinaryCrosshairSnapSeries();
}

function updateBinaryCrosshairSnapSeries(): void {
    if (!chart || currentViewMode !== 'binary' || importedBinaryEntries.length === 0) {
        return;
    }

    chart.setCrosshairSnapSeries(
        importedBinaryEntries.map((entry) => ({
            values: entry.decoded.values,
            visible: entry.visible,
            color: entry.color,
        }))
    );
}

function computeSharedBinaryYRange(startIndex: number, endIndex: number): { min: number; max: number } | null {
    if (importedBinaryEntries.length === 0) {
        return null;
    }

    let minValue = Infinity;
    let maxValue = -Infinity;

    for (const entry of importedBinaryEntries) {
        if (!entry.visible) {
            continue;
        }

        const values = entry.decoded.values;
        if (values.length < 1) {
            continue;
        }

        if (startIndex >= values.length || endIndex <= 0) {
            continue;
        }

        const start = Math.max(0, Math.min(values.length - 1, Math.floor(startIndex)));
        const end = Math.max(start + 1, Math.min(values.length, Math.ceil(endIndex)));

        for (let i = start; i < end; i++) {
            const value = values[i];
            if (value < minValue) minValue = value;
            if (value > maxValue) maxValue = value;
        }
    }

    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
        return null;
    }

    if (minValue === maxValue) {
        return { min: minValue - 0.5, max: maxValue + 0.5 };
    }

    const padding = (maxValue - minValue) * 0.05;
    return {
        min: minValue - padding,
        max: maxValue + padding,
    };
}

function syncBinaryCompareCharts(): void {
    binaryCompareSyncFrameId = null;

    if (currentViewMode !== 'binary' || !chart) {
        return;
    }

    const { startIndex, endIndex } = chart.getViewportRange();
    for (const overlayChart of binaryOverlayCharts) {
        overlayChart.setViewport(startIndex, endIndex);
    }

    const sharedRange = computeSharedBinaryYRange(startIndex, endIndex);
    if (!sharedRange) {
        chart.clearYRangeOverride();
        for (const overlayChart of binaryOverlayCharts) {
            overlayChart.clearYRangeOverride();
        }
        return;
    }

    chart.setYRangeOverride(sharedRange.min, sharedRange.max);
    for (const overlayChart of binaryOverlayCharts) {
        overlayChart.setYRangeOverride(sharedRange.min, sharedRange.max);
    }
}

function scheduleBinaryCompareSync(): void {
    if (binaryCompareSyncFrameId !== null) {
        return;
    }
    binaryCompareSyncFrameId = requestAnimationFrame(syncBinaryCompareCharts);
}

async function createOrReplaceBinaryCompareCharts(entries: ImportedBinaryEntry[]): Promise<void> {
    destroyBinaryOverlayCharts();

    if (chart) {
        chart.setViewportChangeListener(null);
        chart.destroy();
        chart = null;
    }

    if (entries.length === 0) {
        throw new Error('No binary curves to render.');
    }

    const sampleRate = entries[0].decoded.sampleRate;
    const maxSamples = entries.reduce((max, entry) => Math.max(max, entry.decoded.values.length), 0);
    const bufferSize = Math.max(1024, Math.ceil(maxSamples * 1.1));

    const primaryChart = new ErosChart('#plotCanvas', {
        grpcUrl: DEFAULT_GRPC_URL,
        bufferSize,
        sampleRate,
        lineColor: entries[0].color,
        enableWorker: false,
    });
    await primaryChart.initialize();
    primaryChart.loadData(entries[0].decoded.values);
    applyDisplayModePreferencesToChart(primaryChart);
    primaryChart.setViewportChangeListener(() => {
        scheduleBinaryCompareSync();
    });

    chart = primaryChart;

    for (let i = 1; i < entries.length; i++) {
        const overlayCanvas = createBinaryOverlayCanvas(i);
        const overlayChart = new ErosChart(overlayCanvas, {
            grpcUrl: DEFAULT_GRPC_URL,
            bufferSize,
            sampleRate,
            lineColor: entries[i].color,
            showGrid: false,
            showCrosshair: false,
            enableInteractions: false,
            enableWorker: false,
            transparentBackground: true,
        });

        await overlayChart.initialize();
        overlayChart.loadData(entries[i].decoded.values);

        binaryOverlayCanvases.push(overlayCanvas);
        binaryOverlayCharts.push(overlayChart);
    }

    applyBinaryCurveStyles();
    scheduleBinaryCompareSync();
    refreshDisplayModeControls();
}

// Update stats every 200ms
setInterval(() => {
    if (chart) updateDataStats();
    refreshDisplayModeControls();
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
    const binaryBrowserPanel = document.getElementById('binaryBrowserPanel') as HTMLDivElement;
    const binaryBrowserTitle = document.getElementById('binaryBrowserTitle') as HTMLDivElement;
    const binaryBrowserInfo = document.getElementById('binaryBrowserInfo') as HTMLDivElement;
    const binaryPrevBtn = document.getElementById('binaryPrevBtn') as HTMLButtonElement;
    const binaryNextBtn = document.getElementById('binaryNextBtn') as HTMLButtonElement;
    const binaryFileSelect = document.getElementById('binaryFileSelect') as HTMLSelectElement;
    const durationInput = document.getElementById('durationInput') as HTMLInputElement;
    const sampleRateInput = document.getElementById('sampleRateInput') as HTMLInputElement;
    const displayModeAnalysisBtn = document.getElementById('displayModeAnalysisBtn') as HTMLButtonElement;
    const displayModeLiveStripBtn = document.getElementById('displayModeLiveStripBtn') as HTMLButtonElement;
    const liveWindowSelect = document.getElementById('liveWindowSelect') as HTMLSelectElement;
    const liveFreezeBtn = document.getElementById('liveFreezeBtn') as HTMLButtonElement;

    const resetStartButtonState = (): void => {
        startBtn.disabled = false;
        startBtn.textContent = 'START STREAM';
        startBtn.style.background = '#00ff00';
    };

    const renderBinaryBrowser = (): void => {
        const showBinaryBrowser = currentViewMode === 'binary' && importedBinaryEntries.length > 0;
        binaryBrowserPanel.style.display = showBinaryBrowser ? 'block' : 'none';
        binaryPrevBtn.style.display = 'none';
        binaryNextBtn.style.display = 'none';
        binaryFileSelect.style.display = 'none';

        if (!showBinaryBrowser) {
            return;
        }

        const sampleRate = importedBinaryEntries[0]?.decoded.sampleRate ?? 0;
        const maxSamples = importedBinaryEntries.reduce((max, entry) => Math.max(max, entry.decoded.values.length), 0);
        const maxDuration = sampleRate > 0 ? maxSamples / sampleRate : 0;
        const visibleCount = importedBinaryEntries.filter((entry) => entry.visible).length;
        binaryBrowserTitle.textContent = `BINARY OVERLAY (${visibleCount}/${importedBinaryEntries.length} visible)`;
        binaryBrowserInfo.innerHTML = `
            <div style="margin-bottom: 4px;">Shared X-axis: ${sampleRate.toLocaleString()} Hz | Window up to ${formatBinaryDuration(maxDuration)}</div>
            ${importedBinaryEntries.map((entry, index) => {
                const sampleCount = entry.decoded.values.length;
                const duration = entry.decoded.sampleRate > 0 ? sampleCount / entry.decoded.sampleRate : 0;
                const sizeKb = entry.fileSizeBytes / 1024;
                const safeFileName = escapeHtml(entry.fileName);
                const rowOpacity = entry.visible ? 1 : 0.55;
                return `<div style="display:flex; align-items:center; gap:6px; margin-top:4px; opacity:${rowOpacity};">
                    <input type="checkbox" data-curve-index="${index}" data-curve-action="visible" ${entry.visible ? 'checked' : ''}
                           title="Show/hide curve" style="margin:0; accent-color:${entry.color}; cursor:pointer;" />
                    <input type="color" data-curve-index="${index}" data-curve-action="color" value="${entry.color}"
                           title="Curve color" style="width:22px; height:16px; padding:0; border:none; background:transparent; cursor:pointer;" />
                    <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${entry.color}; box-shadow:0 0 6px ${entry.color};"></span>
                    <span title="${safeFileName}" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${index + 1}. ${safeFileName}</span>
                    <span style="color:#9fb7d1;">${formatBinaryDuration(duration)} | ${sizeKb.toFixed(1)} KB</span>
                </div>`;
            }).join('')}
        `;
    };

    const setViewMode = (mode: 'idle' | 'live' | 'binary'): void => {
        currentViewMode = mode;
        renderBinaryBrowser();
    };

    const handleBinaryCurveControlChange = (target: EventTarget | null, rerenderUi: boolean): void => {
        if (!(target instanceof HTMLInputElement)) {
            return;
        }

        const action = target.dataset.curveAction;
        if (!action) {
            return;
        }

        const index = Number.parseInt(target.dataset.curveIndex ?? '', 10);
        if (!Number.isFinite(index) || index < 0 || index >= importedBinaryEntries.length) {
            return;
        }

        const entry = importedBinaryEntries[index];
        if (!entry) {
            return;
        }

        if (action === 'visible' && target.type === 'checkbox') {
            entry.visible = target.checked;
            applyBinaryCurveStyles();
            scheduleBinaryCompareSync();
            renderBinaryBrowser();
            return;
        }

        if (action === 'color' && target.type === 'color') {
            entry.color = target.value;
            applyBinaryCurveStyles();
            if (rerenderUi) {
                renderBinaryBrowser();
            }
        }
    };

    binaryBrowserInfo.addEventListener('change', (event) => {
        handleBinaryCurveControlChange(event.target, true);
    });

    binaryBrowserInfo.addEventListener('input', (event) => {
        handleBinaryCurveControlChange(event.target, false);
    });

    displayModeAnalysisBtn.addEventListener('click', async () => {
        displayModePreferences.mode = 'analysis';

        if (isStripChartInstance(chart)) {
            try {
                const duration = Math.max(1, Number.parseFloat(durationInput.value) || 30);
                const sampleRate = Math.max(1, Number.parseInt(sampleRateInput.value, 10) || 10_000);
                const bufferSize = Math.ceil(duration * sampleRate * 1.1);

                updateStatus('Creating analysis chart...');
                await createOrReplaceAnalysisChart(sampleRate, bufferSize);
                setViewMode('live');
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                updateStatus(`Analysis chart init failed: ${message}`);
                refreshDisplayModeControls();
                return;
            }
        }

        refreshDisplayModeControls();
        if (chart) {
            updateStatus('Display mode: analysis');
        }
    });

    displayModeLiveStripBtn.addEventListener('click', async () => {
        const selectedWindow = Number.parseFloat(liveWindowSelect.value);
        if (Number.isFinite(selectedWindow) && selectedWindow > 0) {
            displayModePreferences.liveWindowSeconds = selectedWindow;
        }
        displayModePreferences.mode = 'live-strip';

        if (!chart || !isStripChartInstance(chart)) {
            try {
                const duration = Math.max(1, Number.parseFloat(durationInput.value) || 30);
                const sampleRate = Math.max(1, Number.parseInt(sampleRateInput.value, 10) || 10_000);
                const bufferSize = Math.ceil(duration * sampleRate * 1.1);

                updateStatus('Creating live strip chart...');
                await createOrReplaceStripChart(sampleRate, bufferSize);
                startBooleanStripRpcStream();
                setViewMode('live');
                if (isStripChartInstance(chart)) {
                    renderBooleanSamplesOnStripChart(chart);
                }
                updateStatus(`Live strip zeigt Boolean-RPC (${displayModePreferences.liveWindowSeconds}s window)`);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                updateStatus(`Live strip init failed: ${message}`);
                refreshDisplayModeControls();
                return;
            }
        }

        if (isStripChartInstance(chart)) {
            startBooleanStripRpcStream();
            renderBooleanSamplesOnStripChart(chart);
            chart.setLiveWindowDuration(displayModePreferences.liveWindowSeconds);
            chart.resumeFollowLatest();
            updateStatus(`Display mode: live strip (Boolean-RPC, ${displayModePreferences.liveWindowSeconds}s window)`);
        }
        refreshDisplayModeControls();
    });

    liveWindowSelect.addEventListener('change', () => {
        const selectedWindow = Number.parseFloat(liveWindowSelect.value);
        if (!Number.isFinite(selectedWindow) || selectedWindow <= 0) {
            liveWindowSelect.value = String(displayModePreferences.liveWindowSeconds);
            return;
        }

        displayModePreferences.liveWindowSeconds = selectedWindow;
        if (isStripChartInstance(chart)) {
            chart.setLiveWindowDuration(selectedWindow);
            const strategy = chart.getViewportStrategyState();
            if (strategy.followLatest && !strategy.isFrozen) {
                chart.resumeFollowLatest();
            }
            updateStatus(`Live strip window fixed at ${strategy.liveWindowDurationSeconds}s`);
        }
        refreshDisplayModeControls();
    });

    liveFreezeBtn.addEventListener('click', () => {
        if (!isStripChartInstance(chart)) {
            return;
        }

        const strategy = chart.getViewportStrategyState();
        if (strategy.isFrozen) {
            chart.resumeFollowLatest();
            updateStatus('Live strip follow resumed');
        } else {
            chart.freeze();
            updateStatus('Live strip frozen');
        }
        refreshDisplayModeControls();
    });


    startBtn.addEventListener('click', async () => {
        if (isStreaming) return;

        const duration = parseFloat(durationInput.value);
        const sampleRate = parseInt(sampleRateInput.value, 10);

        try {
            if (displayModePreferences.mode === 'live-strip') {
                updateStatus('Opening strip chart (Boolean-RPC)...');
                const activeChart = await createOrReplaceStripChart(sampleRate, Math.ceil(duration * sampleRate * 1.1));
                startBooleanStripRpcStream();
                renderBooleanSamplesOnStripChart(activeChart);
                setViewMode('live');
                updateStatus('Strip chart zeigt Boolean-RPC automatisch (kein START nötig).');
                return;
            }

            updateStatus('Creating new chart...');

            const bufferSize = Math.ceil(duration * sampleRate * 1.1);
            const activeChart = await createOrReplaceStreamingChart(sampleRate, bufferSize);

            updateStatus('Configuring server...');
            await activeChart.startStream({ duration });

            isStreaming = true;
            setViewMode('live');
            startBtn.disabled = true;
            startBtn.textContent = 'STREAMING...';
            startBtn.style.background = '#666';
            updateStatus(`Streaming: ${duration}s (${bufferSize.toLocaleString()} samples buffer)`);

            setTimeout(() => {
                isStreaming = false;
                resetStartButtonState();
                updateStatus('Stream completed | Scroll to zoom, drag to pan');
            }, duration * 1000 + 2500);

        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            updateStatus(`Error: ${message}`);
            isStreaming = false;
            resetStartButtonState();
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
        const files = Array.from(loadBinaryInput.files ?? []);
        if (files.length === 0) return;

        try {
            updateStatus(
                files.length === 1
                    ? `Loading ${files[0].name}...`
                    : `Loading ${files.length} binary files...`
            );

            const loadedEntries: ImportedBinaryEntry[] = [];
            const failedFiles: string[] = [];

            for (const file of files) {
                try {
                    const fileBuffer = await file.arrayBuffer();
                    const decoded = ErosChart.decodeBinary(fileBuffer);
                    loadedEntries.push({
                        fileName: file.name,
                        decoded,
                        fileSizeBytes: file.size,
                        color: '#00d1ff',
                        visible: true,
                    });
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    failedFiles.push(`${file.name} (${message})`);
                }
            }

            if (loadedEntries.length === 0) {
                throw new Error(failedFiles[0] ?? 'No valid .erosb files selected.');
            }

            const referenceSampleRate = loadedEntries[0].decoded.sampleRate;
            const compatibleEntries: ImportedBinaryEntry[] = [];

            for (const entry of loadedEntries) {
                if (entry.decoded.sampleRate !== referenceSampleRate) {
                    failedFiles.push(
                        `${entry.fileName} (sample rate ${entry.decoded.sampleRate} Hz does not match ${referenceSampleRate} Hz)`
                    );
                    continue;
                }
                compatibleEntries.push(entry);
            }

            if (compatibleEntries.length === 0) {
                throw new Error('No compatible binary files share the same sample rate.');
            }

            importedBinaryEntries = compatibleEntries.map((entry, index) => ({
                ...entry,
                color: getBinaryCurveColor(index),
                visible: true,
            }));
            setViewMode('binary');

            await createOrReplaceBinaryCompareCharts(importedBinaryEntries);
            sampleRateInput.value = String(referenceSampleRate);
            isStreaming = false;
            resetStartButtonState();
            renderBinaryBrowser();

            const totalSamples = importedBinaryEntries.reduce((sum, entry) => sum + entry.decoded.values.length, 0);
            const maxSamples = importedBinaryEntries.reduce((max, entry) => Math.max(max, entry.decoded.values.length), 0);
            const maxDuration = referenceSampleRate > 0 ? maxSamples / referenceSampleRate : 0;

            updateStatus(
                `Binary compare: ${importedBinaryEntries.length} curve(s) overlaid (${formatBinaryDuration(maxDuration)} max window, ${totalSamples.toLocaleString()} total samples)`
            );

            if (failedFiles.length > 0) {
                console.warn('Skipped binary files:', failedFiles);
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            updateStatus(`Load failed: ${message}`);
        } finally {
            loadBinaryInput.value = '';
        }
    });

    renderBinaryBrowser();
    refreshDisplayModeControls();
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
