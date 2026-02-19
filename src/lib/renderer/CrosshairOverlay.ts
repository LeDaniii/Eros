import { SharedRingBuffer } from '../core/SharedRingBuffer';

export interface CrosshairOptions {
    lineColor?: string;      // Crosshair line color (default: '#00ff00')
    textColor?: string;      // Value label color (default: '#00ff00')
    lineWidth?: number;      // Line width (default: 1)
    fontSize?: number;       // Font size (default: 12)
    snapEnabled?: boolean;   // Snap to nearest point (default: true)
    snapRadiusPx?: number;   // Snap radius in pixels (default: 10)
}

interface SnapCandidate {
    snapped: boolean;
    x: number;
    y: number;
    sampleIndex: number;
    value: number;
}

export class CrosshairOverlay {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private parentCanvas: HTMLCanvasElement;
    private buffer: SharedRingBuffer;
    private sampleRate: number;

    private mouseX = -1;  // -1 = outside
    private mouseY = -1;

    private lineColor: string;
    private textColor: string;
    private lineWidth: number;
    private fontSize: number;
    private snapEnabled: boolean;
    private snapRadiusPx: number;

    // Viewport info (updated from ErosChart)
    private viewport = {
        startIndex: 0,
        endIndex: 100_000,
        minValue: -2.5,
        maxValue: 2.5,
    };

    private readonly handleMouseMove = (event: MouseEvent): void => {
        this.onMouseMove(event);
    };

    private readonly handleMouseLeave = (): void => {
        this.onMouseLeave();
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

        // Options with defaults
        this.lineColor = options.lineColor ?? '#00ff00';
        this.textColor = options.textColor ?? '#00ff00';
        this.lineWidth = options.lineWidth ?? 1;
        this.fontSize = options.fontSize ?? 12;
        this.snapEnabled = options.snapEnabled ?? true;
        this.snapRadiusPx = options.snapRadiusPx ?? 10;

        // Create canvas2D overlay above the WebGPU canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.zIndex = '10';

        const ctx = this.canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas2D context is not available');
        }
        this.ctx = ctx;

        const container = parentCanvas.parentElement;
        if (!container) {
            throw new Error('Parent canvas has no container');
        }
        container.appendChild(this.canvas);

        this.resize();

