/**
 * GridOverlay - Zeichnet Achsen, Beschriftungen und Grid
 *
 * WARUM Canvas2D hier statt WebGPU?
 * - WebGPU ist für VIELE Datenpunkte (Millionen)
 * - Grid hat nur ~20 Linien + Text
 * - Canvas2D ist einfacher für Text und UI-Elemente
 *
 * WIE funktioniert das Overlay?
 * - Zweiter Canvas über dem WebGPU Canvas (position: absolute)
 * - Transparent (pointerEvents: none)
 * - Wird nur bei Änderungen neu gezeichnet (nicht 60fps!)
 */
export class GridOverlay {
    private overlayCanvas: HTMLCanvasElement;  // Separater Canvas für UI
    private ctx: CanvasRenderingContext2D;     // Canvas2D Kontext (für Linien + Text)

    constructor(mainCanvas: HTMLCanvasElement) {
        // Erstelle zweiten Canvas (liegt ÜBER dem WebGPU Canvas)
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.width = mainCanvas.width;
        this.overlayCanvas.height = mainCanvas.height;

        // CSS: Positioniere über WebGPU Canvas
        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.pointerEvents = 'none';  // Klicks gehen durch zum WebGPU Canvas

        // Füge in den gleichen Container ein
        mainCanvas.parentElement?.appendChild(this.overlayCanvas);
        this.ctx = this.overlayCanvas.getContext('2d')!;
    }

    /**
     * Zeichnet Grid, Achsen und Beschriftungen
     *
     * @param minValue - Y-Achse Minimum (aus Auto-Scaling)
     * @param maxValue - Y-Achse Maximum (aus Auto-Scaling)
     * @param totalSamples - Anzahl sichtbarer Samples
     * @param sampleRate - Samples pro Sekunde (z.B. 10000 = 10kHz)
     */
    draw(minValue: number, maxValue: number, totalSamples: number, sampleRate: number) {
        const { width, height } = this.overlayCanvas;

        // Lösche vorheriges Grid (sonst überlagern sich die Linien)
        this.ctx.clearRect(0, 0, width, height);

        // Style Setup
        this.ctx.strokeStyle = 'rgba(80, 80, 80, 0.4)';  // Graue, transparente Linien
        this.ctx.lineWidth = 1;
        this.ctx.fillStyle = '#aaa';                     // Hellgrau für Text
        this.ctx.font = '11px monospace';

        // ========== HORIZONTALE GRID-LINIEN (Y-Achse) ==========
        const ySteps = 8;  // 8 Linien = 9 Bereiche
        for (let i = 0; i <= ySteps; i++) {
            const y = (height / ySteps) * i;  // Von oben nach unten

            // Zeichne Grid-Linie
            this.ctx.beginPath();
            this.ctx.moveTo(50, y);      // Start: 50px vom linken Rand (Platz für Y-Labels)
            this.ctx.lineTo(width, y);   // Ende: Rechter Rand
            this.ctx.stroke();

            // Y-Achsen Beschriftung (Messwerte)
            // i=0 → maxValue (oben), i=ySteps → minValue (unten)
            const value = maxValue - (maxValue - minValue) * (i / ySteps);
            this.ctx.fillText(value.toFixed(2), 5, y + 4);  // Links neben der Linie
        }

        // ========== VERTIKALE GRID-LINIEN (X-Achse / Zeit) ==========
        const xSteps = 10;  // 10 Linien = 11 Bereiche
        const totalTime = totalSamples / sampleRate;  // Samples → Sekunden

        for (let i = 0; i <= xSteps; i++) {
            const x = 50 + ((width - 50) / xSteps) * i;  // Von links nach rechts

            // Zeichne Grid-Linie
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);              // Start: Oben
            this.ctx.lineTo(x, height - 20);    // Ende: 20px über unterem Rand (Platz für X-Labels)
            this.ctx.stroke();

            // X-Achsen Beschriftung (Zeit in Sekunden)
            const time = (totalTime / xSteps) * i;
            this.ctx.fillText(time.toFixed(1) + 's', x - 15, height - 5);  // Unter der Linie
        }

        // ========== ACHSEN-TITEL ==========
        this.ctx.fillStyle = '#fff';                   // Weiß für Titel
        this.ctx.font = 'bold 12px sans-serif';
        this.ctx.fillText('Value', 5, 15);            // Oben links
        this.ctx.fillText('Time (s)', width - 60, height - 5);  // Unten rechts
    }

    resize(width: number, height: number) {
        this.overlayCanvas.width = width;
        this.overlayCanvas.height = height;
    }
}