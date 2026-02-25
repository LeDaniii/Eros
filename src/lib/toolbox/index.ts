export {
    computeEma,
    computeMovingAverage,
    computeRollingMeanStdDev,
} from './smoothing';
export {
    createDerivedCurve,
    createNoiseBandCurves,
} from './derivedCurves';

export type {
    EmaOptions,
    RollingMeanStdDevResult,
} from './smoothing';
export type {
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
} from './derivedCurves';