        // Track pointer on parent canvas because overlay is pointer-events none
        this.parentCanvas.addEventListener('mousemove', this.handleMouseMove);
        this.parentCanvas.addEventListener('mouseleave', this.handleMouseLeave);
    }

    /** Resize overlay to match parent canvas size */
    public resize(): void {
        const rect = this.parentCanvas.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
    }

    /** Update viewport from ErosChart (zoom/pan + y-range) */
    public updateViewport(startIndex: number, endIndex: number, minValue: number, maxValue: number): void {
        this.viewport.startIndex = startIndex;
        this.viewport.endIndex = endIndex;
        this.viewport.minValue = minValue;
        this.viewport.maxValue = maxValue;
    }

    private onMouseMove(event: MouseEvent): void {
        const rect = this.parentCanvas.getBoundingClientRect();
        this.mouseX = event.clientX - rect.left;
        this.mouseY = event.clientY - rect.top;
        this.draw();
    }

    private onMouseLeave(): void {
        this.mouseX = -1;
        this.mouseY = -1;
        this.clear();
    }

    /** Draw crosshair. Snaps to nearest visible data point if within snap radius. */
    public draw(): void {
        this.clear();

        if (this.mouseX < 0 || this.mouseY < 0) {
            return;
        }

        const ctx = this.ctx;
        const width = this.canvas.width;
        const height = this.canvas.height;

        const snap = this.getSnapCandidate(this.mouseX, this.mouseY);
        const crosshairX = snap.x;
        const crosshairY = snap.y;

        const timeValue = snap.snapped
            ? snap.sampleIndex / this.sampleRate
            : this.getTimeAtX(this.mouseX);

        const yValue = snap.snapped
            ? snap.value
            : this.getInterpolatedValueAtX(this.mouseX);

        // Crosshair lines
        ctx.strokeStyle = this.lineColor;
        ctx.lineWidth = this.lineWidth;
        ctx.setLineDash([5, 5]);

        ctx.beginPath();
        ctx.moveTo(crosshairX, 0);
        ctx.lineTo(crosshairX, height);
        ctx.moveTo(0, crosshairY);
        ctx.lineTo(width, crosshairY);
        ctx.stroke();

        ctx.setLineDash([]);

        // Highlight snapped point
        if (snap.snapped) {
            ctx.fillStyle = this.lineColor;
            ctx.beginPath();
            ctx.arc(crosshairX, crosshairY, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        // Labels
        ctx.fillStyle = this.textColor;
        ctx.font = `${this.fontSize}px monospace`;

        const timeText = `t: ${timeValue.toFixed(4)}s`;
        const timeMetrics = ctx.measureText(timeText);
        const timeX = Math.max(6, Math.min(crosshairX + 8, width - timeMetrics.width - 6));
        const timeY = Math.max(this.fontSize + 2, Math.min(15, height - 2));

        this.drawTextBackground(ctx, timeX, timeY, timeMetrics.width, this.fontSize);
        ctx.fillText(timeText, timeX, timeY);

        const yText = `y: ${yValue.toFixed(3)}`;
        const yMetrics = ctx.measureText(yText);
        const yX = 8;
        const yY = Math.max(this.fontSize + 2, Math.min(crosshairY - 5, height - 2));

        this.drawTextBackground(ctx, yX, yY, yMetrics.width, this.fontSize);
        ctx.fillText(yText, yX, yY);
    }

    /** Compute nearest snap point in a local search window around cursor x */
    private getSnapCandidate(mouseX: number, mouseY: number): SnapCandidate {
        const fallbackValue = this.getInterpolatedValueAtX(mouseX);
        const fallbackSample = Math.round(this.getSampleIndexAtX(mouseX));

        const fallback: SnapCandidate = {
            snapped: false,
            x: mouseX,
            y: mouseY,
            sampleIndex: fallbackSample,
            value: fallbackValue,
        };

        if (!this.snapEnabled || this.snapRadiusPx <= 0) {
            return fallback;
        }

        const width = this.canvas.width;
        const visibleStart = Math.max(0, Math.floor(this.viewport.startIndex));
        const visibleEnd = Math.min(this.buffer.data.length, Math.ceil(this.viewport.endIndex));
        const visibleCount = visibleEnd - visibleStart;

        if (width <= 0 || visibleCount <= 0) {
            return fallback;
        }

        const samplesPerPixel = visibleCount / width;
        const radiusSamples = Math.max(1, Math.ceil(this.snapRadiusPx * samplesPerPixel));

        const centerIndex = Math.round(this.getSampleIndexAtX(mouseX));
        const searchStart = this.clamp(centerIndex - radiusSamples, visibleStart, visibleEnd - 1);
        const searchEnd = this.clamp(centerIndex + radiusSamples, visibleStart, visibleEnd - 1);

        if (searchEnd < searchStart) {
            return fallback;
        }

        const maxCandidates = 4_000;
        const totalCandidates = searchEnd - searchStart + 1;
        const coarseStep = Math.max(1, Math.ceil(totalCandidates / maxCandidates));

        let bestIndex = -1;
        let bestX = mouseX;
        let bestY = mouseY;
        let bestDistSq = Number.POSITIVE_INFINITY;

        const evaluateIndex = (index: number): void => {
            const value = this.buffer.data[index];
            const pointX = this.sampleIndexToCanvasX(index);
            const pointY = this.valueToCanvasY(value);
            const dx = pointX - mouseX;
            const dy = pointY - mouseY;
            const distSq = dx * dx + dy * dy;

            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestIndex = index;
                bestX = pointX;
                bestY = pointY;
            }
        };

        for (let i = searchStart; i <= searchEnd; i += coarseStep) {
            evaluateIndex(i);
        }

        // Refine around the best coarse match with exact step=1 lookup
        if (bestIndex >= 0 && coarseStep > 1) {
            const refineStart = Math.max(searchStart, bestIndex - coarseStep);
            const refineEnd = Math.min(searchEnd, bestIndex + coarseStep);
            for (let i = refineStart; i <= refineEnd; i++) {
                evaluateIndex(i);
            }
        }

        if (bestIndex < 0) {
            return fallback;
        }

        const snapRadiusSq = this.snapRadiusPx * this.snapRadiusPx;
        if (bestDistSq > snapRadiusSq) {
            return fallback;
        }

        return {
            snapped: true,
            x: bestX,
            y: bestY,
            sampleIndex: bestIndex,
            value: this.buffer.data[bestIndex],
        };
    }

    private drawTextBackground(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(x - 3, y - height, width + 6, height + 4);
        ctx.fillStyle = this.textColor;
    }

    private getTimeAtX(x: number): number {
        const sampleIndex = this.getSampleIndexAtX(x);
        return sampleIndex / this.sampleRate;
    }

    private getSampleIndexAtX(x: number): number {
        const width = this.canvas.width;
        if (width <= 0) {
            return this.viewport.startIndex;
        }

        const progress = this.clamp(x / width, 0, 1);
        return this.viewport.startIndex + progress * (this.viewport.endIndex - this.viewport.startIndex);
    }

    private getInterpolatedValueAtX(x: number): number {
        const sampleIndex = this.getSampleIndexAtX(x);
        const maxIndex = this.buffer.data.length - 1;

        const indexFloor = this.clamp(Math.floor(sampleIndex), 0, maxIndex);
        const indexCeil = this.clamp(Math.ceil(sampleIndex), 0, maxIndex);

        const valueFloor = this.buffer.data[indexFloor];
        const valueCeil = this.buffer.data[indexCeil];

        const fraction = sampleIndex - indexFloor;
        return valueFloor + (valueCeil - valueFloor) * fraction;
    }

    private sampleIndexToCanvasX(index: number): number {
        const width = this.canvas.width;
        const visibleCount = this.viewport.endIndex - this.viewport.startIndex;

        if (width <= 0 || visibleCount <= 0) {
            return 0;
        }

        const normalizedX = (index - this.viewport.startIndex) / visibleCount;
        return normalizedX * width;
    }

    /** Match renderer Y transform including 5% top/bottom padding from shader */
    private valueToCanvasY(value: number): number {
        const height = this.canvas.height;
        const range = this.viewport.maxValue - this.viewport.minValue;

        if (height <= 0 || range <= 0) {
            return height * 0.5;
        }

        const normalizedY = (value - this.viewport.minValue) / range;
        const ndcY = (normalizedY * 2 - 1) * 0.95;
        const screenY = (1 - (ndcY * 0.5 + 0.5)) * height;

        return this.clamp(screenY, 0, height);
    }

    private clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
    }

    private clear(): void {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    public destroy(): void {
        this.parentCanvas.removeEventListener('mousemove', this.handleMouseMove);
        this.parentCanvas.removeEventListener('mouseleave', this.handleMouseLeave);
        this.canvas.remove();
    }
}
