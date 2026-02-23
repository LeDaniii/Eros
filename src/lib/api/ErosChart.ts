/**
 * ErosChart - Haupt-API fÃ¼r High-Performance gRPC Charts
 *
 * VERWENDUNG:
 * ```typescript
 * const chart = new ErosChart('#myCanvas', {
 *   grpcUrl: 'http://localhost:50051',
 *   bufferSize: 100_000,
 *   sampleRate: 10_000
 * });
 *
 * await chart.initialize();
 * await chart.startStream({ duration: 30 });
 * ```
 *
 * ARCHITEKTUR:
 * - ErosChart = Orchestrator (verbindet alle Komponenten)
 * - WebGPURenderer = Rendering
 * - GridOverlay = UI Overlays
 * - SharedRingBuffer = Daten-Speicher
 * - Worker = gRPC Streaming
 */

import { WebGPURenderer } from '../renderer/WebGPURenderer';
import { GridOverlay } from '../renderer/GridOverlay';
import { CrosshairOverlay } from '../renderer/CrosshairOverlay';
import { SharedRingBuffer } from '../core/SharedRingBuffer';

/**
 * Konfigurations-Optionen fÃ¼r ErosChart
 */
export interface ErosChartOptions {
    grpcUrl: string;        // gRPC Server URL (z.B. 'http://localhost:50051')
    bufferSize?: number;    // Wie viele Samples im Buffer? (default: 100_000)
    sampleRate?: number;    // Samples pro Sekunde (default: 10_000 = 10kHz)
    lineColor?: string;     // Linienfarbe als Hex (z.B. '#00ff00', default: grÃ¼n)
    snapEnabled?: boolean;  // Enable crosshair snapping (default: true)
    snapRadiusPx?: number;  // Snap radius in pixels (default: 14)
    snapIndicatorRadiusPx?: number; // Visual radius of snapped point circle (default: 5)
    showGrid?: boolean;     // Show grid overlay (default: true)
    showCrosshair?: boolean; // Show crosshair overlay (default: true)
    enableInteractions?: boolean; // Mouse zoom/pan interactions (default: true)
    enableWorker?: boolean; // Create streaming worker (default: true)
    transparentBackground?: boolean; // Render transparent background (default: false)
}

/**
 * Optionen fÃ¼r Stream-Start
 */
export interface StreamOptions {
    duration?: number;      // Wie lange streamen? (Sekunden, default: 30)
}

export interface ErosBinaryCurve {
    sampleRate: number;
    values: Float32Array;
    version: number;
}

export type ErosChartDisplayMode = 'analysis' | 'live-strip';

export interface ErosChartViewportStrategyState {
    displayMode: ErosChartDisplayMode;
    followLatest: boolean;
    liveWindowDurationSeconds: number;
    isFrozen: boolean;
}

export class ErosChart {
    private static readonly BINARY_MAGIC = new Uint8Array([0x45, 0x52, 0x4f, 0x53]); // "EROS"
    private static readonly BINARY_VERSION = 1;
    private static readonly BINARY_HEADER_SIZE = 20;

    // === Core Components ===
    private canvas: HTMLCanvasElement;
    private renderer: WebGPURenderer | null = null;
    private gridOverlay: GridOverlay | null = null;
    private crosshairOverlay: CrosshairOverlay | null = null;
    private ringBuffer: SharedRingBuffer | null = null;
    private worker: Worker | null = null;

    // === Configuration ===
    private options: Required<ErosChartOptions>;

    // === State ===
    private isStreaming = false;
    private animationFrameId: number | null = null;
    private viewportChangeListener: ((startIndex: number, endIndex: number) => void) | null = null;

    // === Viewport (Zoom/Pan) ===
    private viewportStart = 0;
    private viewportEnd = 0;

    // === Display Mode / Viewport Strategy (P0 foundation; live-strip viewport math follows in a later slice) ===
    private displayMode: ErosChartDisplayMode = 'analysis';
    private viewportStrategy = {
        followLatest: false,
        liveWindowDurationSeconds: 10,
        isFrozen: false,
    };

