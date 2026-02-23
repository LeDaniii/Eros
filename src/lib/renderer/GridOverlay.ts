/**
 * GridOverlay - draws axes, labels and grid on a Canvas2D overlay.
 */
import { getPlotRect } from './plotLayout';

export class GridOverlay {
    private overlayCanvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;

    constructor(mainCanvas: HTMLCanvasElement) {
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.width = mainCanvas.width;
        this.overlayCanvas.height = mainCanvas.height;

        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.pointerEvents = 'none';
        this.overlayCanvas.style.zIndex = '5';

        mainCanvas.parentElement?.appendChild(this.overlayCanvas);

        const ctx = this.overlayCanvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas2D context is not available');
        }
        this.ctx = ctx;
    }

    /**
     * @param minValue min value for Y axis
     * @param maxValue max value for Y axis
     * @param totalSamples number of visible samples
     * @param sampleRate samples per second
     * @param startSampleIndex first visible sample, used as time offset
     */
    draw(
        minValue: number,
        maxValue: number,
        totalSamples: number,
        sampleRate: number,
        startSampleIndex = 0
    ): void {
        const { width, height } = this.overlayCanvas;
        this.ctx.clearRect(0, 0, width, height);

        if (width <= 0 || height <= 0) {
            return;
        }

        const plot = getPlotRect(width, height);
        const plotLeft = plot.left;
        const plotRight = plot.right;
        const plotTop = plot.top;
        const plotBottom = plot.bottom;
        const plotWidth = plot.width;
        const plotHeight = plot.height;

        this.ctx.strokeStyle = 'rgba(80, 80, 80, 0.4)';
        this.ctx.lineWidth = 1;
        this.ctx.fillStyle = '#aaa';
        this.ctx.font = '11px monospace';

        this.drawYGrid(minValue, maxValue, plotLeft, plotRight, plotTop, plotBottom, plotHeight);
        this.drawXGrid(totalSamples, sampleRate, startSampleIndex, plotLeft, plotTop, plotBottom, plotWidth);

        this.ctx.fillStyle = '#fff';
        this.ctx.font = 'bold 12px sans-serif';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        this.ctx.fillText('Value', 5, 5);
        this.ctx.fillText('Time (s)', Math.max(plotLeft, width - 75), plotBottom + 6);
    }

    resize(width: number, height: number): void {
        this.overlayCanvas.width = width;
        this.overlayCanvas.height = height;
    }

    destroy(): void {
        this.overlayCanvas.remove();
    }

    private drawYGrid(
        minValue: number,
        maxValue: number,
        plotLeft: number,
        plotRight: number,
        plotTop: number,
        plotBottom: number,
        plotHeight: number
    ): void {
        const ySteps = 8;
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'middle';

        for (let i = 0; i <= ySteps; i++) {
            const y = plotTop + (plotHeight / ySteps) * i;

            this.ctx.beginPath();
            this.ctx.moveTo(plotLeft, y);
            this.ctx.lineTo(plotRight, y);
            this.ctx.stroke();

            const value = maxValue - (maxValue - minValue) * (i / ySteps);
            this.ctx.fillText(value.toFixed(2), 5, y);
        }

        this.ctx.beginPath();
        this.ctx.moveTo(plotLeft, plotTop);
        this.ctx.lineTo(plotLeft, plotBottom);
        this.ctx.stroke();
    }

    private drawXGrid(
        totalSamples: number,
        sampleRate: number,
        startSampleIndex: number,
        plotLeft: number,
        plotTop: number,
        plotBottom: number,
        plotWidth: number
    ): void {
        const safeSampleRate = Math.max(1, sampleRate);
        const safeTotalSamples = Math.max(0, totalSamples);
        const startTime = startSampleIndex / safeSampleRate;
        const totalTime = safeTotalSamples / safeSampleRate;
        const endTime = startTime + totalTime;

        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'top';

        if (totalTime <= 0) {
            this.ctx.beginPath();
            this.ctx.moveTo(plotLeft, plotTop);
            this.ctx.lineTo(plotLeft, plotBottom);
            this.ctx.stroke();
            this.ctx.fillText(this.formatTimeSeconds(startTime, 1), plotLeft, plotBottom + 4);
            return;
        }

        let desiredTickCount = Math.max(2, Math.floor(plotWidth / 90));
        let tickStep = this.getNiceStep(totalTime / desiredTickCount);

        const labelProbe = this.formatTimeSeconds(startTime + tickStep, tickStep);
        const minLabelSpacing = this.ctx.measureText(labelProbe).width + 18;
        desiredTickCount = Math.max(2, Math.floor(plotWidth / Math.max(1, minLabelSpacing)));
        tickStep = this.getNiceStep(totalTime / desiredTickCount);

        const firstTick = Math.ceil(startTime / tickStep) * tickStep;
        const epsilon = tickStep * 1e-6;
        const maxTicks = 1000;
        let tickCount = 0;

        for (let t = firstTick; t <= endTime + epsilon && tickCount < maxTicks; t += tickStep) {
            const progress = (t - startTime) / totalTime;
            if (progress < -0.001 || progress > 1.001) {
                continue;
            }

            const x = plotLeft + progress * plotWidth;

            this.ctx.beginPath();
            this.ctx.moveTo(x, plotTop);
            this.ctx.lineTo(x, plotBottom);
            this.ctx.stroke();

            this.ctx.fillText(this.formatTimeSeconds(t, tickStep), x, plotBottom + 4);
            tickCount++;
        }
    }

    private getNiceStep(rawStep: number): number {
        if (!Number.isFinite(rawStep) || rawStep <= 0) {
            return 1;
        }

        const exponent = Math.floor(Math.log10(rawStep));
        const magnitude = 10 ** exponent;
        const normalized = rawStep / magnitude;

        if (normalized <= 1) {
            return 1 * magnitude;
        }
        if (normalized <= 2) {
            return 2 * magnitude;
        }
        if (normalized <= 5) {
            return 5 * magnitude;
        }
        return 10 * magnitude;
    }

    private formatTimeSeconds(seconds: number, tickStep: number): string {
        const absStep = Math.abs(tickStep);
        if (!Number.isFinite(seconds) || !Number.isFinite(absStep)) {
            return '0s';
        }

        if (absStep >= 1) {
            return `${seconds.toFixed(1)}s`;
        }

        const decimals = Math.max(1, Math.min(6, Math.ceil(-Math.log10(absStep))));
        return `${seconds.toFixed(decimals)}s`;
    }
}
