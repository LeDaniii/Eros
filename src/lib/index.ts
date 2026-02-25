/**
 * Eros Charts - High-Performance gRPC Charts mit WebGPU
 *
 * Public API Export
 */

// === Main API ===
export { ErosChart } from './charts/ErosChart';
export type {
    ErosChartOptions,
    StreamOptions,
    ErosBinaryCurve
} from './charts/ErosChart';
export { ErosStripChart } from './charts/ErosStripChart';
export type {
    ErosStripChartOptions,
    ErosStripChartViewportStrategyState
} from './charts/ErosStripChart';

// === Advanced Components (falls jemand direkt darauf zugreifen will) ===
export { WebGPURenderer } from './renderer/WebGPURenderer';
export { GridOverlay } from './renderer/GridOverlay';
export { CrosshairOverlay } from './renderer/CrosshairOverlay';
export { SharedRingBuffer } from './core/SharedRingBuffer';
export { Downsampler } from './core/Downsampler';
export type { DownsampleResult } from './core/Downsampler';

// === Toolbox (derived curves / analysis helpers) ===
export {
    computeEma,
    computeMovingAverage,
    computeRollingMeanStdDev,
    createDerivedCurve,
    createNoiseBandCurves,
} from './toolbox';
export type {
    EmaOptions,
    RollingMeanStdDevResult,
    DerivedCurve,
    DerivedCurveKind,
    DerivedCurveSpec,
    NoiseBandCurves,
    NoiseBandCurveOptions,
    EmaDerivedCurveSpec,
    MovingAverageDerivedCurveSpec,
    RollingMeanDerivedCurveSpec,
    RollingStdDevDerivedCurveSpec,
    RollingBandDerivedCurveSpec,
} from './toolbox';
