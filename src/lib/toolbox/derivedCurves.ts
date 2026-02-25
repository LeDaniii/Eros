import {
    computeEma,
    computeMovingAverage,
    computeRollingMeanStdDev,
    type EmaOptions,
} from './smoothing';

export type DerivedCurveKind =
    | 'ema'
    | 'moving-average'
    | 'rolling-mean'
    | 'rolling-stddev'
    | 'rolling-upper-band'
    | 'rolling-lower-band';

export interface DerivedCurve {
    kind: DerivedCurveKind;
    label: string;
    values: Float32Array;
}

export interface EmaDerivedCurveSpec extends EmaOptions {
    kind: 'ema';
    label?: string;
}

export interface MovingAverageDerivedCurveSpec {
    kind: 'moving-average';
    windowSize: number;
    label?: string;
}

export interface RollingMeanDerivedCurveSpec {
    kind: 'rolling-mean';
    windowSize: number;
    label?: string;
}

export interface RollingStdDevDerivedCurveSpec {
    kind: 'rolling-stddev';
    windowSize: number;
    label?: string;
}

export interface RollingBandDerivedCurveSpec {
    kind: 'rolling-upper-band' | 'rolling-lower-band';
    windowSize: number;
    sigma?: number;
    label?: string;
}

export type DerivedCurveSpec =
    | EmaDerivedCurveSpec
    | MovingAverageDerivedCurveSpec
    | RollingMeanDerivedCurveSpec
    | RollingStdDevDerivedCurveSpec
    | RollingBandDerivedCurveSpec;

export interface NoiseBandCurves {
    center: DerivedCurve;
    upper: DerivedCurve;
    lower: DerivedCurve;
}

export interface NoiseBandCurveOptions {
    windowSize: number;
    sigma?: number;
    centerLabel?: string;
    upperLabel?: string;
    lowerLabel?: string;
}

function normalizeSigma(sigma: number | undefined): number {
    if (!Number.isFinite(sigma) || sigma === undefined || sigma <= 0) {
        return 1;
    }
    return sigma;
}

function clampWindowSize(windowSize: number): number {
    if (!Number.isFinite(windowSize)) {
        return 1;
    }
    return Math.max(1, Math.floor(windowSize));
}

function defaultLabelForSpec(spec: DerivedCurveSpec): string {
    switch (spec.kind) {
        case 'ema': {
            const period = Number.isFinite(spec.period) ? Math.max(1, Math.floor(spec.period!)) : null;
            if (period !== null) {
                return `EMA(${period})`;
            }
            if (Number.isFinite(spec.alpha) && spec.alpha! > 0) {
                return `EMA(alpha=${spec.alpha!.toFixed(3)})`;
            }
            return 'EMA';
        }
        case 'moving-average':
            return `MA(${clampWindowSize(spec.windowSize)})`;
        case 'rolling-mean':
            return `Mean(${clampWindowSize(spec.windowSize)})`;
        case 'rolling-stddev':
            return `StdDev(${clampWindowSize(spec.windowSize)})`;
        case 'rolling-upper-band': {
            const sigma = normalizeSigma(spec.sigma);
            return `Mean+${sigma}sigma (${clampWindowSize(spec.windowSize)})`;
        }
        case 'rolling-lower-band': {
            const sigma = normalizeSigma(spec.sigma);
            return `Mean-${sigma}sigma (${clampWindowSize(spec.windowSize)})`;
        }
    }
}

function combineMeanStdDev(mean: Float32Array, stdDev: Float32Array, sigma: number, direction: 1 | -1): Float32Array {
    const length = Math.min(mean.length, stdDev.length);
    const output = new Float32Array(length);

    for (let i = 0; i < length; i++) {
        output[i] = mean[i] + (direction * sigma * stdDev[i]);
    }

    return output;
}

/**
 * Create a single derived curve from raw values. Intended for CPU/worker-side
 * preprocessing before handing the result to the renderer as a normal curve.
 */
export function createDerivedCurve(values: ArrayLike<number>, spec: DerivedCurveSpec): DerivedCurve {
    switch (spec.kind) {
        case 'ema':
            return {
                kind: spec.kind,
                label: spec.label ?? defaultLabelForSpec(spec),
                values: computeEma(values, spec),
            };

        case 'moving-average':
            return {
                kind: spec.kind,
                label: spec.label ?? defaultLabelForSpec(spec),
                values: computeMovingAverage(values, spec.windowSize),
            };

        case 'rolling-mean': {
            const result = computeRollingMeanStdDev(values, spec.windowSize);
            return {
                kind: spec.kind,
                label: spec.label ?? defaultLabelForSpec(spec),
                values: result.mean,
            };
        }

        case 'rolling-stddev': {
            const result = computeRollingMeanStdDev(values, spec.windowSize);
            return {
                kind: spec.kind,
                label: spec.label ?? defaultLabelForSpec(spec),
                values: result.stdDev,
            };
        }

        case 'rolling-upper-band': {
            const sigma = normalizeSigma(spec.sigma);
            const result = computeRollingMeanStdDev(values, spec.windowSize);
            return {
                kind: spec.kind,
                label: spec.label ?? defaultLabelForSpec(spec),
                values: combineMeanStdDev(result.mean, result.stdDev, sigma, 1),
            };
        }

        case 'rolling-lower-band': {
            const sigma = normalizeSigma(spec.sigma);
            const result = computeRollingMeanStdDev(values, spec.windowSize);
            return {
                kind: spec.kind,
                label: spec.label ?? defaultLabelForSpec(spec),
                values: combineMeanStdDev(result.mean, result.stdDev, sigma, -1),
            };
        }
    }
}

/**
 * Convenience helper for noisy signals: center line plus upper/lower noise band.
 */
export function createNoiseBandCurves(values: ArrayLike<number>, options: NoiseBandCurveOptions): NoiseBandCurves {
    const windowSize = clampWindowSize(options.windowSize);
    const sigma = normalizeSigma(options.sigma);
    const { mean, stdDev } = computeRollingMeanStdDev(values, windowSize);

    return {
        center: {
            kind: 'rolling-mean',
            label: options.centerLabel ?? `Mean(${windowSize})`,
            values: mean,
        },
        upper: {
            kind: 'rolling-upper-band',
            label: options.upperLabel ?? `Mean+${sigma}sigma (${windowSize})`,
            values: combineMeanStdDev(mean, stdDev, sigma, 1),
        },
        lower: {
            kind: 'rolling-lower-band',
            label: options.lowerLabel ?? `Mean-${sigma}sigma (${windowSize})`,
            values: combineMeanStdDev(mean, stdDev, sigma, -1),
        },
    };
}
