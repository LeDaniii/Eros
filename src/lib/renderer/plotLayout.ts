export const PLOT_PADDING = {
    left: 56,
    right: 10,
    top: 8,
    bottom: 24,
} as const;

export interface PlotRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
}

export function getPlotRect(canvasWidth: number, canvasHeight: number): PlotRect {
    const left = PLOT_PADDING.left;
    const right = Math.max(left + 1, canvasWidth - PLOT_PADDING.right);
    const top = PLOT_PADDING.top;
    const bottom = Math.max(top + 1, canvasHeight - PLOT_PADDING.bottom);

    return {
        left,
        right,
        top,
        bottom,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
    };
}
