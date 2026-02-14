/**
 * CrosshairOverlay.ts
 *
 * Canvas2D Overlay für interaktives Crosshair (Fadenkreuz)
 *
 * WAS macht diese Klasse?
 * - Zeigt vertikale + horizontale Linie an der Maus-Position
 * - Zeigt Zeit (X) und Y-Wert an der Cursor-Position
 * - Nutzt Canvas2D (kein WebGPU nötig für UI-Elemente)
 *
 * WARUM Canvas2D statt WebGPU?
 * - Crosshair ist UI, kein Daten-Rendering
 * - Canvas2D ist einfacher für Linien + Text
 * - WebGPU wäre Overkill (zu komplex für simple Linien)
 *
 * WIE funktioniert's?
 * - Overlay Canvas liegt ÜBER dem WebGPU Canvas
 * - pointer-events: none → Maus-Events gehen durch zum WebGPU Canvas
 * - mousemove Event trackt Cursor-Position
 * - Interpoliert Y-Wert aus SharedArrayBuffer
 */

import { SharedRingBuffer } from '../core/SharedRingBuffer';

export interface CrosshairOptions {
    lineColor?: string;      // Farbe der Crosshair-Linien (default: '#00ff00')
    textColor?: string;      // Farbe des Werte-Texts (default: '#00ff00')
    lineWidth?: number;      // Dicke der Linien (default: 1)
    fontSize?: number;       // Schriftgröße (default: 12)
}

export class CrosshairOverlay {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private parentCanvas: HTMLCanvasElement;
    private buffer: SharedRingBuffer;
    private sampleRate: number;

    private mouseX: number = -1;  // -1 = außerhalb
    private mouseY: number = -1;

    private lineColor: string;
    private textColor: string;
    private lineWidth: number;
    private fontSize: number;

    // Viewport Info (wird von ErosChart gesetzt)
    private viewport = {
        startIndex: 0,
        endIndex: 100_000,
        minValue: -2.5,
        maxValue: 2.5,
    };

    constructor(
        parentCanvas: HTMLCanvasElement,
        buffer: SharedRingBuffer,
        sampleRate: number,
        options: CrosshairOptions = {}
    ) {
        this.parentCanvas = parentCanvas;
        this.buffer = buffer;
        this.sampleRate = sampleRate;

        // Options mit Defaults
        this.lineColor = options.lineColor ?? '#00ff00';
        this.textColor = options.textColor ?? '#00ff00';
        this.lineWidth = options.lineWidth ?? 1;
        this.fontSize = options.fontSize ?? 12;

        // ========== Canvas2D Overlay erstellen ==========
        // Liegt ÜBER dem WebGPU Canvas (position: absolute)
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.pointerEvents = 'none';  // Maus-Events gehen durch!
        this.canvas.style.zIndex = '10';  // Über WebGPU Canvas

        const ctx = this.canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas2D Context nicht verfügbar');
        }
        this.ctx = ctx;

        // Canvas an Parent Container hängen
        const container = parentCanvas.parentElement;
        if (!container) {
            throw new Error('Parent Canvas hat keinen Container');
        }
        container.appendChild(this.canvas);

        // ========== Canvas Size = Parent Size ==========
        this.resize();

