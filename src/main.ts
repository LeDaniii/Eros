/**
 * Demo app for Eros Charts
 */

import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { ErosChart, type ErosBinaryCurve } from './lib/charts/ErosChart';
import { ErosStripChart } from './lib/charts/ErosStripChart';
import {
    decodeBinaryFileForImport,
    type BinaryImportDecodeResult,
    VIRTUAL_CORE_SWITCH_THRESHOLD_BYTES,
} from './lib/core-virtual/BinaryImportDecoder';
import { VirtualCurveEngine } from './lib/core-virtual/VirtualCurveEngine';
import {
    createDerivedCurve,
    createNoiseBandCurves,
    type DerivedCurve,
} from './lib';
import { MeasurementService } from './gen/measurements_pb';

// ==========================================
// GLOBAL STATE
// ==========================================
type DemoDisplayMode = 'analysis' | 'live-strip';
type DemoChart = ErosChart | ErosStripChart;
interface AnalysisToolboxCurveStyle {
    visible: boolean;
    color: string;
}

interface DemoViewportStrategyState {
    displayMode: DemoDisplayMode;
    followLatest: boolean;
    liveWindowDurationSeconds: number;
    isFrozen: boolean;
}

type AnalysisToolboxMode = 'ema' | 'moving-average' | 'noise-band';

let chart: DemoChart | null = null;
let isStreaming = false;
let currentViewMode: 'idle' | 'live' | 'binary' = 'idle';
let binaryOverlayCharts: ErosChart[] = [];
let binaryOverlayCanvases: HTMLCanvasElement[] = [];
let binaryCompareSyncFrameId: number | null = null;
let analysisToolboxOverlayCharts: ErosChart[] = [];
let analysisToolboxOverlayCanvases: HTMLCanvasElement[] = [];
let analysisToolboxSyncFrameId: number | null = null;
let analysisToolboxRefreshInFlight = false;
let analysisToolboxLastSampleCount = -1;
let analysisToolboxLastConfigKey = '';
let analysisToolboxLastAutoRefreshMs = 0;
let analysisToolboxOverlaySignature = '';
let analysisToolboxRawValues: Float32Array | null = null;
let analysisToolboxDerivedCurves: DerivedCurve[] = [];
let analysisToolboxCurveStyles: AnalysisToolboxCurveStyle[] = [];
let analysisToolboxLegendMarkupKey = '';
const booleanStripSamples: number[] = [];

interface ImportedBinaryEntry {
    fileName: string;
    decoded: ErosBinaryCurve;
    fileSizeBytes: number;
    color: string;
    visible: boolean;
}

let importedBinaryEntries: ImportedBinaryEntry[] = [];

type VirtualAnalysisMode = 'preview' | 'exact';

interface VirtualAnalysisSession {
    engine: VirtualCurveEngine;
    fileName: string;
    color: string;
    originalSampleRate: number;
    originalSampleCount: number;
    sampleStride: number;
    previewValues: Float32Array;
    previewSampleRate: number;
    mode: VirtualAnalysisMode;
    exactWindowStartSample: number;
    exactWindowSampleCount: number;
    isLoading: boolean;
    pendingSync: boolean;
}

const VIRTUAL_EXACT_ENTRY_ORIGINAL_SAMPLES = 2_000_000;
const VIRTUAL_EXACT_EXIT_LOCAL_SAMPLES = 3_000_000;
const VIRTUAL_EXACT_MIN_WINDOW_SAMPLES = 200_000;
const VIRTUAL_EXACT_MAX_WINDOW_SAMPLES = 4_000_000;
const VIRTUAL_EXACT_EDGE_MARGIN_RATIO = 0.2;
const VIRTUAL_PREFETCH_NEIGHBOR_CHUNKS = 1;

let virtualAnalysisSession: VirtualAnalysisSession | null = null;
let virtualAnalysisSyncFrameId: number | null = null;

const displayModePreferences: {
    mode: DemoDisplayMode;
    liveWindowSeconds: number;
} = {
    mode: 'analysis',
    liveWindowSeconds: 10,
};

