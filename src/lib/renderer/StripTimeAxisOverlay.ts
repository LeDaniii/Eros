import { getPlotRect, type PlotRect } from './plotLayout';

export interface StripTimeAxisDrawParams {
    startIndex: number;
    endIndex: number;
    sampleRate: number;
    anchorSampleIndex: number;
    anchorTimeMs: number;
    windowDurationSeconds: number;
    isFrozen: boolean;
    followLatest: boolean;
}

/**
 * StripTimeAxisOverlay draws a wall-clock X axis for strip charts.
 * It intentionally only replaces the bottom axis labels/title and leaves the
 * generic Y grid rendering to the shared GridOverlay.
 */
export class StripTimeAxisOverlay {
    private readonly overlayCanvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private devicePixelRatio = 1;
    private cssWidth = 1;
    private cssHeight = 1;
    private readonly secondFormatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    private readonly millisecondFormatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
    });

    constructor(mainCanvas: HTMLCanvasElement) {
        this.overlayCanvas = document.createElement('canvas');

        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.pointerEvents = 'none';
        this.overlayCanvas.style.zIndex = '6';

        mainCanvas.parentElement?.appendChild(this.overlayCanvas);

        const ctx = this.overlayCanvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas2D context is not available');
        }
        this.ctx = ctx;

        this.resize(
            mainCanvas.clientWidth || mainCanvas.width,
            mainCanvas.clientHeight || mainCanvas.height
        );
    }

    draw(params: StripTimeAxisDrawParams): void {
        const width = this.cssWidth;
        const height = this.cssHeight;
        this.ctx.clearRect(0, 0, width, height);

        if (width <= 0 || height <= 0) {
            return;
        }

        const plot = getPlotRect(width, height);
        const safeWindowDurationSeconds = Math.max(1, params.windowDurationSeconds);
        const viewportDurationMs = safeWindowDurationSeconds * 1000;
        // Strip axis is fixed-width: always show the configured history window.
        const viewportEndMs = params.anchorTimeMs;
        const viewportStartMs = viewportEndMs - viewportDurationMs;

        this.drawAxisBand(plot);
        this.drawTicks(plot, viewportStartMs, viewportEndMs);
        this.drawStatus(plot, params, viewportDurationMs);
    }

    resize(width: number, height: number): void {
        const safeWidth = Math.max(1, Math.round(width));
        const safeHeight = Math.max(1, Math.round(height));
        const dpr = Math.max(1, window.devicePixelRatio || 1);

        this.devicePixelRatio = dpr;
        this.cssWidth = safeWidth;
        this.cssHeight = safeHeight;

        this.overlayCanvas.style.width = `${safeWidth}px`;
        this.overlayCanvas.style.height = `${safeHeight}px`;
        this.overlayCanvas.width = Math.max(1, Math.round(safeWidth * dpr));
        this.overlayCanvas.height = Math.max(1, Math.round(safeHeight * dpr));

        // Draw in CSS pixel coordinates while keeping a high-resolution backing store.
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    destroy(): void {
        this.overlayCanvas.remove();
    }

    private drawAxisBand(plot: PlotRect): void {
        const bandTop = Math.max(0, plot.bottom + 1);
        const bandHeight = Math.max(0, this.cssHeight - bandTop);
        if (bandHeight <= 0) {
            return;
        }

        // Cover the generic X-axis labels/title rendered by GridOverlay.
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
        this.ctx.fillRect(0, bandTop, this.cssWidth, bandHeight);

        this.ctx.strokeStyle = 'rgba(110, 110, 110, 0.45)';
        this.ctx.lineWidth = this.getCrispLineWidth();
        this.ctx.beginPath();
        const alignedY = this.alignStrokeCoordinate(plot.bottom);
        this.ctx.moveTo(plot.left, alignedY);
        this.ctx.lineTo(plot.right, alignedY);
        this.ctx.stroke();
    }

    private drawTicks(plot: PlotRect, viewportStartMs: number, viewportEndMs: number): void {
        const totalMs = Math.max(1, viewportEndMs - viewportStartMs);
        const tickStepMs = 1000; // Requested strip behavior: one vertical line per second.

        const firstTickMs = Math.ceil(viewportStartMs / tickStepMs) * tickStepMs;
        const epsilon = tickStepMs * 1e-6;
        const maxTicks = 1000;

        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'top';
        this.ctx.fillStyle = '#d0d0d0';
        this.ctx.strokeStyle = 'rgba(130, 170, 255, 0.30)';
        this.ctx.lineWidth = this.getCrispLineWidth();

        let tickCount = 0;
        for (let t = firstTickMs; t <= viewportEndMs + epsilon && tickCount < maxTicks; t += tickStepMs) {
            const progress = (t - viewportStartMs) / totalMs;
            if (progress < -0.001 || progress > 1.001) {
                continue;
            }

            const x = plot.left + progress * plot.width;
            const alignedX = this.alignStrokeCoordinate(x);

            // Strip-specific wall-clock grid line across the plot area.
            this.ctx.beginPath();
            this.ctx.moveTo(alignedX, plot.top);
            this.ctx.lineTo(alignedX, plot.bottom);
            this.ctx.stroke();

            // Short tick mark in the axis band.
            this.ctx.beginPath();
            this.ctx.moveTo(alignedX, plot.bottom + 1);
            this.ctx.lineTo(alignedX, Math.min(this.cssHeight - 2, plot.bottom + 7));
            this.ctx.stroke();

            this.ctx.fillText(this.formatTime(t, tickStepMs), Math.round(x), plot.bottom + 8);
            tickCount++;
        }

        // Right-edge marker for visual "now/frozen edge" reference.
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        const rightEdgeX = this.alignStrokeCoordinate(plot.right);
        this.ctx.beginPath();
        this.ctx.moveTo(rightEdgeX, plot.top);
        this.ctx.lineTo(rightEdgeX, this.cssHeight);
        this.ctx.stroke();
    }

    private drawStatus(plot: PlotRect, params: StripTimeAxisDrawParams, viewportDurationMs: number): void {
        const bandTextY = Math.min(this.cssHeight - 14, plot.bottom + 8);
        const status = params.isFrozen ? 'FROZEN' : (params.followLatest ? 'LIVE' : 'MANUAL');
        const windowSeconds = viewportDurationMs / 1000;

        this.ctx.font = 'bold 10px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        this.ctx.fillStyle = params.isFrozen ? '#ffd3bf' : '#bfe4ff';
        this.ctx.fillText(`${status} | ${windowSeconds.toFixed(windowSeconds >= 10 ? 1 : 2)}s`, plot.left, bandTextY);

        this.ctx.textAlign = 'right';
        this.ctx.fillStyle = '#f0f0f0';
        this.ctx.fillText('Clock (local)', plot.right, bandTextY);
    }

    private formatTime(epochMs: number, tickStepMs: number): string {
        if (!Number.isFinite(epochMs)) {
            return '--:--:--';
        }

        const date = new Date(epochMs);
        if (tickStepMs < 1000) {
            return this.millisecondFormatter.format(date);
        }
        return this.secondFormatter.format(date);
    }

    private getCrispLineWidth(): number {
        return 1 / this.devicePixelRatio;
    }

    private alignStrokeCoordinate(value: number): number {
        const dpr = this.devicePixelRatio;
        return (Math.round(value * dpr) + 0.5) / dpr;
    }
}
