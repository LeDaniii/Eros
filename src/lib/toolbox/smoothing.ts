export interface EmaOptions {
    alpha?: number;
    period?: number;
}

function resolveEmaAlpha(options?: EmaOptions): number {
    const alpha = options?.alpha;
    if (Number.isFinite(alpha) && alpha! > 0 && alpha! <= 1) {
        return alpha!;
    }

    const period = options?.period;
    if (Number.isFinite(period) && period! >= 1) {
        return 2 / (Math.max(1, period!) + 1);
    }

    // Default: ~10-sample EMA
    return 2 / 11;
}

/**
 * Compute an exponential moving average (EMA) with the same length as the input.
 * The first output sample is seeded with the first input value.
 */
export function computeEma(values: ArrayLike<number>, options?: EmaOptions): Float32Array {
    const length = values.length ?? 0;
    const output = new Float32Array(length);

    if (length < 1) {
        return output;
    }

    const alpha = resolveEmaAlpha(options);
    const first = Number(values[0]);
    let ema = Number.isFinite(first) ? first : 0;
    output[0] = ema;

    for (let i = 1; i < length; i++) {
        const sample = Number(values[i]);
        const next = Number.isFinite(sample) ? sample : ema;
        ema += alpha * (next - ema);
        output[i] = ema;
    }

    return output;
}

/**
 * Prefix-safe moving average. Warm-up samples use the currently available window
 * size until the configured window is filled.
 */
export function computeMovingAverage(values: ArrayLike<number>, windowSize: number): Float32Array {
    const length = values.length ?? 0;
    const output = new Float32Array(length);

    if (length < 1) {
        return output;
    }

    const window = Math.max(1, Math.floor(windowSize));
    let sum = 0;

    for (let i = 0; i < length; i++) {
        const inValueRaw = Number(values[i]);
        const inValue = Number.isFinite(inValueRaw) ? inValueRaw : 0;
        sum += inValue;

        if (i >= window) {
            const outValueRaw = Number(values[i - window]);
            sum -= Number.isFinite(outValueRaw) ? outValueRaw : 0;
        }

        const currentWindowSize = Math.min(window, i + 1);
        output[i] = sum / currentWindowSize;
    }

    return output;
}

export interface RollingMeanStdDevResult {
    mean: Float32Array;
    stdDev: Float32Array;
}

/**
 * Rolling mean + stddev using running sums. Useful for a center line and a
 * noise band (mean +/- k * stddev).
 */
export function computeRollingMeanStdDev(values: ArrayLike<number>, windowSize: number): RollingMeanStdDevResult {
    const length = values.length ?? 0;
    const mean = new Float32Array(length);
    const stdDev = new Float32Array(length);

    if (length < 1) {
        return { mean, stdDev };
    }

    const window = Math.max(1, Math.floor(windowSize));
    let sum = 0;
    let sumSquares = 0;

    for (let i = 0; i < length; i++) {
        const inValueRaw = Number(values[i]);
        const inValue = Number.isFinite(inValueRaw) ? inValueRaw : 0;

        sum += inValue;
        sumSquares += inValue * inValue;

        if (i >= window) {
            const outValueRaw = Number(values[i - window]);
            const outValue = Number.isFinite(outValueRaw) ? outValueRaw : 0;
            sum -= outValue;
            sumSquares -= outValue * outValue;
        }

        const currentWindowSize = Math.min(window, i + 1);
        const currentMean = sum / currentWindowSize;
        const variance = Math.max(0, (sumSquares / currentWindowSize) - (currentMean * currentMean));

        mean[i] = currentMean;
        stdDev[i] = Math.sqrt(variance);
    }

    return { mean, stdDev };
}