const analysisToolboxPreferences: {
    enabled: boolean;
    mode: AnalysisToolboxMode;
    windowSize: number;
    sigma: number;
    autoRefresh: boolean;
} = {
    enabled: false,
    mode: 'ema',
    windowSize: 50,
    sigma: 2,
    autoRefresh: true,
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
const ANALYSIS_TOOLBOX_COLORS = ['#ffd166', '#ff6b6b', '#06d6a0'];

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

function getAnalysisToolboxCurveColor(index: number): string {
    return ANALYSIS_TOOLBOX_COLORS[index % ANALYSIS_TOOLBOX_COLORS.length];
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
        <div id="analysisToolboxPanel" style="margin-top: 10px; border: 1px solid #5b4a1f; border-radius: 6px; padding: 8px; background: rgba(45, 34, 12, 0.65);">
            <div style="font-size: 11px; color: #ffd166; margin-bottom: 6px; font-weight: bold;">ANALYSIS TOOLBOX</div>
            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:6px;">
                <label style="display:flex; align-items:center; gap:6px; font-size:10px; color:#ffe8a6; cursor:pointer;">
                    <input id="analysisToolboxEnable" type="checkbox" style="margin:0; accent-color:#ffd166;" />
                    Overlay On
                </label>
                <label style="display:flex; align-items:center; gap:4px; font-size:10px; color:#d7c38a; cursor:pointer;">
                    <input id="analysisToolboxAutoRefresh" type="checkbox" checked style="margin:0; accent-color:#ffd166;" />
                    Auto
                </label>
            </div>
            <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
                <select id="analysisToolboxModeSelect"
                        style="flex:1; min-width:0; padding:4px; background:#2a2110; color:#fff1c6; border:1px solid #8d6e2f; font-family:monospace; font-size:11px;">
                    <option value="ema" selected>EMA center line</option>
                    <option value="moving-average">Moving average</option>
                    <option value="noise-band">Mean + noise band</option>
                </select>
                <button id="analysisToolboxApplyBtn"
                        style="padding:4px 8px; background:#5a4314; color:#fff0c2; border:1px solid #d4a53a; cursor:pointer; font-weight:bold; font-size:10px; border-radius:4px;">
                    APPLY
                </button>
            </div>
            <div style="display:grid; grid-template-columns:auto 1fr auto 1fr; gap:6px; align-items:center;">
                <label for="analysisToolboxWindowInput" style="font-size:10px; color:#d7c38a;">Window</label>
                <input id="analysisToolboxWindowInput" type="number" min="1" step="1" value="50"
                       style="min-width:0; padding:4px; background:#2a2110; color:#fff1c6; border:1px solid #8d6e2f; font-family:monospace; font-size:11px;" />
                <label for="analysisToolboxSigmaInput" style="font-size:10px; color:#d7c38a;">Sigma</label>
                <input id="analysisToolboxSigmaInput" type="number" min="0.1" step="0.1" value="2"
                       style="min-width:0; padding:4px; background:#2a2110; color:#fff1c6; border:1px solid #8d6e2f; font-family:monospace; font-size:11px;" />
            </div>
            <div id="analysisToolboxLegend" style="margin-top: 6px; border-top: 1px solid rgba(212,165,58,0.25); padding-top: 6px; font-size: 10px; color: #d7c38a;">
                No toolbox curves
            </div>
            <div id="analysisToolboxInfo" style="margin-top: 6px; font-size: 10px; color: #d7c38a; line-height: 1.2;">
                Disabled
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
        <button id="loadBinaryBtnServer"
             style="width: 100%; margin-top: 8px; padding: 8px; background: #1f3f6f; color: #d5e8ff; border: 1px solid #4aa3ff; cursor: pointer; font-weight: bold; font-size: 12px; border-radius: 5px;">
         LOAD .EROSB from server
        </button>
        <div style="margin-top: 10px; border: 1px solid #3f5c1f; border-radius: 6px; padding: 8px; background: rgba(22, 35, 10, 0.65);">
            <div style="font-size: 11px; color: #b9f27c; margin-bottom: 6px; font-weight: bold;">DEMO BINARY GENERATOR</div>
            <div style="display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center;">
                <input id="demoBinarySizeInput" type="number" min="1" step="0.1" value="2"
                       style="min-width:0; padding: 6px; background: #1b2411; color: #e9ffd0; border: 1px solid #6cab35; font-family: monospace; font-size: 12px;" />
                <select id="demoBinarySizeUnit"
                        style="padding: 6px; background: #1b2411; color: #e9ffd0; border: 1px solid #6cab35; font-family: monospace; font-size: 12px;">
                    <option value="gb" selected>GB</option>
                    <option value="mb">MB</option>
                </select>
            </div>
            <div id="demoBinaryEstimate" style="margin-top: 6px; font-size: 10px; color: #b5c89c; line-height: 1.25;">
                Estimate pending...
            </div>
            <button id="generateDemoBinaryBtn"
                    style="width: 100%; margin-top: 8px; padding: 8px; background: #355f12; color: #ecffd7; border: 1px solid #8fe23d; cursor: pointer; font-weight: bold; font-size: 12px; border-radius: 5px;">
                GENERATE DEMO .EROSB
            </button>
            <div style="margin-top: 5px; font-size: 9px; color: #8ea77a; line-height: 1.2;">
                Creates a valid demo file on the server and downloads it directly (no pre-buffering in UI).
            </div>
        </div>
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

        let html = `
            - Total: ${stats.totalSamples.toLocaleString()} samples (${totalMB} MB)<br>
            - Visible: ${stats.visibleSamples.toLocaleString()} samples (${zoomFactor}x zoom)<br>
            - Rendered: ${stats.renderedVertices.toLocaleString()} vertices (${stats.isDownsampled ? 'DOWNSAMPLED' : 'EXACT'})<br>
            - Buffer: ${stats.totalSamples.toLocaleString()} / ${stats.bufferSize.toLocaleString()} (${bufferUsage}%)<br>
            - Memory: ${totalMB} / ${bufferMB} MB
        `;

        if (virtualAnalysisSession && currentViewMode === 'live' && displayModePreferences.mode === 'analysis' && chart) {
            const viewport = chart.getViewportRange();
            const chunkSamples = Math.max(1, virtualAnalysisSession.engine.chunkSamples);
            const chunkCount = Math.max(1, virtualAnalysisSession.engine.chunkCount);

            let globalStartSample = 0;
            let globalEndSample = 1;

            if (virtualAnalysisSession.mode === 'preview') {
                globalStartSample = Math.max(0, Math.floor(viewport.startIndex * virtualAnalysisSession.sampleStride));
                globalEndSample = Math.min(
                    virtualAnalysisSession.originalSampleCount,
                    Math.ceil(viewport.endIndex * virtualAnalysisSession.sampleStride)
                );
            } else {
                globalStartSample = virtualAnalysisSession.exactWindowStartSample + Math.floor(viewport.startIndex);
                globalEndSample = virtualAnalysisSession.exactWindowStartSample + Math.ceil(viewport.endIndex);
                globalStartSample = clampInteger(
                    globalStartSample,
                    0,
                    Math.max(0, virtualAnalysisSession.originalSampleCount - 1)
                );
                globalEndSample = clampInteger(
                    globalEndSample,
                    globalStartSample + 1,
                    virtualAnalysisSession.originalSampleCount
                );
            }

            if (globalEndSample <= globalStartSample) {
                globalEndSample = Math.min(virtualAnalysisSession.originalSampleCount, globalStartSample + 1);
            }

            const currentChunkStart = clampInteger(
                Math.floor(globalStartSample / chunkSamples),
                0,
                chunkCount - 1
            );
            const currentChunkEnd = clampInteger(
                Math.floor(Math.max(globalStartSample, globalEndSample - 1) / chunkSamples),
                currentChunkStart,
                chunkCount - 1
            );
            const currentChunkLabel = currentChunkStart === currentChunkEnd
                ? `${currentChunkStart + 1}`
                : `${currentChunkStart + 1}-${currentChunkEnd + 1}`;
            const cacheInfo = virtualAnalysisSession.engine.getCacheInfo();

            html += `<br>- Virtual: ${virtualAnalysisSession.mode.toUpperCase()} | Source: ${virtualAnalysisSession.originalSampleCount.toLocaleString()} samples (${formatBinarySize(virtualAnalysisSession.originalSampleCount * 4)})`;
            html += `<br>- Chunks: total ${chunkCount.toLocaleString()} | current ${currentChunkLabel} | cache ${cacheInfo.cachedChunks}/${cacheInfo.maxCachedChunks}`;
        }

        dataStatsEl.innerHTML = html;
    }
}

function isStripChartInstance(value: DemoChart | null): value is ErosStripChart {
    return value instanceof ErosStripChart;
}

function isAnalysisChartInstance(value: DemoChart | null): value is ErosChart {
    return value instanceof ErosChart;
}

function canUseAnalysisToolbox(): boolean {
    return (
        isAnalysisChartInstance(chart)
        && currentViewMode !== 'binary'
        && displayModePreferences.mode === 'analysis'
    );
}

function getActiveAnalysisToolboxChart(): ErosChart | null {
    return canUseAnalysisToolbox() && isAnalysisChartInstance(chart) ? chart : null;
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

    refreshAnalysisToolboxControls();
}

