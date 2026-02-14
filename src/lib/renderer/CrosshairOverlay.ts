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
        console.log(`Crosshair: mouseX=${this.mouseX}, mouseY=${this.mouseY}`);
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
     * Crosshair zeichnen
     */
    public draw(): void {
        this.clear();

        // Nur zeichnen wenn Maus innerhalb Canvas
        if (this.mouseX < 0 || this.mouseY < 0) {
            console.log('Crosshair: Mouse outside canvas');
            return;
        }

        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;

        console.log(`Crosshair: Drawing at ${this.mouseX},${this.mouseY} on canvas ${width}x${height}`);

        // ========== Werte berechnen ==========
        const timeValue = this.getTimeAtX(this.mouseX);
        const yValue = this.getYValueAtX(this.mouseX);

        // ========== Crosshair Linien zeichnen ==========
        ctx.strokeStyle = this.lineColor;
        ctx.lineWidth = this.lineWidth;
        ctx.setLineDash([5, 5]);  // Gestrichelte Linie (5px an, 5px aus)

        ctx.beginPath();
        // Vertikale Linie
        ctx.moveTo(this.mouseX, 0);
        ctx.lineTo(this.mouseX, height);
        // Horizontale Linie
        ctx.moveTo(0, this.mouseY);
        ctx.lineTo(width, this.mouseY);
        ctx.stroke();

        ctx.setLineDash([]);  // Reset zu durchgezogener Linie

        // ========== Text zeichnen ==========
        ctx.fillStyle = this.textColor;
        ctx.font = `${this.fontSize}px monospace`;

        // Zeit-Text (oben rechts an vertikaler Linie)
        const timeText = `t: ${timeValue.toFixed(4)}s`;
        const timeMetrics = ctx.measureText(timeText);
        const timeX = this.mouseX + 8;  // 8px Abstand von Linie
        const timeY = 15;

        // Hintergrund für bessere Lesbarkeit
        this.drawTextBackground(ctx, timeX, timeY, timeMetrics.width, this.fontSize);
        ctx.fillText(timeText, timeX, timeY);

        // Y-Wert Text (links an horizontaler Linie)
        const yText = `y: ${yValue.toFixed(3)}`;
        const yMetrics = ctx.measureText(yText);
        const yX = 8;
        const yY = this.mouseY - 5;

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
     * Berechne Zeit (in Sekunden) für X-Position
     */
    private getTimeAtX(x: number): number {
        const width = this.canvas.width;
        const progress = x / width;  // 0.0 bis 1.0

        const sampleIndex = this.viewport.startIndex +
            progress * (this.viewport.endIndex - this.viewport.startIndex);

        return sampleIndex / this.sampleRate;
    }

    /**
     * Berechne Y-Wert für X-Position
     */
    private getYValueAtX(x: number): number {
        const width = this.canvas.width;
        const progress = x / width;

        const sampleIndex = this.viewport.startIndex +
            progress * (this.viewport.endIndex - this.viewport.startIndex);

        // Sample Index abrunden/aufrunden für Interpolation
        const indexFloor = Math.floor(sampleIndex);
        const indexCeil = Math.ceil(sampleIndex);

        // Samples aus Buffer lesen
        const valueFloor = this.buffer.get(indexFloor);
        const valueCeil = this.buffer.get(indexCeil);

        // Linear interpolieren
        const fraction = sampleIndex - indexFloor;
        return valueFloor + (valueCeil - valueFloor) * fraction;
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
