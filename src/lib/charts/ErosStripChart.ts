import {
    ErosChart,
    type ErosChartOptions,
    type StreamOptions,
} from './ErosChart';
import { StripTimeAxisOverlay } from '../renderer/StripTimeAxisOverlay';

export interface ErosStripChartOptions extends ErosChartOptions {
    liveWindowDurationSeconds?: number;
}

export interface ErosStripChartViewportStrategyState {
    displayMode: 'live-strip';
    followLatest: boolean;
    liveWindowDurationSeconds: number;
    isFrozen: boolean;
}

function resolveCanvasElement(canvasOrSelector: string | HTMLCanvasElement): HTMLCanvasElement {
    if (typeof canvasOrSelector !== 'string') {
        return canvasOrSelector;
    }

    const element = document.querySelector(canvasOrSelector);
    if (!(element instanceof HTMLCanvasElement)) {
        throw new Error(`Canvas nicht gefunden: ${canvasOrSelector}`);
    }
    return element;
}

export class ErosStripChart {
    private static readonly FIXED_WINDOW_DURATION_SECONDS = 10;

    private readonly chart: ErosChart;
    private readonly canvas: HTMLCanvasElement;
    private readonly sampleRate: number;
    private readonly bufferSize: number;
    private readonly enableInteractions: boolean;

    private stripTimeAxisOverlay: StripTimeAxisOverlay | null = null;
    private liveWindowDurationSeconds: number;
    private followLatest = true;
    private isFrozen = false;
    private followLoopFrameId: number | null = null;
    private suppressFreezeFromInternalViewportUpdate = false;
    private timeAnchorSampleIndex = 0;
    private timeAnchorTimeMs = Date.now();

    private readonly onResize = (): void => {
        this.stripTimeAxisOverlay?.resize(this.canvas.width, this.canvas.height);
    };

    private readonly onWheel = (): void => {
        this.freeze();
    };

    private readonly onMouseDown = (): void => {
        this.freeze();
    };

    constructor(canvasOrSelector: string | HTMLCanvasElement, options: ErosStripChartOptions) {
        this.canvas = resolveCanvasElement(canvasOrSelector);
        this.chart = new ErosChart(this.canvas, {
            ...options,
            showXAxisGrid: false,
            showXAxisTitle: false,
        });

        this.sampleRate = Math.max(1, options.sampleRate ?? 10_000);
        this.bufferSize = Math.max(1, options.bufferSize ?? 100_000);
        this.enableInteractions = options.enableInteractions ?? true;
        this.liveWindowDurationSeconds = ErosStripChart.FIXED_WINDOW_DURATION_SECONDS;
    }

    async initialize(): Promise<void> {
        await this.chart.initialize();
        this.stripTimeAxisOverlay = new StripTimeAxisOverlay(this.canvas);
        this.attachManualFreezeListeners();
        window.addEventListener('resize', this.onResize);
        this.startFollowLoop();
        this.applyFollowLatestViewport();
        this.drawStripTimeAxisOverlay();
    }

    async startStream(options?: StreamOptions): Promise<void> {
        await this.chart.startStream(options);
    }

    destroy(): void {
        this.detachManualFreezeListeners();
        window.removeEventListener('resize', this.onResize);
        if (this.followLoopFrameId !== null) {
            cancelAnimationFrame(this.followLoopFrameId);
            this.followLoopFrameId = null;
        }
        this.stripTimeAxisOverlay?.destroy();
        this.stripTimeAxisOverlay = null;
        this.chart.destroy();
    }

    setLiveWindowDuration(_seconds: number): void {
        // Strip chart uses a fixed 10s window by design.
        this.liveWindowDurationSeconds = ErosStripChart.FIXED_WINDOW_DURATION_SECONDS;
        if (this.followLatest && !this.isFrozen) {
            this.applyFollowLatestViewport();
        }
    }

    getLiveWindowDuration(): number {
        return this.liveWindowDurationSeconds;
    }

    freeze(): void {
        if (this.isFrozen) {
            return;
        }

        this.captureCurrentViewportAsTimeAnchor(Date.now());
        this.isFrozen = true;
        this.followLatest = false;
    }

    resumeFollowLatest(): void {
        this.captureCurrentViewportAsTimeAnchor(Date.now());
        this.isFrozen = false;
        this.followLatest = true;
        this.applyFollowLatestViewport();
    }

    getViewportStrategyState(): ErosStripChartViewportStrategyState {
        return {
            displayMode: 'live-strip',
            followLatest: this.followLatest,
            liveWindowDurationSeconds: this.liveWindowDurationSeconds,
            isFrozen: this.isFrozen,
        };
    }

    resetViewport(): void {
        this.resumeFollowLatest();
    }

    setViewport(startIndex: number, endIndex: number): void {
        if (!this.suppressFreezeFromInternalViewportUpdate) {
            this.freeze();
        }
        this.chart.setViewport(startIndex, endIndex);
    }