    /**
     * Erstellt einen neuen ErosChart
     *
     * @param canvasOrSelector - Canvas Element oder CSS Selector (z.B. '#myCanvas')
     * @param options - Konfigurations-Optionen
     */
    constructor(canvasOrSelector: string | HTMLCanvasElement, options: ErosChartOptions) {
        // Canvas auflÃ¶sen (entweder Element direkt oder per Selector)
        if (typeof canvasOrSelector === 'string') {
            const element = document.querySelector(canvasOrSelector);
            if (!element || !(element instanceof HTMLCanvasElement)) {
                throw new Error(`Canvas nicht gefunden: ${canvasOrSelector}`);
            }
            this.canvas = element;
        } else {
            this.canvas = canvasOrSelector;
        }

        // Optionen mit Defaults
        this.options = {
            grpcUrl: options.grpcUrl,
            bufferSize: options.bufferSize ?? 100_000,  // 10 Sekunden @ 10kHz
            sampleRate: options.sampleRate ?? 10_000,   // 10kHz
            lineColor: options.lineColor ?? '#00ff00',  // GrÃ¼n als Default
            snapEnabled: options.snapEnabled ?? true,
            snapRadiusPx: options.snapRadiusPx ?? 14,
            snapIndicatorRadiusPx: options.snapIndicatorRadiusPx ?? 5,
            showGrid: options.showGrid ?? true,
            showCrosshair: options.showCrosshair ?? true,
            enableInteractions: options.enableInteractions ?? true,
            enableWorker: options.enableWorker ?? true,
            transparentBackground: options.transparentBackground ?? false,
        };
    }

    /**
     * Initialisiert WebGPU, Worker und alle Komponenten
     *
     * WICHTIG: Muss VOR startStream() aufgerufen werden!
     */
    async initialize(): Promise<void> {
        console.log('ErosChart: Initialisiere...');

        // ========== CANVAS SETUP ==========
        const container = this.canvas.parentElement;
        if (!container) throw new Error('Canvas muss in einem Container sein!');

        this.canvas.width = container.clientWidth;
        this.canvas.height = container.clientHeight;

        // ========== SHARED RING BUFFER ==========
        // Dieser Buffer wird zwischen Main Thread und Worker geteilt
        this.ringBuffer = new SharedRingBuffer(this.options.bufferSize);
        this.viewportEnd = this.options.bufferSize;

        // ========== WEBGPU RENDERER ==========
        this.renderer = new WebGPURenderer(this.canvas);
        await this.renderer.initialize();
        this.renderer.setDataSource(this.ringBuffer);
        this.renderer.setLineColor(this.options.lineColor);  // Setze Linienfarbe
        this.renderer.setTransparentBackground(this.options.transparentBackground);

        // ========== GRID OVERLAY ==========
        if (this.options.showGrid) {
            this.gridOverlay = new GridOverlay(this.canvas);
        }

        // ========== CROSSHAIR OVERLAY ==========
        if (this.options.showCrosshair) {
            this.crosshairOverlay = new CrosshairOverlay(
                this.canvas,
                this.ringBuffer,
                this.options.sampleRate,
                {
                    snapEnabled: this.options.snapEnabled,
                    snapRadiusPx: this.options.snapRadiusPx,
                    snapIndicatorRadiusPx: this.options.snapIndicatorRadiusPx,
                }
            );
        }

        // ========== WEB WORKER ==========
        // Worker holt gRPC Daten im Hintergrund
        if (this.options.enableWorker) {
            this.worker = new Worker(
                new URL('../worker/data.worker.ts', import.meta.url),
                { type: 'module' }
            );

            // Schicke SharedArrayBuffer an Worker
            this.worker.postMessage({
                buffer: this.ringBuffer.buffer,
                head: this.ringBuffer.head
            });
        }

        // ========== ZOOM & PAN ==========
        if (this.options.enableInteractions) {
            this.setupInteractions();
        }

        // ========== RESIZE HANDLER ==========
        this.setupResize();

        // ========== RENDER LOOP ==========
        this.startRenderLoop();

        console.log('ErosChart: Initialisierung abgeschlossen!');
    }