function refreshAnalysisToolboxControls(): void {
    const panel = document.getElementById('analysisToolboxPanel') as HTMLDivElement | null;
    const enableInput = document.getElementById('analysisToolboxEnable') as HTMLInputElement | null;
    const autoRefreshInput = document.getElementById('analysisToolboxAutoRefresh') as HTMLInputElement | null;
    const modeSelect = document.getElementById('analysisToolboxModeSelect') as HTMLSelectElement | null;
    const windowInput = document.getElementById('analysisToolboxWindowInput') as HTMLInputElement | null;
    const sigmaInput = document.getElementById('analysisToolboxSigmaInput') as HTMLInputElement | null;
    const applyBtn = document.getElementById('analysisToolboxApplyBtn') as HTMLButtonElement | null;
    const legend = document.getElementById('analysisToolboxLegend') as HTMLDivElement | null;
    const info = document.getElementById('analysisToolboxInfo') as HTMLDivElement | null;

    if (!panel || !enableInput || !autoRefreshInput || !modeSelect || !windowInput || !sigmaInput || !applyBtn || !legend || !info) {
        return;
    }

    const analysisModeSelected = displayModePreferences.mode === 'analysis';
    const toolboxAvailable = canUseAnalysisToolbox();
    const sigmaRelevant = analysisToolboxPreferences.mode === 'noise-band';

    panel.style.display = analysisModeSelected ? 'block' : 'none';
    enableInput.checked = analysisToolboxPreferences.enabled;
    autoRefreshInput.checked = analysisToolboxPreferences.autoRefresh;
    modeSelect.value = analysisToolboxPreferences.mode;
    windowInput.value = String(Math.max(1, Math.floor(analysisToolboxPreferences.windowSize)));
    sigmaInput.value = String(analysisToolboxPreferences.sigma);

    const controlsEnabled = analysisModeSelected;
    enableInput.disabled = !controlsEnabled;
    autoRefreshInput.disabled = !controlsEnabled || !analysisToolboxPreferences.enabled;
    modeSelect.disabled = !controlsEnabled || !analysisToolboxPreferences.enabled;
    windowInput.disabled = !controlsEnabled || !analysisToolboxPreferences.enabled;
    sigmaInput.disabled = !controlsEnabled || !analysisToolboxPreferences.enabled || !sigmaRelevant;
    applyBtn.disabled = !controlsEnabled || !analysisToolboxPreferences.enabled || !toolboxAvailable;

    const baseColor = toolboxAvailable ? '#fff1c6' : '#c0ab74';
    applyBtn.style.opacity = applyBtn.disabled ? '0.6' : '1';
    panel.style.borderColor = toolboxAvailable ? '#8d6e2f' : '#5b4a1f';
    info.style.color = baseColor;

    const buildLegendMarkup = (): string => {
        if (!analysisModeSelected) {
            return '<div style="opacity:0.8;">Analysis mode only</div>';
        }

        if (!analysisToolboxPreferences.enabled) {
            return '<div style="opacity:0.8;">Enable overlay to show toolbox curves</div>';
        }

        if (!toolboxAvailable) {
            return '<div style="opacity:0.8;">Create/start an analysis chart first</div>';
        }

        if (analysisToolboxDerivedCurves.length < 1) {
            return '<div style="opacity:0.8;">No toolbox curves yet (press APPLY or wait for data)</div>';
        }

        return analysisToolboxDerivedCurves.map((curve, index) => {
            const style = analysisToolboxCurveStyles[index] ?? {
                visible: true,
                color: getAnalysisToolboxCurveColor(index),
            };
            const safeLabel = escapeHtml(curve.label);
            const rowOpacity = style.visible ? 1 : 0.55;
            return `<div style="display:flex; align-items:center; gap:6px; margin-top:${index === 0 ? 0 : 4}px; opacity:${rowOpacity};">
                <input type="checkbox" data-toolbox-curve-index="${index}" data-toolbox-curve-action="visible" ${style.visible ? 'checked' : ''}
                       title="Show/hide toolbox curve" style="margin:0; accent-color:${style.color}; cursor:pointer;" />
                <input type="color" data-toolbox-curve-index="${index}" data-toolbox-curve-action="color" value="${style.color}"
                       title="Toolbox curve color" style="width:22px; height:16px; padding:0; border:none; background:transparent; cursor:pointer;" />
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${style.color}; box-shadow:0 0 4px ${style.color};"></span>
                <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${safeLabel}</span>
            </div>`;
        }).join('');
    };

    const legendMarkup = buildLegendMarkup();
    const activeElement = document.activeElement;
    const legendInteractionActive = activeElement instanceof HTMLInputElement
        && activeElement.isConnected
        && activeElement.dataset.toolboxCurveIndex !== undefined
        && (activeElement.type === 'color' || activeElement.type === 'checkbox');
    if (!legendInteractionActive && analysisToolboxLegendMarkupKey !== legendMarkup) {
        legend.innerHTML = legendMarkup;
        analysisToolboxLegendMarkupKey = legendMarkup;
    }

    if (!analysisModeSelected) {
        info.textContent = 'Available in Analysis display mode only';
        return;
    }

    if (!analysisToolboxPreferences.enabled) {
        info.textContent = 'Disabled';
        return;
    }

    if (!toolboxAvailable) {
        info.textContent = 'Create/start an analysis chart to apply overlays';
        return;
    }

    const visibleLabels = analysisToolboxDerivedCurves
        .filter((_, index) => analysisToolboxCurveStyles[index]?.visible !== false)
        .map((curve) => curve.label);
    const hiddenCount = Math.max(0, analysisToolboxDerivedCurves.length - visibleLabels.length);
    const totalSamples = chart?.getStats().totalSamples ?? 0;
    info.textContent = analysisToolboxDerivedCurves.length > 0
        ? `Active: ${visibleLabels.join(' | ') || 'none'}${hiddenCount > 0 ? ` | hidden: ${hiddenCount}` : ''} | ${totalSamples.toLocaleString()} samples`
        : 'Enabled (no overlay data yet). Press APPLY or wait for samples.';
}

function clampInteger(value: number, min: number, max: number): number {
    const normalized = Math.floor(value);
    return Math.max(min, Math.min(max, normalized));
}

function isVirtualAnalysisActive(): boolean {
    return virtualAnalysisSession !== null && currentViewMode === 'live' && displayModePreferences.mode === 'analysis';
}

function clearVirtualAnalysisSession(): void {
    if (virtualAnalysisSyncFrameId !== null) {
        cancelAnimationFrame(virtualAnalysisSyncFrameId);
        virtualAnalysisSyncFrameId = null;
    }

    const session = virtualAnalysisSession;
    virtualAnalysisSession = null;
    if (session) {
        void Promise.resolve(session.engine.close()).catch(() => undefined);
    }
}

async function withVirtualLoadingGuard(
    session: VirtualAnalysisSession,
    action: () => Promise<void>
): Promise<void> {
    if (session.isLoading) {
        session.pendingSync = true;
        return;
    }

    session.isLoading = true;
    try {
        await action();
    } finally {
        session.isLoading = false;
        if (session.pendingSync) {
            session.pendingSync = false;
            if (virtualAnalysisSession === session) {
                scheduleVirtualAnalysisSync();
            }
        }
    }
}

function scheduleVirtualAnalysisSync(): void {
    if (!isVirtualAnalysisActive()) {
        return;
    }

    if (virtualAnalysisSyncFrameId !== null) {
        return;
    }

    virtualAnalysisSyncFrameId = requestAnimationFrame(() => {
        virtualAnalysisSyncFrameId = null;
        void syncVirtualAnalysisSession();
    });
}

function onPrimaryChartViewportChanged(): void {
    scheduleAnalysisToolboxSync();
    scheduleVirtualAnalysisSync();
}

async function applyVirtualPreviewWindow(
    session: VirtualAnalysisSession,
    focusGlobalStart?: number,
    focusGlobalEnd?: number
): Promise<void> {
    await withVirtualLoadingGuard(session, async () => {
        const previewSampleRate = Math.max(1, session.previewSampleRate);
        const previewSampleCount = Math.max(1, session.previewValues.length);
        const previewBufferSize = Math.max(1024, Math.ceil(previewSampleCount * 1.1));
        const analysisChart = await createOrReplaceAnalysisChart(previewSampleRate, previewBufferSize);
        if (virtualAnalysisSession !== session) {
            return;
        }

        analysisChart.setTimeOffsetSamples(0);
        analysisChart.setLineColor(session.color);
        analysisChart.loadData(session.previewValues);

        if (
            Number.isFinite(focusGlobalStart)
            && Number.isFinite(focusGlobalEnd)
            && focusGlobalEnd! > focusGlobalStart!
        ) {
            const mappedStart = Math.floor((focusGlobalStart ?? 0) / session.sampleStride);
            const mappedEnd = Math.ceil((focusGlobalEnd ?? 0) / session.sampleStride);
            const clampedStart = clampInteger(mappedStart, 0, Math.max(0, previewSampleCount - 1));
            const clampedEnd = clampInteger(mappedEnd, clampedStart + 1, previewSampleCount);
            analysisChart.setViewport(clampedStart, clampedEnd);
        }

        session.mode = 'preview';
        session.exactWindowStartSample = 0;
        session.exactWindowSampleCount = 0;
        scheduleVirtualAnalysisSync();
    });
}

