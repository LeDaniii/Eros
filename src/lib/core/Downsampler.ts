export interface DownsampleResult {
    /** Downsampled data: [min0, max0, min1, max1, ...]. Unused in exact mode. */
    data: Float32Array;
    /** Number of pixel buckets (= canvasWidth when downsampled) */
    bucketCount: number;
    /** Number of vertices to draw */
    vertexCount: number;
    /** Global min across visible range */
    globalMin: number;
    /** Global max across visible range */
    globalMax: number;
    /** Whether downsampling was applied */
    isDownsampled: boolean;
}

export class Downsampler {
    private static readonly THRESHOLD = 4;

    private outputBuffer: Float32Array;
    private outputCapacity: number;

    constructor(initialCanvasWidth: number = 2048) {
        this.outputCapacity = initialCanvasWidth * 2;
        this.outputBuffer = new Float32Array(this.outputCapacity);
    }

    public process(
        data: Float32Array,
        startIndex: number,
        endIndex: number,
        canvasWidth: number
    ): DownsampleResult {
        const visibleSamples = endIndex - startIndex;
        const pointsPerPixel = visibleSamples / canvasWidth;

        if (pointsPerPixel <= Downsampler.THRESHOLD) {
            return this.computeExactMinMax(data, startIndex, endIndex);
        }

        return this.downsample(data, startIndex, endIndex, canvasWidth);
    }

    private computeExactMinMax(
        data: Float32Array,
        startIndex: number,
        endIndex: number
    ): DownsampleResult {
        let globalMin = Infinity;
        let globalMax = -Infinity;

        for (let i = startIndex; i < endIndex; i++) {
            const val = data[i];
            if (val < globalMin) globalMin = val;
            if (val > globalMax) globalMax = val;
        }

        if (globalMin === Infinity) { globalMin = -2.5; globalMax = 2.5; }

        return {
            data: this.outputBuffer,
            bucketCount: 0,
            vertexCount: endIndex - startIndex,
            globalMin,
            globalMax,
            isDownsampled: false,
        };
    }

    private downsample(
        data: Float32Array,
        startIndex: number,
        endIndex: number,
        canvasWidth: number
    ): DownsampleResult {
        const bucketCount = canvasWidth;
        const requiredCapacity = bucketCount * 2;

        if (requiredCapacity > this.outputCapacity) {
            this.outputCapacity = requiredCapacity;
            this.outputBuffer = new Float32Array(this.outputCapacity);
        }

        const visibleSamples = endIndex - startIndex;
        const samplesPerBucket = visibleSamples / bucketCount;

        let globalMin = Infinity;
        let globalMax = -Infinity;
        let writeIdx = 0;

        for (let bucket = 0; bucket < bucketCount; bucket++) {
            const bucketStart = startIndex + Math.floor(bucket * samplesPerBucket);
            const bucketEnd = startIndex + Math.floor((bucket + 1) * samplesPerBucket);

            let bucketMin = Infinity;
            let bucketMax = -Infinity;

            for (let i = bucketStart; i < bucketEnd; i++) {
                const val = data[i];
                if (val < bucketMin) bucketMin = val;
                if (val > bucketMax) bucketMax = val;
            }

            if (bucketMin === Infinity) {
                bucketMin = 0;
                bucketMax = 0;
            }

            this.outputBuffer[writeIdx++] = bucketMin;
            this.outputBuffer[writeIdx++] = bucketMax;

            if (bucketMin < globalMin) globalMin = bucketMin;
            if (bucketMax > globalMax) globalMax = bucketMax;
        }

        if (globalMin === Infinity) { globalMin = -2.5; globalMax = 2.5; }

        return {
            data: this.outputBuffer,
            bucketCount,
            vertexCount: bucketCount * 2,
            globalMin,
            globalMax,
            isDownsampled: true,
        };
    }

    public onResize(canvasWidth: number): void {
        const needed = canvasWidth * 2;
        if (needed > this.outputCapacity) {
            this.outputCapacity = needed;
            this.outputBuffer = new Float32Array(this.outputCapacity);
        }
    }
}