    getViewportRange(): { startIndex: number; endIndex: number } {
        return this.chart.getViewportRange();
    }

    setViewportChangeListener(listener: ((startIndex: number, endIndex: number) => void) | null): void {
        this.chart.setViewportChangeListener(listener);
    }

    setLineColor(lineColor: string): void {
        this.chart.setLineColor(lineColor);
    }

    setYRangeOverride(minValue: number, maxValue: number): void {
        this.chart.setYRangeOverride(minValue, maxValue);
    }

    clearYRangeOverride(): void {
        this.chart.clearYRangeOverride();
    }

    setCrosshairSnapSeries(series: Array<{ values: ArrayLike<number>; visible?: boolean; color?: string }> | null): void {
        this.chart.setCrosshairSnapSeries(series);
    }

    getStats(): { totalSamples: number; visibleSamples: number; bufferSize: number; isDownsampled: boolean; renderedVertices: number } {
        return this.chart.getStats();
    }

    exportBinary(): ArrayBuffer {
        return this.chart.exportBinary();
    }

    loadData(values: Float32Array): void {
        this.chart.loadData(values);
        if (this.followLatest && !this.isFrozen) {
            this.applyFollowLatestViewport();
        }
    }

    private attachManualFreezeListeners(): void {
        if (!this.enableInteractions) {
            return;
        }

        this.canvas.addEventListener('wheel', this.onWheel, { passive: true });
        this.canvas.addEventListener('mousedown', this.onMouseDown);
    }

    private detachManualFreezeListeners(): void {
        if (!this.enableInteractions) {
            return;
        }

        this.canvas.removeEventListener('wheel', this.onWheel);
        this.canvas.removeEventListener('mousedown', this.onMouseDown);
    }

    private startFollowLoop(): void {
        const tick = () => {
            this.applyFollowLatestViewport();
            this.drawStripTimeAxisOverlay();
            this.followLoopFrameId = requestAnimationFrame(tick);
        };

        if (this.followLoopFrameId !== null) {
            cancelAnimationFrame(this.followLoopFrameId);
        }

        this.followLoopFrameId = requestAnimationFrame(tick);
    }

    private applyFollowLatestViewport(): void {
        if (this.isFrozen || !this.followLatest) {
            return;
        }

        const totalSamples = this.chart.getStats().totalSamples;
        const nextViewport = this.computeFollowLatestViewport(totalSamples);
        const currentViewport = this.chart.getViewportRange();

        if (
            currentViewport.startIndex === nextViewport.startIndex
            && currentViewport.endIndex === nextViewport.endIndex
        ) {
            return;
        }

        this.suppressFreezeFromInternalViewportUpdate = true;
        try {
            this.chart.setViewport(nextViewport.startIndex, nextViewport.endIndex);
        } finally {
            this.suppressFreezeFromInternalViewportUpdate = false;
        }

        this.timeAnchorSampleIndex = nextViewport.endIndex;
        this.timeAnchorTimeMs = Date.now();
    }

    private computeFollowLatestViewport(currentHead: number): { startIndex: number; endIndex: number } {
        const safeCurrentHead = Math.max(0, Math.min(currentHead, this.bufferSize));
        const windowSamples = Math.max(
            1,
            Math.min(this.bufferSize, Math.round(this.liveWindowDurationSeconds * this.sampleRate))
        );

        if (safeCurrentHead <= 0) {
            return { startIndex: 0, endIndex: 1 };
        }

        const endIndex = Math.max(1, safeCurrentHead);
        const startIndex = Math.max(0, endIndex - windowSamples);
        return {
            startIndex,
            endIndex: Math.max(startIndex + 1, endIndex),
        };
    }

    private captureCurrentViewportAsTimeAnchor(nowMs: number): void {
        const viewport = this.chart.getViewportRange();
        this.timeAnchorSampleIndex = viewport.endIndex;
        this.timeAnchorTimeMs = nowMs;
    }

    private drawStripTimeAxisOverlay(): void {
        if (!this.stripTimeAxisOverlay) {
            return;
        }

        const viewport = this.chart.getViewportRange();
        if (this.followLatest && !this.isFrozen) {
            this.timeAnchorSampleIndex = viewport.endIndex;
            this.timeAnchorTimeMs = Date.now();
        }

        this.stripTimeAxisOverlay.draw({
            startIndex: viewport.startIndex,
            endIndex: viewport.endIndex,
            sampleRate: this.sampleRate,
            anchorSampleIndex: this.timeAnchorSampleIndex,
            anchorTimeMs: this.timeAnchorTimeMs,
            windowDurationSeconds: this.liveWindowDurationSeconds,
            isFrozen: this.isFrozen,
            followLatest: this.followLatest,
        });
    }
}