    /**
     * Startet den gRPC Stream
     *
     * @param options - Stream-Optionen (duration, etc.)
     */
    async startStream(options: StreamOptions = {}): Promise<void> {
        if (this.isStreaming) {
            console.warn('ErosChart: Stream lÃ¤uft bereits!');
            return;
        }

        if (!this.worker) {
            throw new Error('ErosChart: Streaming worker is disabled or initialize() was not called.');
        }

        const duration = options.duration ?? 30;

        try {
            // Server konfigurieren
            console.log(`ErosChart: Konfiguriere Server (${duration}s @ ${this.options.sampleRate} Hz)...`);
            await this.configureServer(duration, this.options.sampleRate);

            // Worker Signal: Start streaming!
            this.worker.postMessage({ type: 'start' });

            this.isStreaming = true;
            console.log('ErosChart: Stream gestartet!');

            // Auto-Stop nach duration
            setTimeout(() => {
                this.isStreaming = false;
                console.log('ErosChart: Stream beendet.');
            }, duration * 1000 + 2000);  // +2s Buffer

        } catch (error) {
            console.error('ErosChart: Stream-Fehler:', error);
            this.isStreaming = false;
            throw error;
        }
    }

    /**
     * Setzt Zoom/Pan manuell
     *
     * @param startIndex - Erster sichtbarer Sample
     * @param endIndex - Letzter sichtbarer Sample
     */
    setViewport(startIndex: number, endIndex: number): void {
        this.viewportStart = startIndex;
        this.viewportEnd = endIndex;
        this.renderer?.setViewport(startIndex, endIndex);

        // Update Crosshair Viewport
        if (this.renderer && this.crosshairOverlay) {
            const viewport = this.renderer.getViewport();
            this.crosshairOverlay.updateViewport(
                startIndex,
                endIndex,
                viewport.minValue,
                viewport.maxValue
            );
        }

        this.emitViewportChanged();
    }

    /**
     * ZurÃ¼cksetzen auf vollstÃ¤ndige Ansicht
     */
    resetViewport(): void {
        this.viewportStart = 0;
        this.viewportEnd = this.options.bufferSize;
        this.renderer?.resetViewport();
        this.emitViewportChanged();
    }

    public getViewportRange(): { startIndex: number; endIndex: number } {
        return {
            startIndex: this.viewportStart,
            endIndex: this.viewportEnd,
        };
    }

    public setViewportChangeListener(listener: ((startIndex: number, endIndex: number) => void) | null): void {
        this.viewportChangeListener = listener;
    }

    public setDisplayMode(mode: ErosChartDisplayMode): void {
        if (this.displayMode === mode) {
            return;
        }

        this.displayMode = mode;

        if (mode === 'analysis') {
            this.viewportStrategy.followLatest = false;
            this.viewportStrategy.isFrozen = false;
            return;
        }

        // Live-strip defaults to follow-latest unless explicitly frozen later.
        if (!this.viewportStrategy.isFrozen) {
            this.viewportStrategy.followLatest = true;
        }
    }

    public getDisplayMode(): ErosChartDisplayMode {
        return this.displayMode;
    }

    public setFollowLatest(enabled: boolean): void {
        this.viewportStrategy.followLatest = enabled;
        if (enabled) {
            this.viewportStrategy.isFrozen = false;
        }
    }

    public getFollowLatest(): boolean {
        return this.viewportStrategy.followLatest;
    }

    public setLiveWindowDuration(seconds: number): void {
        if (!Number.isFinite(seconds) || seconds <= 0) {
            return;
        }

        this.viewportStrategy.liveWindowDurationSeconds = seconds;
    }

    public getLiveWindowDuration(): number {
        return this.viewportStrategy.liveWindowDurationSeconds;
    }

    public freeze(): void {
        if (this.displayMode !== 'live-strip') {
            return;
        }

        this.viewportStrategy.isFrozen = true;
        this.viewportStrategy.followLatest = false;
    }

    public resumeFollowLatest(): void {
        if (this.displayMode !== 'live-strip') {
            return;
        }

        this.viewportStrategy.isFrozen = false;
        this.viewportStrategy.followLatest = true;
    }

    public getViewportStrategyState(): ErosChartViewportStrategyState {
        return {
            displayMode: this.displayMode,
            followLatest: this.viewportStrategy.followLatest,
            liveWindowDurationSeconds: this.viewportStrategy.liveWindowDurationSeconds,
            isFrozen: this.viewportStrategy.isFrozen,
        };
    }