        // ========== Maus-Tracking ==========
        // WICHTIG: Event Listener am PARENT Canvas (weil Overlay pointer-events: none hat)
        this.parentCanvas.addEventListener('mousemove', this.onMouseMove.bind(this));
        this.parentCanvas.addEventListener('mouseleave', this.onMouseLeave.bind(this));
    }

    /**
     * Canvas-Größe an Parent anpassen
     * Wird bei Window-Resize aufgerufen
     */
    public resize(): void {
        const rect = this.parentCanvas.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
    }

    /**
     * Viewport Update von ErosChart
     * Wird aufgerufen wenn User zoomt/pant
     */
    public updateViewport(startIndex: number, endIndex: number, minValue: number, maxValue: number): void {
        this.viewport.startIndex = startIndex;
        this.viewport.endIndex = endIndex;
        this.viewport.minValue = minValue;
        this.viewport.maxValue = maxValue;
    }

    /**
     * Mouse Move Event Handler
     */
    private onMouseMove(event: MouseEvent): void {
        const rect = this.parentCanvas.getBoundingClientRect();
        this.mouseX = event.clientX - rect.left;
        this.mouseY = event.clientY - rect.top;
        this.draw();  // Redraw mit neuer Position
    }

    /**
     * Mouse Leave Event Handler
     */
    private onMouseLeave(): void {
        this.mouseX = -1;
        this.mouseY = -1;
        this.clear();  // Crosshair ausblenden
    }

    /**
     * Crosshair zeichnen (MIT SNAPPING!)
     */
    public draw(): void {
        this.clear();

        // Nur zeichnen wenn Maus innerhalb Canvas
        if (this.mouseX < 0 || this.mouseY < 0) {
            return;
        }

        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;

        // ========== SNAPPING: Finde nächsten Datenpunkt ==========
        const snapIndex = this.getSnapIndexAtX(this.mouseX);
        const snapX = this.getXForIndex(snapIndex);  // X-Position vom Datenpunkt
        const yValue = this.getYValueAtIndex(snapIndex);  // Exakter Y-Wert
        const timeValue = this.getTimeAtIndex(snapIndex);  // Exakte Zeit

        // Y-Position vom Datenpunkt berechnen (wie im Shader!)
        const valueRange = this.viewport.maxValue - this.viewport.minValue;
        const normalizedY = (yValue - this.viewport.minValue) / valueRange;  // 0.0 bis 1.0
        const snapY = height - (normalizedY * height);  // Canvas Y ist invertiert (0 = oben)

        // ========== Crosshair Linien zeichnen (an Datenpunkt-Position!) ==========
        ctx.strokeStyle = this.lineColor;
        ctx.lineWidth = this.lineWidth;
        ctx.setLineDash([5, 5]);  // Gestrichelte Linie (5px an, 5px aus)

        ctx.beginPath();
        // Vertikale Linie (an snapX statt mouseX!)
        ctx.moveTo(snapX, 0);
        ctx.lineTo(snapX, height);
        // Horizontale Linie (an snapY statt mouseY!)
        ctx.moveTo(0, snapY);
        ctx.lineTo(width, snapY);
        ctx.stroke();

        ctx.setLineDash([]);  // Reset zu durchgezogener Linie

        // ========== Datenpunkt-Marker (kleiner Kreis) ==========
        ctx.fillStyle = this.lineColor;
        ctx.beginPath();
        ctx.arc(snapX, snapY, 4, 0, 2 * Math.PI);  // Kreis mit Radius 4px
        ctx.fill();

        // ========== Text zeichnen ==========
        ctx.fillStyle = this.textColor;
        ctx.font = `${this.fontSize}px monospace`;

        // Zeit-Text (oben rechts an vertikaler Linie)
        const timeText = `t: ${timeValue.toFixed(4)}s`;
        const timeMetrics = ctx.measureText(timeText);
        const timeX = snapX + 8;  // 8px Abstand von Linie
        const timeY = 15;

        // Hintergrund für bessere Lesbarkeit
        this.drawTextBackground(ctx, timeX, timeY, timeMetrics.width, this.fontSize);
        ctx.fillText(timeText, timeX, timeY);

        // Y-Wert Text (links an horizontaler Linie)
        const yText = `y: ${yValue.toFixed(3)}`;
        const yMetrics = ctx.measureText(yText);
        const yX = 8;
        const yY = snapY - 5;

        this.drawTextBackground(ctx, yX, yY, yMetrics.width, this.fontSize);
        ctx.fillText(yText, yX, yY);
    }

    /**
     * Hintergrund-Box für Text (für bessere Lesbarkeit)
     */
    private drawTextBackground(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';  // Halbtransparent schwarz
        ctx.fillRect(x - 3, y - height, width + 6, height + 4);
        ctx.fillStyle = this.textColor;  // Zurück zur Text-Farbe
    }

    /**
     * Finde nächsten Sample-Index für X-Position (SNAPPING!)
     *
     * WIE funktioniert's?
     * - X-Position → Sample Index (float)
     * - Runde auf nächsten ganzzahligen Index (= Snap!)
     * - Rückgabe: Exakter Sample-Index
     */
    private getSnapIndexAtX(x: number): number {
        const width = this.canvas.width;
        const progress = x / width;  // 0.0 bis 1.0

        const sampleIndex = this.viewport.startIndex +
            progress * (this.viewport.endIndex - this.viewport.startIndex);

        // SNAP: Runde auf nächsten ganzzahligen Sample-Index
        return Math.round(sampleIndex);
    }

    /**
     * Berechne Zeit (in Sekunden) für Sample-Index
     */
    private getTimeAtIndex(index: number): number {
        return index / this.sampleRate;
    }

    /**
     * Berechne Y-Wert für Sample-Index (KEIN Interpolieren!)
     */
    private getYValueAtIndex(index: number): number {
        // Lese exakten Wert aus Buffer (kein Interpolieren!)
        return this.buffer.get(index);
    }

    /**
     * Berechne X-Position für Sample-Index (für Crosshair-Linie)
     *
     * WIE funktioniert's?
     * - Sample Index → Progress im Viewport
     * - Progress → X-Pixel Position
     */
    private getXForIndex(index: number): number {
        const width = this.canvas.width;
        const progress = (index - this.viewport.startIndex) /
            (this.viewport.endIndex - this.viewport.startIndex);
        return progress * width;
    }

    /**
     * Canvas löschen
     */
    private clear(): void {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Cleanup (wird bei destroy aufgerufen)
     */
    public destroy(): void {
        this.canvas.remove();
    }
}
