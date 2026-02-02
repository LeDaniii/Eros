export class GridOverlay {
    private overlayCanvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;

    constructor(private mainCanvas: HTMLCanvasElement) {
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.width = mainCanvas.width;
        this.overlayCanvas.height = mainCanvas.height;
        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.pointerEvents = 'none';

        mainCanvas.parentElement?.appendChild(this.overlayCanvas);
        this.ctx = this.overlayCanvas.getContext('2d')!;
    }

    draw(minValue: number, maxValue: number, totalSamples: number, sampleRate: number) {
        const { width, height } = this.overlayCanvas;
        this.ctx.clearRect(0, 0, width, height);

        this.ctx.strokeStyle = 'rgba(80, 80, 80, 0.4)';
        this.ctx.lineWidth = 1;
        this.ctx.fillStyle = '#aaa';
        this.ctx.font = '11px monospace';

        // Horizontale Grid-Linien (Y-Achse)
        const ySteps = 8;
        for (let i = 0; i <= ySteps; i++) {
            const y = (height / ySteps) * i;

            this.ctx.beginPath();
            this.ctx.moveTo(50, y);
            this.ctx.lineTo(width, y);
            this.ctx.stroke();

            // Y-Labels
            const value = maxValue - (maxValue - minValue) * (i / ySteps);
            this.ctx.fillText(value.toFixed(2), 5, y + 4);
        }

        // Vertikale Grid-Linien (X-Achse / Zeit)
        const xSteps = 10;
        const totalTime = totalSamples / sampleRate;

        for (let i = 0; i <= xSteps; i++) {
            const x = 50 + ((width - 50) / xSteps) * i;

            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, height - 20);
            this.ctx.stroke();

            // Zeit-Labels
            const time = (totalTime / xSteps) * i;
            this.ctx.fillText(time.toFixed(1) + 's', x - 15, height - 5);
        }

        // Achsenbeschriftungen
        this.ctx.fillStyle = '#fff';
        this.ctx.font = 'bold 12px sans-serif';
        this.ctx.fillText('Value', 5, 15);
        this.ctx.fillText('Time (s)', width - 60, height - 5);
    }

    resize(width: number, height: number) {
        this.overlayCanvas.width = width;
        this.overlayCanvas.height = height;
    }
}