    public setLineColor(lineColor: string): void {
        this.options.lineColor = lineColor;
        this.renderer?.setLineColor(lineColor);
    }

    public setYRangeOverride(minValue: number, maxValue: number): void {
        if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue >= maxValue) {
            return;
        }
        this.renderer?.setYRangeOverride(minValue, maxValue);
    }

    public clearYRangeOverride(): void {
        this.renderer?.clearYRangeOverride();
    }

    public setCrosshairSnapSeries(series: Array<{ values: ArrayLike<number>; visible?: boolean; color?: string }> | null): void {
        this.crosshairOverlay?.setSnapSeries(series);
    }

    /**
     * Gibt aktuelle Statistiken zurÃ¼ck
     */
    getStats(): { totalSamples: number; visibleSamples: number; bufferSize: number; isDownsampled: boolean; renderedVertices: number } {
        const totalSamples = this.ringBuffer?.currentHead ?? 0;
        const visibleSamples = Math.floor(this.viewportEnd - this.viewportStart);
        const dsResult = this.renderer?.getLastDownsampleResult();

        return {
            totalSamples,
            visibleSamples,
            bufferSize: this.options.bufferSize,
            isDownsampled: dsResult?.isDownsampled ?? false,
            renderedVertices: dsResult?.vertexCount ?? visibleSamples,
        };
    }

    /**
     * Export current chart samples to the native EROS binary format (.erosb).
     */
    exportBinary(): ArrayBuffer {
        if (!this.ringBuffer) {
            throw new Error('ErosChart: initialize() must be called before export.');
        }

        const sampleCount = Math.max(0, Math.min(this.ringBuffer.currentHead, this.ringBuffer.data.length));
        if (sampleCount < 1) {
            throw new Error('ErosChart: no samples available for export.');
        }

        const values = this.ringBuffer.data.slice(0, sampleCount);
        return ErosChart.encodeBinary(values, this.options.sampleRate);
    }

    /**
     * Load sample data into the chart memory and update viewport.
     */
    loadData(values: Float32Array): void {
        if (!this.ringBuffer || !this.renderer) {
            throw new Error('ErosChart: initialize() must be called before loadData().');
        }

        const target = this.ringBuffer.data;
        const sampleCount = Math.max(0, Math.min(values.length, target.length));

        target.fill(0);
        if (sampleCount > 0) {
            target.set(values.subarray(0, sampleCount), 0);
        }

        Atomics.store(this.ringBuffer.head, 0, sampleCount);

        this.viewportStart = 0;
        this.viewportEnd = Math.max(sampleCount, 1);
        this.renderer.setViewport(this.viewportStart, this.viewportEnd);
        this.emitViewportChanged();

        // Keep crosshair values coherent immediately after import, before next render frame.
        if (this.crosshairOverlay) {
            let minValue = Infinity;
            let maxValue = -Infinity;

            for (let i = 0; i < sampleCount; i++) {
                const v = target[i];
                if (v < minValue) minValue = v;
                if (v > maxValue) maxValue = v;
            }

            if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
                minValue = -2.5;
                maxValue = 2.5;
            } else if (minValue === maxValue) {
                minValue -= 0.5;
                maxValue += 0.5;
            } else {
                const padding = (maxValue - minValue) * 0.05;
                minValue -= padding;
                maxValue += padding;
            }

            this.crosshairOverlay.updateViewport(
                this.viewportStart,
                this.viewportEnd,
                minValue,
                maxValue
            );
        }
    }

    /**
     * Decode EROS binary data (.erosb) to samples.
     */
    static decodeBinary(fileBuffer: ArrayBuffer): ErosBinaryCurve {
        if (fileBuffer.byteLength < ErosChart.BINARY_HEADER_SIZE) {
            throw new Error('Invalid EROS file: file too small.');
        }

        const bytes = new Uint8Array(fileBuffer);
        for (let i = 0; i < ErosChart.BINARY_MAGIC.length; i++) {
            if (bytes[i] !== ErosChart.BINARY_MAGIC[i]) {
                throw new Error('Invalid EROS file: magic header mismatch.');
            }
        }

        const view = new DataView(fileBuffer);
        const version = view.getUint16(4, true);
        if (version !== ErosChart.BINARY_VERSION) {
            throw new Error(`Unsupported EROS file version: ${version}.`);
        }

        const sampleRate = view.getUint32(8, true);
        const sampleCount = view.getUint32(12, true);
        if (sampleRate < 1) {
            throw new Error('Invalid EROS file: sampleRate must be > 0.');
        }

        const expectedSize = ErosChart.BINARY_HEADER_SIZE + sampleCount * 4;
        if (fileBuffer.byteLength !== expectedSize) {
            throw new Error('Invalid EROS file: payload size mismatch.');
        }

        const values = new Float32Array(sampleCount);
        values.set(new Float32Array(fileBuffer, ErosChart.BINARY_HEADER_SIZE, sampleCount));

        return { sampleRate, values, version };
    }

    /**
     * Stoppt Rendering und gibt Ressourcen frei
     */
    destroy(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this.viewportChangeListener = null;
        this.crosshairOverlay?.destroy();
        this.gridOverlay?.destroy();
        this.worker?.terminate();
        console.log('ErosChart: ZerstÃ¶rt.');
    }

    // ========================================
    // PRIVATE METHODS
    // ========================================

    /**
     * Konfiguriert den gRPC Server via REST API
     */
    private async configureServer(durationSeconds: number, sampleRateHz: number): Promise<void> {
        const response = await fetch(`${this.options.grpcUrl}/api/configure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ durationSeconds, sampleRateHz }),
        });

        if (!response.ok) {
            throw new Error(`Server-Konfiguration fehlgeschlagen: ${response.statusText}`);
        }
    }

    /**
     * Setup: Zoom mit Mausrad, Pan mit Drag
     */
    private setupInteractions(): void {
        let isDragging = false;
        let dragStartX = 0;
        let dragStartViewportStart = 0;
        let dragStartViewportEnd = 0;

        // ========== ZOOM (Mausrad) ==========
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();

            const rect = this.canvas.getBoundingClientRect();
            const mouseX = (e.clientX - rect.left) / rect.width;  // 0..1

            const currentRange = this.viewportEnd - this.viewportStart;
            const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;  // In/Out
            const newRange = Math.max(100, Math.min(this.options.bufferSize, currentRange * zoomFactor));

            // Zoom zum Mauszeiger
            const anchorSample = this.viewportStart + mouseX * currentRange;
            this.viewportStart = Math.floor(anchorSample - mouseX * newRange);
            this.viewportEnd = this.viewportStart + newRange;

            // Begrenzen
            if (this.viewportStart < 0) {
                this.viewportStart = 0;
                this.viewportEnd = newRange;
            }
            if (this.viewportEnd > this.ringBuffer!.currentHead) {
                this.viewportEnd = this.ringBuffer!.currentHead;
                this.viewportStart = Math.max(0, this.viewportEnd - newRange);
            }

            this.renderer!.setViewport(this.viewportStart, this.viewportEnd);

            // Update Crosshair Viewport
            if (this.crosshairOverlay) {
                const viewport = this.renderer!.getViewport();
                this.crosshairOverlay.updateViewport(
                    this.viewportStart,
                    this.viewportEnd,
                    viewport.minValue,
                    viewport.maxValue
                );
            }

            this.emitViewportChanged();
        }, { passive: false });

        // ========== PAN (Drag) ==========
        this.canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            dragStartX = e.clientX;
            dragStartViewportStart = this.viewportStart;
            dragStartViewportEnd = this.viewportEnd;
            this.canvas.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const rect = this.canvas.getBoundingClientRect();
            const deltaX = e.clientX - dragStartX;
            const deltaSamples = -Math.floor((deltaX / rect.width) * (dragStartViewportEnd - dragStartViewportStart));

            this.viewportStart = dragStartViewportStart + deltaSamples;
            this.viewportEnd = dragStartViewportEnd + deltaSamples;

            // Begrenzen
            if (this.viewportStart < 0) {
                const shift = -this.viewportStart;
                this.viewportStart = 0;
                this.viewportEnd += shift;
            }
            if (this.viewportEnd > this.ringBuffer!.currentHead) {
                const shift = this.viewportEnd - this.ringBuffer!.currentHead;
                this.viewportEnd = this.ringBuffer!.currentHead;
                this.viewportStart -= shift;
            }

            this.renderer!.setViewport(this.viewportStart, this.viewportEnd);

            // Update Crosshair Viewport
            if (this.crosshairOverlay) {
                const viewport = this.renderer!.getViewport();
                this.crosshairOverlay.updateViewport(
                    this.viewportStart,
                    this.viewportEnd,
                    viewport.minValue,
                    viewport.maxValue
                );
            }

            this.emitViewportChanged();
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
            this.canvas.style.cursor = 'default';
        });
    }

    /**
     * Setup: Canvas Resize Handler
     */
    private setupResize(): void {
        window.addEventListener('resize', () => {
            const container = this.canvas.parentElement;
            if (!container) return;

            const w = container.clientWidth;
            const h = container.clientHeight;

            this.renderer?.resize(w, h);
            this.gridOverlay?.resize(w, h);
            this.crosshairOverlay?.resize();
        });
    }

    /**
     * Render Loop - lÃ¤uft mit 60fps
     */
    private startRenderLoop(): void {
        let lastGridUpdate = 0;

        const frame = (now: number) => {
            this.applyViewportStrategyFrame();

            // WebGPU Rendering (jeden Frame)
            this.renderer?.render();

            // Grid update at ~30 FPS for responsive axis labels while zooming/panning.
            if (now - lastGridUpdate > 33) {
                const currentHead = this.ringBuffer!.currentHead;
                const start = Math.max(0, this.viewportStart);
                const end = Math.max(start + 1, Math.min(Math.max(currentHead, 1), this.viewportEnd));
                const visibleSamples = Math.max(1, end - start);

                if (currentHead > 0) {
                    // Min/Max vom Downsampler Ã¼bernehmen (statt eigener Loop!)
                    const dsResult = this.renderer?.getLastDownsampleResult();
                    if (dsResult && this.renderer) {
                        const viewport = this.renderer.getViewport();
                        this.gridOverlay?.draw(
                            viewport.minValue,
                            viewport.maxValue,
                            visibleSamples,
                            this.options.sampleRate,
                            start
                        );
                    } else {
                        this.gridOverlay?.draw(
                            -2.5,
                            2.5,
                            visibleSamples,
                            this.options.sampleRate,
                            start
                        );
                    }
                } else {
                    this.gridOverlay?.draw(
                        -2.5,
                        2.5,
                        this.options.bufferSize,
                        this.options.sampleRate,
                        0
                    );
                }

                lastGridUpdate = now;
            }

            this.animationFrameId = requestAnimationFrame(frame);
        };

        this.animationFrameId = requestAnimationFrame(frame);
    }

    /**
     * Foundation hook for display-mode-dependent viewport policies.
     * Live-strip fixed-window follow behavior is added in the next implementation slice.
     */
    private applyViewportStrategyFrame(): void {
        if (this.displayMode !== 'live-strip') {
            return;
        }

        if (this.viewportStrategy.isFrozen || !this.viewportStrategy.followLatest) {
            return;
        }

        // Intentionally no-op for now:
        // ticket 2 will compute and apply the fixed-duration follow-latest viewport here.
    }

    private static encodeBinary(values: Float32Array, sampleRate: number): ArrayBuffer {
        const normalizedSampleRate = Math.max(1, Math.floor(sampleRate));
        const headerSize = ErosChart.BINARY_HEADER_SIZE;
        const buffer = new ArrayBuffer(headerSize + values.length * 4);

        const bytes = new Uint8Array(buffer);
        bytes.set(ErosChart.BINARY_MAGIC, 0);

        const view = new DataView(buffer);
        view.setUint16(4, ErosChart.BINARY_VERSION, true);
        view.setUint16(6, 0, true); // flags/reserved
        view.setUint32(8, normalizedSampleRate, true);
        view.setUint32(12, values.length, true);
        view.setUint32(16, 0, true); // reserved

        new Float32Array(buffer, headerSize, values.length).set(values);
        return buffer;
    }

    private emitViewportChanged(): void {
        this.viewportChangeListener?.(this.viewportStart, this.viewportEnd);
    }
}