async function applyVirtualExactWindow(
    session: VirtualAnalysisSession,
    windowStartSample: number,
    windowEndSample: number,
    focusGlobalStart: number,
    focusGlobalEnd: number
): Promise<void> {
    await withVirtualLoadingGuard(session, async () => {
        const clampedWindowStart = clampInteger(windowStartSample, 0, Math.max(0, session.originalSampleCount - 1));
        const clampedWindowEnd = clampInteger(windowEndSample, clampedWindowStart + 1, session.originalSampleCount);
        const values = await session.engine.getExactRange({
            startSample: clampedWindowStart,
            endSample: clampedWindowEnd,
            prefetchNeighborChunks: VIRTUAL_PREFETCH_NEIGHBOR_CHUNKS,
        });
        if (virtualAnalysisSession !== session) {
            return;
        }

        if (values.length < 2) {
            return;
        }

        const exactBufferSize = Math.max(1024, Math.ceil(values.length * 1.1));
        const analysisChart = await createOrReplaceAnalysisChart(session.originalSampleRate, exactBufferSize);
        if (virtualAnalysisSession !== session) {
            return;
        }

        analysisChart.setTimeOffsetSamples(clampedWindowStart);
        analysisChart.setLineColor(session.color);
        analysisChart.loadData(values);

        const localFocusStart = clampInteger(focusGlobalStart - clampedWindowStart, 0, values.length - 1);
        const localFocusEnd = clampInteger(focusGlobalEnd - clampedWindowStart, localFocusStart + 1, values.length);
        analysisChart.setViewport(localFocusStart, localFocusEnd);

        session.mode = 'exact';
        session.exactWindowStartSample = clampedWindowStart;
        session.exactWindowSampleCount = values.length;
        scheduleVirtualAnalysisSync();
    });
}

function computeVirtualExactWindowAroundFocus(
    session: VirtualAnalysisSession,
    focusGlobalStart: number,
    focusGlobalEnd: number,
    multiplier: number
): { windowStart: number; windowEnd: number } {
    const focusStart = clampInteger(focusGlobalStart, 0, Math.max(0, session.originalSampleCount - 1));
    const focusEnd = clampInteger(focusGlobalEnd, focusStart + 1, session.originalSampleCount);
    const focusVisible = Math.max(1, focusEnd - focusStart);
    const targetWindow = clampInteger(
        Math.max(VIRTUAL_EXACT_MIN_WINDOW_SAMPLES, focusVisible * multiplier),
        VIRTUAL_EXACT_MIN_WINDOW_SAMPLES,
        VIRTUAL_EXACT_MAX_WINDOW_SAMPLES
    );

    const focusCenter = Math.floor((focusStart + focusEnd) / 2);
    let windowStart = Math.max(0, focusCenter - Math.floor(targetWindow / 2));
    let windowEnd = Math.min(session.originalSampleCount, windowStart + targetWindow);
    windowStart = Math.max(0, windowEnd - targetWindow);

    return { windowStart, windowEnd };
}

async function syncVirtualAnalysisSession(): Promise<void> {
    const session = virtualAnalysisSession;
    if (!session || !isAnalysisChartInstance(chart) || currentViewMode !== 'live' || displayModePreferences.mode !== 'analysis') {
        return;
    }

    if (session.isLoading) {
        session.pendingSync = true;
        return;
    }

    const { startIndex, endIndex } = chart.getViewportRange();
    const visibleSamples = Math.max(1, Math.ceil(endIndex - startIndex));

    if (session.mode === 'preview') {
        const visibleOriginalSamples = visibleSamples * session.sampleStride;
        if (visibleOriginalSamples > VIRTUAL_EXACT_ENTRY_ORIGINAL_SAMPLES) {
            return;
        }

        const focusGlobalStart = Math.max(0, Math.floor(startIndex * session.sampleStride));
        const focusGlobalEnd = Math.min(session.originalSampleCount, Math.ceil(endIndex * session.sampleStride));
        if (focusGlobalEnd <= focusGlobalStart) {
            return;
        }

        const nextWindow = computeVirtualExactWindowAroundFocus(session, focusGlobalStart, focusGlobalEnd, 2);
        await applyVirtualExactWindow(
            session,
            nextWindow.windowStart,
            nextWindow.windowEnd,
            focusGlobalStart,
            focusGlobalEnd
        );
        updateStatus(
            `Virtual exact window loaded (${formatBinaryDuration((focusGlobalEnd - focusGlobalStart) / session.originalSampleRate)} visible).`
        );
        return;
    }

    const localStart = clampInteger(startIndex, 0, Math.max(0, session.exactWindowSampleCount - 1));
    const localEnd = clampInteger(endIndex, localStart + 1, session.exactWindowSampleCount);
    const focusGlobalStart = session.exactWindowStartSample + localStart;
    const focusGlobalEnd = session.exactWindowStartSample + localEnd;
    const exactVisible = Math.max(1, localEnd - localStart);

    if (exactVisible >= VIRTUAL_EXACT_EXIT_LOCAL_SAMPLES) {
        await applyVirtualPreviewWindow(session, focusGlobalStart, focusGlobalEnd);
        updateStatus('Virtual preview restored for wider window navigation.');
        return;
    }

    const edgeMargin = Math.max(128, Math.floor(session.exactWindowSampleCount * VIRTUAL_EXACT_EDGE_MARGIN_RATIO));
    const nearLeftEdge = localStart <= edgeMargin;
    const nearRightEdge = localEnd >= Math.max(1, session.exactWindowSampleCount - edgeMargin);
    if (!nearLeftEdge && !nearRightEdge) {
        return;
    }

    const nextWindow = computeVirtualExactWindowAroundFocus(session, focusGlobalStart, focusGlobalEnd, 3);
    const shiftDelta = Math.abs(nextWindow.windowStart - session.exactWindowStartSample);
    const minimumShift = Math.max(2048, Math.floor((nextWindow.windowEnd - nextWindow.windowStart) * 0.1));
    if (shiftDelta < minimumShift) {
        return;
    }

    await applyVirtualExactWindow(
        session,
        nextWindow.windowStart,
        nextWindow.windowEnd,
        focusGlobalStart,
        focusGlobalEnd
    );
}

async function activateVirtualAnalysisSession(
    entry: ImportedBinaryEntry,
    sourceFile: File,
    decodedResult: BinaryImportDecodeResult
): Promise<void> {
    clearVirtualAnalysisSession();

    const engine = await VirtualCurveEngine.openFromLocalFile(sourceFile, {
        maxCachedChunks: 64,
        autoPrefetchNeighborChunks: VIRTUAL_PREFETCH_NEIGHBOR_CHUNKS,
    });

    const session: VirtualAnalysisSession = {
        engine,
        fileName: entry.fileName,
        color: entry.color,
        originalSampleRate: Math.max(1, decodedResult.originalSampleRate),
        originalSampleCount: Math.max(1, decodedResult.originalSampleCount),
        sampleStride: Math.max(1, decodedResult.sampleStride),
        previewValues: decodedResult.decoded.values,
        previewSampleRate: Math.max(1, decodedResult.decoded.sampleRate),
        mode: 'preview',
        exactWindowStartSample: 0,
        exactWindowSampleCount: 0,
        isLoading: false,
        pendingSync: false,
    };

    virtualAnalysisSession = session;
    await applyVirtualPreviewWindow(session);
}

async function createOrReplaceAnalysisChart(sampleRate: number, bufferSize: number): Promise<ErosChart> {
    destroyBinaryOverlayCharts();
    destroyAnalysisToolboxOverlayCharts(false);

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
    nextChart.setViewportChangeListener(onPrimaryChartViewportChanged);
    chart = nextChart;
    refreshDisplayModeControls();
    void refreshAnalysisToolboxOverlays(true);
    return nextChart;
}

