/**
 * ErosChart - Haupt-API für High-Performance gRPC Charts
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
 * Konfigurations-Optionen für ErosChart
 */
export interface ErosChartOptions {
    grpcUrl: string;        // gRPC Server URL (z.B. 'http://localhost:50051')
    bufferSize?: number;    // Wie viele Samples im Buffer? (default: 100_000)
    sampleRate?: number;    // Samples pro Sekunde (default: 10_000 = 10kHz)
    lineColor?: string;     // Linienfarbe als Hex (z.B. '#00ff00', default: grün)
}

/**
 * Optionen für Stream-Start
 */
export interface StreamOptions {
    duration?: number;      // Wie lange streamen? (Sekunden, default: 30)
}

export class ErosChart {
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

    // === Viewport (Zoom/Pan) ===
    private viewportStart = 0;
    private viewportEnd = 0;

    /**
     * Erstellt einen neuen ErosChart
     *
     * @param canvasOrSelector - Canvas Element oder CSS Selector (z.B. '#myCanvas')
     * @param options - Konfigurations-Optionen
     */
    constructor(canvasOrSelector: string | HTMLCanvasElement, options: ErosChartOptions) {
        // Canvas auflösen (entweder Element direkt oder per Selector)
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
            lineColor: options.lineColor ?? '#00ff00',  // Grün als Default
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

        // ========== GRID OVERLAY ==========
        this.gridOverlay = new GridOverlay(this.canvas);

        // ========== CROSSHAIR OVERLAY ==========
        this.crosshairOverlay = new CrosshairOverlay(
            this.canvas,
            this.ringBuffer,
            this.options.sampleRate
        );

        // ========== WEB WORKER ==========
        // Worker holt gRPC Daten im Hintergrund
        this.worker = new Worker(
            new URL('../worker/data.worker.ts', import.meta.url),
            { type: 'module' }
        );

        // Schicke SharedArrayBuffer an Worker
        this.worker.postMessage({
            buffer: this.ringBuffer.buffer,
            head: this.ringBuffer.head
        });

        // ========== ZOOM & PAN ==========
        this.setupInteractions();

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
            console.warn('ErosChart: Stream läuft bereits!');
            return;
        }

        if (!this.worker) {
            throw new Error('ErosChart: initialize() wurde nicht aufgerufen!');
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
    }

    /**
     * Zurücksetzen auf vollständige Ansicht
     */
    resetViewport(): void {
        this.viewportStart = 0;
        this.viewportEnd = this.options.bufferSize;
        this.renderer?.resetViewport();
    }

    /**
     * Gibt aktuelle Statistiken zurück
     */
    getStats(): { totalSamples: number; visibleSamples: number; bufferSize: number } {
        const totalSamples = this.ringBuffer?.currentHead ?? 0;
        const visibleSamples = Math.floor(this.viewportEnd - this.viewportStart);

        return {
            totalSamples,           // Wie viele Samples insgesamt empfangen wurden
            visibleSamples,         // Wie viele Samples gerade sichtbar sind (Zoom)
            bufferSize: this.options.bufferSize  // Buffer-Kapazität
        };
    }

    /**
     * Stoppt Rendering und gibt Ressourcen frei
     */
    destroy(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this.worker?.terminate();
        console.log('ErosChart: Zerstört.');
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
     * Render Loop - läuft mit 60fps
     */
    private startRenderLoop(): void {
        let lastGridUpdate = 0;

        const frame = (now: number) => {
            // WebGPU Rendering (jeden Frame)
            this.renderer?.render();

            // Grid Update (nur alle 100ms, spart Performance)
            if (now - lastGridUpdate > 100) {
                const currentHead = this.ringBuffer!.currentHead;

                if (currentHead > 0) {
                    // Finde Min/Max für Grid
                    let min = Infinity, max = -Infinity;
                    const start = Math.max(0, this.viewportStart);
                    const end = Math.min(currentHead, this.viewportEnd);

                    for (let i = start; i < end; i++) {
                        const v = this.ringBuffer!.data[i];
                        if (v < min) min = v;
                        if (v > max) max = v;
                    }

                    if (min === Infinity) min = -2.5;
                    if (max === -Infinity) max = 2.5;

                    this.gridOverlay?.draw(min, max, end - start, this.options.sampleRate);
                } else {
                    this.gridOverlay?.draw(-2.5, 2.5, this.options.bufferSize, this.options.sampleRate);
                }

                lastGridUpdate = now;
            }

            this.animationFrameId = requestAnimationFrame(frame);
        };

        this.animationFrameId = requestAnimationFrame(frame);
    }
}