async function createOrReplaceStripChart(_sampleRate: number, _bufferSize: number): Promise<ErosStripChart> {
    clearVirtualAnalysisSession();
    destroyBinaryOverlayCharts();
    destroyAnalysisToolboxOverlayCharts(false);

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

function createAnalysisToolboxOverlayCanvas(_zIndex: number): HTMLCanvasElement {
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
    canvas.style.zIndex = '2';
    canvas.dataset.role = 'analysis-toolbox-overlay';
    container.appendChild(canvas);
    return canvas;
}

function destroyAnalysisToolboxOverlayCharts(clearBaseYRange = true): void {
    if (analysisToolboxSyncFrameId !== null) {
        cancelAnimationFrame(analysisToolboxSyncFrameId);
        analysisToolboxSyncFrameId = null;
    }

    for (const overlayChart of analysisToolboxOverlayCharts) {
        overlayChart.setViewportChangeListener(null);
        overlayChart.destroy();
    }
    analysisToolboxOverlayCharts = [];

    for (const overlayCanvas of analysisToolboxOverlayCanvases) {
        overlayCanvas.remove();
    }
    analysisToolboxOverlayCanvases = [];

    analysisToolboxOverlaySignature = '';
    analysisToolboxRawValues = null;
    analysisToolboxDerivedCurves = [];
    analysisToolboxLastSampleCount = -1;
    analysisToolboxLastConfigKey = '';
    analysisToolboxLegendMarkupKey = '';

    if (clearBaseYRange) {
        const activeAnalysisChart = getActiveAnalysisToolboxChart();
        activeAnalysisChart?.clearYRangeOverride();
    }
}

function buildAnalysisToolboxDerivedCurves(values: ArrayLike<number>): DerivedCurve[] {
    const windowSize = Math.max(1, Math.floor(analysisToolboxPreferences.windowSize));
    const sigma = Number.isFinite(analysisToolboxPreferences.sigma) && analysisToolboxPreferences.sigma > 0
        ? analysisToolboxPreferences.sigma
        : 2;

    switch (analysisToolboxPreferences.mode) {
        case 'ema':
            return [createDerivedCurve(values, { kind: 'ema', period: windowSize, label: `EMA(${windowSize})` })];
        case 'moving-average':
            return [createDerivedCurve(values, { kind: 'moving-average', windowSize, label: `MA(${windowSize})` })];
        case 'noise-band': {
            const band = createNoiseBandCurves(values, { windowSize, sigma });
            return [band.center, band.upper, band.lower];
        }
    }
}

function syncAnalysisToolboxCurveStylesWithDerivedCurves(): void {
    analysisToolboxCurveStyles = analysisToolboxDerivedCurves.map((_, index) => {
        const previous = analysisToolboxCurveStyles[index];
        return {
            visible: previous?.visible ?? true,
            color: previous?.color ?? getAnalysisToolboxCurveColor(index),
        };
    });
}

function applyAnalysisToolboxCurveStyles(): void {
    for (let i = 0; i < analysisToolboxOverlayCharts.length; i++) {
        const overlayChart = analysisToolboxOverlayCharts[i];
        const overlayCanvas = analysisToolboxOverlayCanvases[i];
        const style = analysisToolboxCurveStyles[i] ?? {
            visible: true,
            color: getAnalysisToolboxCurveColor(i),
        };

        overlayChart?.setLineColor(style.color);
        if (overlayCanvas) {
            overlayCanvas.style.opacity = style.visible ? '1' : '0';
        }
    }

    scheduleAnalysisToolboxSync();
}

function computeSharedAnalysisToolboxYRange(startIndex: number, endIndex: number): { min: number; max: number } | null {
    const rawValues = analysisToolboxRawValues;
    if (!rawValues || rawValues.length < 1) {
        return null;
    }

    const visibleDerivedSeries = analysisToolboxDerivedCurves
        .map((curve, index) => ({ curve, style: analysisToolboxCurveStyles[index] }))
        .filter((entry) => entry.style?.visible !== false)
        .map((entry) => entry.curve.values);
    const series: Array<ArrayLike<number>> = [rawValues, ...visibleDerivedSeries];
    let minValue = Infinity;
    let maxValue = -Infinity;

    for (const values of series) {
        const length = values.length ?? 0;
        if (length < 1) {
            continue;
        }

        if (startIndex >= length || endIndex <= 0) {
            continue;
        }

        const start = Math.max(0, Math.min(length - 1, Math.floor(startIndex)));
        const end = Math.max(start + 1, Math.min(length, Math.ceil(endIndex)));

        for (let i = start; i < end; i++) {
            const value = Number(values[i]);
            if (!Number.isFinite(value)) {
                continue;
            }
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

function syncAnalysisToolboxCharts(): void {
    analysisToolboxSyncFrameId = null;

    const baseChart = getActiveAnalysisToolboxChart();
    if (!baseChart || analysisToolboxOverlayCharts.length === 0) {
        return;
    }

    const { startIndex, endIndex } = baseChart.getViewportRange();
    for (const overlayChart of analysisToolboxOverlayCharts) {
        overlayChart.setViewport(startIndex, endIndex);
    }

    const sharedRange = computeSharedAnalysisToolboxYRange(startIndex, endIndex);
    if (!sharedRange) {
        baseChart.clearYRangeOverride();
        for (const overlayChart of analysisToolboxOverlayCharts) {
            overlayChart.clearYRangeOverride();
        }
        return;
    }

    baseChart.setYRangeOverride(sharedRange.min, sharedRange.max);
    for (const overlayChart of analysisToolboxOverlayCharts) {
        overlayChart.setYRangeOverride(sharedRange.min, sharedRange.max);
    }
}

function scheduleAnalysisToolboxSync(): void {
    if (analysisToolboxSyncFrameId !== null) {
        return;
    }

    analysisToolboxSyncFrameId = requestAnimationFrame(syncAnalysisToolboxCharts);
}

async function ensureAnalysisToolboxOverlayCharts(
    curveCount: number,
    sampleRate: number,
    bufferSize: number
): Promise<void> {
    const safeCurveCount = Math.max(0, Math.floor(curveCount));
    const safeSampleRate = Math.max(1, Math.floor(sampleRate));
    const safeBufferSize = Math.max(1024, Math.floor(bufferSize));
    const signature = `${safeCurveCount}|${safeSampleRate}|${safeBufferSize}`;

    if (analysisToolboxOverlaySignature !== signature) {
        destroyAnalysisToolboxOverlayCharts(false);
        analysisToolboxOverlaySignature = signature;

        for (let i = 0; i < safeCurveCount; i++) {
            const overlayCanvas = createAnalysisToolboxOverlayCanvas(i);
            const overlayChart = new ErosChart(overlayCanvas, {
                grpcUrl: DEFAULT_GRPC_URL,
                bufferSize: safeBufferSize,
                sampleRate: safeSampleRate,
                lineColor: getAnalysisToolboxCurveColor(i),
                showGrid: false,
                showCrosshair: false,
                enableInteractions: false,
                enableWorker: false,
                transparentBackground: true,
            });

            await overlayChart.initialize();
            analysisToolboxOverlayCanvases.push(overlayCanvas);
            analysisToolboxOverlayCharts.push(overlayChart);
        }
    }
}

async function refreshAnalysisToolboxOverlays(force = false): Promise<void> {
    const baseChart = getActiveAnalysisToolboxChart();
    if (!analysisToolboxPreferences.enabled || !baseChart) {
        destroyAnalysisToolboxOverlayCharts();
        return;
    }

    if (!force && !analysisToolboxPreferences.autoRefresh) {
        return;
    }

    const nowMs = Date.now();
    if (!force && nowMs - analysisToolboxLastAutoRefreshMs < 400) {
        return;
    }

    if (analysisToolboxRefreshInFlight) {
        return;
    }

    const configKey = [
        analysisToolboxPreferences.mode,
        Math.max(1, Math.floor(analysisToolboxPreferences.windowSize)),
        Number.isFinite(analysisToolboxPreferences.sigma) ? analysisToolboxPreferences.sigma.toFixed(3) : 'NaN',
    ].join('|');

    const baseStats = baseChart.getStats();
    if (baseStats.totalSamples < 1) {
        destroyAnalysisToolboxOverlayCharts();
        return;
    }

    if (!force && analysisToolboxLastSampleCount === baseStats.totalSamples && analysisToolboxLastConfigKey === configKey) {
        scheduleAnalysisToolboxSync();
        return;
    }

    analysisToolboxRefreshInFlight = true;
    try {
        const exported = baseChart.exportBinary();
        const decoded = ErosChart.decodeBinary(exported);
        const derivedCurves = buildAnalysisToolboxDerivedCurves(decoded.values);

        if (derivedCurves.length < 1) {
            destroyAnalysisToolboxOverlayCharts();
            return;
        }

        await ensureAnalysisToolboxOverlayCharts(derivedCurves.length, decoded.sampleRate, baseStats.bufferSize);

        analysisToolboxRawValues = decoded.values;
        analysisToolboxDerivedCurves = derivedCurves;
        syncAnalysisToolboxCurveStylesWithDerivedCurves();

        for (let i = 0; i < derivedCurves.length; i++) {
            const overlayChart = analysisToolboxOverlayCharts[i];
            if (!overlayChart) {
                continue;
            }
            overlayChart.loadData(derivedCurves[i].values);
        }
        applyAnalysisToolboxCurveStyles();

        analysisToolboxLastSampleCount = decoded.values.length;
        analysisToolboxLastConfigKey = configKey;
        analysisToolboxLastAutoRefreshMs = nowMs;
        scheduleAnalysisToolboxSync();
    } catch (error) {
        console.warn('[Analysis Toolbox] Refresh failed:', error);
    } finally {
        analysisToolboxRefreshInFlight = false;
    }
}

function formatBinaryDuration(seconds: number): string {
    if (!Number.isFinite(seconds)) return '0s';
    if (seconds >= 10) return `${seconds.toFixed(2)}s`;
    if (seconds >= 1) return `${seconds.toFixed(3)}s`;
    return `${seconds.toFixed(4)}s`;
}

function formatBinarySize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatDemoGenerationDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0s';
    if (seconds < 60) return formatBinaryDuration(seconds);

    const totalSeconds = Math.round(seconds);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    const parts: string[] = [];

    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length > 0) parts.push(`${minutes}m`);
    if (parts.length < 2) parts.push(`${remainingSeconds}s`);

    return parts.join(' ');
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
    clearVirtualAnalysisSession();
    destroyBinaryOverlayCharts();
    destroyAnalysisToolboxOverlayCharts(false);

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

async function createOrReplaceSingleBinaryAnalysisChart(entry: ImportedBinaryEntry): Promise<void> {
    clearVirtualAnalysisSession();
    displayModePreferences.mode = 'analysis';

    const sampleRate = Math.max(1, entry.decoded.sampleRate);
    const sampleCount = Math.max(1, entry.decoded.values.length);
    const bufferSize = Math.max(1024, Math.ceil(sampleCount * 1.1));

    const analysisChart = await createOrReplaceAnalysisChart(sampleRate, bufferSize);
    analysisChart.setTimeOffsetSamples(0);
    analysisChart.setLineColor(entry.color);
    analysisChart.loadData(entry.decoded.values);

    if (analysisToolboxPreferences.enabled) {
        void refreshAnalysisToolboxOverlays(true);
    }
}

// Update stats every 200ms
setInterval(() => {
    if (chart) updateDataStats();
    refreshDisplayModeControls();
    void refreshAnalysisToolboxOverlays(false);
}, 200);

// ==========================================
// BUTTON EVENT HANDLERS
// ==========================================
function setupButtonHandlers(): void {
    const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
    const resetZoomBtn = document.getElementById('resetZoomBtn') as HTMLButtonElement;
    const downloadBinaryBtn = document.getElementById('downloadBinaryBtn') as HTMLButtonElement;
    const loadBinaryBtnServer = document.getElementById('loadBinaryBtnServer') as HTMLButtonElement;
    const generateDemoBinaryBtn = document.getElementById('generateDemoBinaryBtn') as HTMLButtonElement;
    const demoBinarySizeInput = document.getElementById('demoBinarySizeInput') as HTMLInputElement;
    const demoBinarySizeUnit = document.getElementById('demoBinarySizeUnit') as HTMLSelectElement;
    const demoBinaryEstimate = document.getElementById('demoBinaryEstimate') as HTMLDivElement;
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
    const analysisToolboxEnable = document.getElementById('analysisToolboxEnable') as HTMLInputElement;
    const analysisToolboxAutoRefresh = document.getElementById('analysisToolboxAutoRefresh') as HTMLInputElement;
    const analysisToolboxModeSelect = document.getElementById('analysisToolboxModeSelect') as HTMLSelectElement;
    const analysisToolboxWindowInput = document.getElementById('analysisToolboxWindowInput') as HTMLInputElement;
    const analysisToolboxSigmaInput = document.getElementById('analysisToolboxSigmaInput') as HTMLInputElement;
    const analysisToolboxApplyBtn = document.getElementById('analysisToolboxApplyBtn') as HTMLButtonElement;
    const analysisToolboxLegend = document.getElementById('analysisToolboxLegend') as HTMLDivElement;

    const resetStartButtonState = (): void => {
        startBtn.disabled = false;
        startBtn.textContent = 'START STREAM';
        startBtn.style.background = '#00ff00';
    };

    const getDemoBinaryTargetBytes = (): number | null => {
        const sizeValue = Number.parseFloat(demoBinarySizeInput.value);
        if (!Number.isFinite(sizeValue) || sizeValue <= 0) {
            return null;
        }

        const unit = demoBinarySizeUnit.value.toLowerCase();
        const multiplier = unit === 'gb'
            ? 1024 ** 3
            : unit === 'mb'
                ? 1024 ** 2
                : 1;

        const bytes = Math.floor(sizeValue * multiplier);
        return bytes >= 24 ? bytes : null;
    };

    const getNormalizedSampleRateForDemoBinary = (): number | null => {
        const sampleRate = Number.parseInt(sampleRateInput.value, 10);
        if (!Number.isFinite(sampleRate) || sampleRate < 1) {
            return null;
        }

        return Math.max(1, Math.floor(sampleRate));
    };

    const refreshDemoBinaryGeneratorControls = (): void => {
        const targetBytes = getDemoBinaryTargetBytes();
        const sampleRate = getNormalizedSampleRateForDemoBinary();
        const headerBytes = 20;

        if (!targetBytes) {
            generateDemoBinaryBtn.disabled = true;
            generateDemoBinaryBtn.style.opacity = '0.6';
            demoBinaryEstimate.textContent = 'Enter a target size >= 24 bytes.';
            return;
        }

        if (!sampleRate) {
            generateDemoBinaryBtn.disabled = true;
            generateDemoBinaryBtn.style.opacity = '0.6';
            demoBinaryEstimate.textContent = 'Enter a valid sample rate (> 0 Hz) first.';
            return;
        }

        const sampleCount = Math.max(0, Math.floor((targetBytes - headerBytes) / 4));
        const actualBytes = headerBytes + sampleCount * 4;
        const durationSeconds = sampleCount / sampleRate;

        generateDemoBinaryBtn.disabled = sampleCount < 1;
        generateDemoBinaryBtn.style.opacity = generateDemoBinaryBtn.disabled ? '0.6' : '1';
        demoBinaryEstimate.textContent =
            `Actual: ${formatBinarySize(actualBytes)} | Samples: ${sampleCount.toLocaleString()} | ` +
            `Duration: ${formatDemoGenerationDuration(durationSeconds)} @ ${sampleRate.toLocaleString()} Hz`;
    };

    const readAnalysisToolboxPreferencesFromUi = (): void => {
        analysisToolboxPreferences.enabled = analysisToolboxEnable.checked;
        analysisToolboxPreferences.autoRefresh = analysisToolboxAutoRefresh.checked;

        const selectedMode = analysisToolboxModeSelect.value;
        if (selectedMode === 'ema' || selectedMode === 'moving-average' || selectedMode === 'noise-band') {
            analysisToolboxPreferences.mode = selectedMode;
        }

        const parsedWindow = Number.parseInt(analysisToolboxWindowInput.value, 10);
        analysisToolboxPreferences.windowSize = Number.isFinite(parsedWindow) && parsedWindow > 0
            ? parsedWindow
            : 50;

        const parsedSigma = Number.parseFloat(analysisToolboxSigmaInput.value);
        analysisToolboxPreferences.sigma = Number.isFinite(parsedSigma) && parsedSigma > 0
            ? parsedSigma
            : 2;
    };

    const triggerAnalysisToolboxRefresh = (force: boolean, statusMessage?: string): void => {
        if (statusMessage) {
            updateStatus(statusMessage);
        }
        refreshAnalysisToolboxControls();
        void refreshAnalysisToolboxOverlays(force);
    };

    const handleAnalysisToolboxLegendChange = (target: EventTarget | null, rerenderUi: boolean): void => {
        if (!(target instanceof HTMLInputElement)) {
            return;
        }

        const action = target.dataset.toolboxCurveAction;
        if (!action) {
            return;
        }

        const index = Number.parseInt(target.dataset.toolboxCurveIndex ?? '', 10);
        if (!Number.isFinite(index) || index < 0 || index >= analysisToolboxCurveStyles.length) {
            return;
        }

        const style = analysisToolboxCurveStyles[index];
        if (!style) {
            return;
        }

        if (action === 'visible' && target.type === 'checkbox') {
            style.visible = target.checked;
            applyAnalysisToolboxCurveStyles();
            if (rerenderUi) {
                refreshAnalysisToolboxControls();
            }
            return;
        }

        if (action === 'color' && target.type === 'color') {
            style.color = target.value;
            applyAnalysisToolboxCurveStyles();
            if (rerenderUi) {
                refreshAnalysisToolboxControls();
            }
        }
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
        if (mode === 'binary') {
            clearVirtualAnalysisSession();
            destroyAnalysisToolboxOverlayCharts(false);
        } else if (mode !== 'live') {
            clearVirtualAnalysisSession();
        }
        renderBinaryBrowser();
        refreshAnalysisToolboxControls();
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

    analysisToolboxLegend.addEventListener('change', (event) => {
        handleAnalysisToolboxLegendChange(event.target, true);
    });

    analysisToolboxLegend.addEventListener('input', (event) => {
        handleAnalysisToolboxLegendChange(event.target, false);
    });

    analysisToolboxEnable.addEventListener('change', () => {
        readAnalysisToolboxPreferencesFromUi();

        if (!analysisToolboxPreferences.enabled) {
            destroyAnalysisToolboxOverlayCharts();
            refreshAnalysisToolboxControls();
            updateStatus('Analysis toolbox overlay disabled');
            return;
        }

        triggerAnalysisToolboxRefresh(true, 'Applying analysis toolbox overlay...');
    });

    analysisToolboxAutoRefresh.addEventListener('change', () => {
        readAnalysisToolboxPreferencesFromUi();
        refreshAnalysisToolboxControls();
        if (analysisToolboxPreferences.enabled && analysisToolboxPreferences.autoRefresh) {
            triggerAnalysisToolboxRefresh(true, 'Analysis toolbox auto-refresh enabled');
        }
    });

    analysisToolboxModeSelect.addEventListener('change', () => {
        readAnalysisToolboxPreferencesFromUi();
        analysisToolboxLastConfigKey = '';
        if (analysisToolboxPreferences.enabled) {
            triggerAnalysisToolboxRefresh(true, 'Applying analysis toolbox overlay...');
        } else {
            refreshAnalysisToolboxControls();
        }
    });

    analysisToolboxWindowInput.addEventListener('change', () => {
        readAnalysisToolboxPreferencesFromUi();
        analysisToolboxLastConfigKey = '';
        if (analysisToolboxPreferences.enabled && analysisToolboxPreferences.autoRefresh) {
            triggerAnalysisToolboxRefresh(true, 'Updating analysis toolbox window...');
        } else {
            refreshAnalysisToolboxControls();
        }
    });

    analysisToolboxSigmaInput.addEventListener('change', () => {
        readAnalysisToolboxPreferencesFromUi();
        analysisToolboxLastConfigKey = '';
        if (analysisToolboxPreferences.enabled && analysisToolboxPreferences.autoRefresh) {
            triggerAnalysisToolboxRefresh(true, 'Updating analysis toolbox sigma...');
        } else {
            refreshAnalysisToolboxControls();
        }
    });

    analysisToolboxApplyBtn.addEventListener('click', () => {
        readAnalysisToolboxPreferencesFromUi();
        analysisToolboxLastConfigKey = '';
        if (!analysisToolboxPreferences.enabled) {
            refreshAnalysisToolboxControls();
            return;
        }
        triggerAnalysisToolboxRefresh(true, 'Applying analysis toolbox overlay...');
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
        if (analysisToolboxPreferences.enabled) {
            void refreshAnalysisToolboxOverlays(true);
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
        destroyAnalysisToolboxOverlayCharts(false);
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
            clearVirtualAnalysisSession();
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
        if (virtualAnalysisSession) {
            void applyVirtualPreviewWindow(virtualAnalysisSession);
            updateStatus('Virtual viewport reset (preview mode).');
            return;
        }

        chart?.resetViewport();
        updateStatus('Viewport reset');
    });

    demoBinarySizeInput.addEventListener('input', () => {
        refreshDemoBinaryGeneratorControls();
    });

    demoBinarySizeUnit.addEventListener('change', () => {
        refreshDemoBinaryGeneratorControls();
    });

    sampleRateInput.addEventListener('input', () => {
        refreshDemoBinaryGeneratorControls();
    });

    generateDemoBinaryBtn.addEventListener('click', () => {
        const targetBytes = getDemoBinaryTargetBytes();
        const sampleRate = getNormalizedSampleRateForDemoBinary();

        if (!targetBytes) {
            updateStatus('Demo binary size invalid. Please enter a positive size.');
            refreshDemoBinaryGeneratorControls();
            return;
        }

        if (!sampleRate) {
            updateStatus('Sample rate invalid. Please enter a value > 0 Hz.');
            refreshDemoBinaryGeneratorControls();
            return;
        }

        const sampleCount = Math.max(0, Math.floor((targetBytes - 20) / 4));
        if (sampleCount < 1) {
            updateStatus('Target size is too small for a valid .erosb file.');
            refreshDemoBinaryGeneratorControls();
            return;
        }

        const actualBytes = 20 + sampleCount * 4;
        const durationSeconds = sampleCount / sampleRate;
        const sizeValue = Number.parseFloat(demoBinarySizeInput.value);
        const unit = (demoBinarySizeUnit.value || 'gb').toLowerCase();

        const params = new URLSearchParams({
            size: Number.isFinite(sizeValue) ? String(sizeValue) : '2',
            unit,
            sampleRateHz: String(sampleRate),
        });

        const downloadUrl = `/api/generate-demo-binary?${params.toString()}`;
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();

        updateStatus(
            `Generating demo binary download (${formatBinarySize(actualBytes)}, ${formatDemoGenerationDuration(durationSeconds)} @ ${sampleRate.toLocaleString()} Hz)...`
        );
    });

    loadBinaryBtnServer.addEventListener('click', async () => {
        try {
            updateStatus('Downloading binary from server...');

            const response = await fetch('/api/download');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const contentLength = Number(response.headers.get('content-length') ?? '0');
            const fileName = response.headers.get('x-file-name') ?? 'server-download.erosb';

            let fileBuffer: ArrayBuffer;
            if (response.body) {
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let totalBytes = 0;

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (!value || value.byteLength === 0) continue;

                    // Copy chunk so the backing buffer/offset of the stream chunk cannot surprise us later.
                    chunks.push(value.slice());
                    totalBytes += value.byteLength;
                }

                if (totalBytes === 0) {
                    updateStatus('No binary data received from server.');
                    return;
                }

                const merged = new Uint8Array(totalBytes);
                let offset = 0;
                for (const chunk of chunks) {
                    merged.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                fileBuffer = merged.buffer;
            } else {
                fileBuffer = await response.arrayBuffer();
                if (fileBuffer.byteLength === 0) {
                    updateStatus('No binary data received from server.');
                    return;
                }
            }

            if (contentLength > 0 && contentLength !== fileBuffer.byteLength) {
                console.warn(
                    `Downloaded byte count (${fileBuffer.byteLength}) does not match Content-Length (${contentLength}).`
                );
            }

            const loadedEntries: ImportedBinaryEntry[] = [];
            const failedFiles: string[] = [];

            try {
                const decoded = ErosChart.decodeBinary(fileBuffer);
                loadedEntries.push({
                    fileName,
                    decoded,
                    fileSizeBytes: contentLength > 0 ? contentLength : fileBuffer.byteLength,
                    color: '#00d1ff',
                    visible: true,
                });
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                failedFiles.push(`${fileName} (${message})`);
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

            if (compatibleEntries.length === 1) {
                const singleEntry: ImportedBinaryEntry = {
                    ...compatibleEntries[0],
                    color: getBinaryCurveColor(0),
                    visible: true,
                };

                importedBinaryEntries = [];
                setViewMode('live');
                await createOrReplaceSingleBinaryAnalysisChart(singleEntry);

                sampleRateInput.value = String(referenceSampleRate);
                const singleDuration = referenceSampleRate > 0
                    ? singleEntry.decoded.values.length / referenceSampleRate
                    : 0;
                if (Number.isFinite(singleDuration) && singleDuration > 0) {
                    durationInput.value = Math.max(1, Math.round(singleDuration)).toString();
                }

                isStreaming = false;
                resetStartButtonState();
                refreshDisplayModeControls();

                updateStatus(
                    `Binary loaded into analysis view (${singleEntry.decoded.values.length.toLocaleString()} samples, ${formatBinaryDuration(singleDuration)})`
                );

                if (failedFiles.length > 0) {
                    console.warn('Skipped binary files:', failedFiles);
                }
                return;
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
        }
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
            const virtualImportNotices: string[] = [];
            const decodedResultByFileName = new Map<string, { file: File; decodedResult: BinaryImportDecodeResult }>();

            for (const file of files) {
                try {
                    const decodedResult = await decodeBinaryFileForImport(file);
                    decodedResultByFileName.set(file.name, { file, decodedResult });
                    loadedEntries.push({
                        fileName: file.name,
                        decoded: decodedResult.decoded,
                        fileSizeBytes: file.size,
                        color: '#00d1ff',
                        visible: true,
                    });

                    if (decodedResult.coreMode === 'virtual') {
                        const effectiveSampleRate = decodedResult.decoded.sampleRate;
                        const originalDurationSeconds = decodedResult.originalSampleCount / decodedResult.originalSampleRate;
                        const effectiveDurationSeconds = decodedResult.decoded.values.length / effectiveSampleRate;
                        virtualImportNotices.push(
                            `${file.name}: virtual core (${formatBinarySize(file.size)} > ${formatBinarySize(VIRTUAL_CORE_SWITCH_THRESHOLD_BYTES)}), ` +
                            `downsampled ${decodedResult.sampleStride}x (` +
                            `${decodedResult.originalSampleCount.toLocaleString()} -> ${decodedResult.decoded.values.length.toLocaleString()} samples, ` +
                            `${decodedResult.originalSampleRate.toLocaleString()} Hz -> ${effectiveSampleRate.toLocaleString()} Hz, ` +
                            `${formatDemoGenerationDuration(originalDurationSeconds)} -> ${formatDemoGenerationDuration(effectiveDurationSeconds)})`
                        );
                    }
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

            if (compatibleEntries.length === 1) {
                const singleEntry: ImportedBinaryEntry = {
                    ...compatibleEntries[0],
                    color: getBinaryCurveColor(0),
                    visible: true,
                };

                importedBinaryEntries = [];
                setViewMode('live');
                const virtualSource = decodedResultByFileName.get(singleEntry.fileName);
                let resolvedSampleRateForUi = referenceSampleRate;
                let resolvedDurationSeconds = referenceSampleRate > 0
                    ? singleEntry.decoded.values.length / referenceSampleRate
                    : 0;
                if (virtualSource && virtualSource.decodedResult.coreMode === 'virtual') {
                    await activateVirtualAnalysisSession(singleEntry, virtualSource.file, virtualSource.decodedResult);
                    resolvedSampleRateForUi = Math.max(1, virtualSource.decodedResult.originalSampleRate);
                    resolvedDurationSeconds = virtualSource.decodedResult.originalSampleCount / resolvedSampleRateForUi;
                } else {
                    await createOrReplaceSingleBinaryAnalysisChart(singleEntry);
                }

                sampleRateInput.value = String(resolvedSampleRateForUi);
                if (Number.isFinite(resolvedDurationSeconds) && resolvedDurationSeconds > 0) {
                    durationInput.value = Math.max(1, Math.round(resolvedDurationSeconds)).toString();
                }

                isStreaming = false;
                resetStartButtonState();
                refreshDisplayModeControls();

                updateStatus(
                    `Binary loaded into analysis view (${singleEntry.decoded.values.length.toLocaleString()} samples, ${formatBinaryDuration(resolvedDurationSeconds)})`
                );

                if (virtualImportNotices.length > 0) {
                    console.warn('Virtual core import notices:', virtualImportNotices);
                    updateStatus(
                        `Binary loaded via virtual core (${virtualImportNotices.length} file, threshold ${formatBinarySize(VIRTUAL_CORE_SWITCH_THRESHOLD_BYTES)}).`
                    );
                }

                if (failedFiles.length > 0) {
                    console.warn('Skipped binary files:', failedFiles);
                }
                return;
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

            if (virtualImportNotices.length > 0) {
                console.warn('Virtual core import notices:', virtualImportNotices);
                updateStatus(
                    `Binary compare loaded via virtual core (${virtualImportNotices.length} file(s), threshold ${formatBinarySize(VIRTUAL_CORE_SWITCH_THRESHOLD_BYTES)}).`
                );
            }

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
    refreshDemoBinaryGeneratorControls();
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
