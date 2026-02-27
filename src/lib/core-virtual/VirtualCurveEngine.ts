import { HttpRangeCurveSource, type HttpRangeCurveSourceOptions } from './HttpRangeCurveSource';
import { LocalFileCurveSource } from './LocalFileCurveSource';
import { throwIfAborted, type VirtualByteSource } from './VirtualByteSource';

export interface VirtualCurveEngineOptions {
    chunkSamples?: number;
    maxCachedChunks?: number;
    autoPrefetchNeighborChunks?: number;
}

export interface VirtualCurveHeader {
    version: number;
    sampleRate: number;
    sampleCount: number;
    fileSizeBytes: number;
    headerSizeBytes: number;
}

export interface VirtualCurveChunk {
    chunkIndex: number;
    startSample: number;
    endSample: number;
    values: Float32Array;
}

export interface VirtualCurveExactRangeRequest {
    startSample: number;
    endSample: number;
    prefetchNeighborChunks?: number;
    signal?: AbortSignal;
}

export interface VirtualCurvePrefetchRequest {
    startSample: number;
    endSample: number;
    neighborChunks?: number;
    signal?: AbortSignal;
}

const EROS_MAGIC = new Uint8Array([0x45, 0x52, 0x4f, 0x53]); // "EROS"
const EROS_VERSION = 1;
const EROS_HEADER_BYTES = 20;

const DEFAULT_CHUNK_SAMPLES = 1_048_576;
const DEFAULT_MAX_CACHED_CHUNKS = 32;
const DEFAULT_AUTO_PREFETCH_NEIGHBORS = 1;

export class VirtualCurveEngine {
    public readonly header: VirtualCurveHeader;
    public readonly chunkSamples: number;
    public readonly chunkCount: number;
    public readonly maxCachedChunks: number;
    public readonly autoPrefetchNeighborChunks: number;

    private readonly chunkCache = new Map<number, Float32Array>();
    private readonly inFlightChunkLoads = new Map<number, Promise<Float32Array>>();

    private constructor(
        private readonly source: VirtualByteSource,
        header: VirtualCurveHeader,
        options: VirtualCurveEngineOptions
    ) {
        this.header = header;
        this.chunkSamples = Math.max(1, Math.floor(options.chunkSamples ?? DEFAULT_CHUNK_SAMPLES));
        this.chunkCount = Math.max(1, Math.ceil(header.sampleCount / this.chunkSamples));
        this.maxCachedChunks = Math.max(1, Math.floor(options.maxCachedChunks ?? DEFAULT_MAX_CACHED_CHUNKS));
        this.autoPrefetchNeighborChunks = Math.max(
            0,
            Math.floor(options.autoPrefetchNeighborChunks ?? DEFAULT_AUTO_PREFETCH_NEIGHBORS)
        );
    }

    static async openFromSource(
        source: VirtualByteSource,
        options: VirtualCurveEngineOptions = {},
        signal?: AbortSignal
    ): Promise<VirtualCurveEngine> {
        throwIfAborted(signal);
        const fileSizeBytes = await source.getSize(signal);
        const headerBytes = await source.readRange(0, EROS_HEADER_BYTES, signal);
        const header = VirtualCurveEngine.parseHeader(headerBytes, fileSizeBytes);
        return new VirtualCurveEngine(source, header, options);
    }

    static async openFromLocalFile(
        file: File | Blob,
        options: VirtualCurveEngineOptions = {},
        signal?: AbortSignal
    ): Promise<VirtualCurveEngine> {
        return VirtualCurveEngine.openFromSource(new LocalFileCurveSource(file), options, signal);
    }

    static async openFromUrl(
        url: string,
        sourceOptions: HttpRangeCurveSourceOptions = {},
        engineOptions: VirtualCurveEngineOptions = {},
        signal?: AbortSignal
    ): Promise<VirtualCurveEngine> {
        return VirtualCurveEngine.openFromSource(new HttpRangeCurveSource(url, sourceOptions), engineOptions, signal);
    }

    async getChunk(chunkIndex: number, signal?: AbortSignal): Promise<VirtualCurveChunk> {
        const normalizedChunkIndex = this.normalizeChunkIndex(chunkIndex);
        const values = await this.getOrLoadChunkValues(normalizedChunkIndex, signal);
        const startSample = normalizedChunkIndex * this.chunkSamples;
        const endSample = Math.min(this.header.sampleCount, startSample + this.chunkSamples);

        return {
            chunkIndex: normalizedChunkIndex,
            startSample,
            endSample,
            values,
        };
    }

    async getExactRange(request: VirtualCurveExactRangeRequest): Promise<Float32Array> {
        const { start, end } = this.normalizeSampleRange(request.startSample, request.endSample);
        throwIfAborted(request.signal);

        if (end <= start) {
            return new Float32Array(0);
        }

        const firstChunk = Math.floor(start / this.chunkSamples);
        const lastChunk = Math.floor((end - 1) / this.chunkSamples);
        const chunkIndices: number[] = [];

        for (let i = firstChunk; i <= lastChunk; i++) {
            chunkIndices.push(i);
        }

        const chunks = await Promise.all(chunkIndices.map((index) => this.getChunk(index, request.signal)));
        const output = new Float32Array(end - start);
        let writeOffset = 0;

        for (const chunk of chunks) {
            const localStart = Math.max(0, start - chunk.startSample);
            const localEnd = Math.min(chunk.values.length, end - chunk.startSample);
            if (localEnd <= localStart) {
                continue;
            }

            const slice = chunk.values.subarray(localStart, localEnd);
            output.set(slice, writeOffset);
            writeOffset += slice.length;
        }

        if (writeOffset < output.length) {
            return output.slice(0, writeOffset);
        }

        const prefetchNeighborChunks = request.prefetchNeighborChunks ?? this.autoPrefetchNeighborChunks;
        if (prefetchNeighborChunks > 0) {
            void this.prefetchRange({
                startSample: start,
                endSample: end,
                neighborChunks: prefetchNeighborChunks,
            }).catch(() => undefined);
        }

        return output;
    }

    async composeChunks(chunkIndices: number[], signal?: AbortSignal): Promise<Float32Array> {
        throwIfAborted(signal);

        const normalizedIndices = chunkIndices
            .map((index) => Math.floor(index))
            .filter((index) => index >= 0 && index < this.chunkCount);

        if (normalizedIndices.length === 0) {
            return new Float32Array(0);
        }

        const chunks = await Promise.all(normalizedIndices.map((index) => this.getChunk(index, signal)));
        const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.values.length, 0);
        const merged = new Float32Array(totalSamples);
        let writeOffset = 0;

        for (const chunk of chunks) {
            merged.set(chunk.values, writeOffset);
            writeOffset += chunk.values.length;
        }

        return merged;
    }

    async prefetchRange(request: VirtualCurvePrefetchRequest): Promise<void> {
        throwIfAborted(request.signal);

        const { start, end } = this.normalizeSampleRange(request.startSample, request.endSample);
        if (end <= start) {
            return;
        }

        const neighborChunks = Math.max(0, Math.floor(request.neighborChunks ?? this.autoPrefetchNeighborChunks));
        const firstChunk = Math.floor(start / this.chunkSamples);
        const lastChunk = Math.floor((end - 1) / this.chunkSamples);
        const fromChunk = Math.max(0, firstChunk - neighborChunks);
        const toChunk = Math.min(this.chunkCount - 1, lastChunk + neighborChunks);
        const tasks: Promise<Float32Array>[] = [];

        for (let i = fromChunk; i <= toChunk; i++) {
            tasks.push(this.getOrLoadChunkValues(i, request.signal));
        }

        await Promise.all(tasks);
    }

    getCacheInfo(): {
        cachedChunks: number;
        inFlightChunks: number;
        maxCachedChunks: number;
        chunkSamples: number;
        chunkCount: number;
    } {
        return {
            cachedChunks: this.chunkCache.size,
            inFlightChunks: this.inFlightChunkLoads.size,
            maxCachedChunks: this.maxCachedChunks,
            chunkSamples: this.chunkSamples,
            chunkCount: this.chunkCount,
        };
    }

    async close(): Promise<void> {
        this.chunkCache.clear();
        this.inFlightChunkLoads.clear();
        await this.source.close?.();
    }

    private normalizeChunkIndex(chunkIndex: number): number {
        const normalized = Math.floor(chunkIndex);
        if (normalized < 0 || normalized >= this.chunkCount) {
            throw new Error(`Chunk index out of range: ${chunkIndex}`);
        }
        return normalized;
    }

    private normalizeSampleRange(startSample: number, endSample: number): { start: number; end: number } {
        const maxSample = Math.max(0, this.header.sampleCount);
        const start = Math.max(0, Math.min(maxSample, Math.floor(startSample)));
        const end = Math.max(start, Math.min(maxSample, Math.floor(endSample)));
        return { start, end };
    }

    private async getOrLoadChunkValues(chunkIndex: number, signal?: AbortSignal): Promise<Float32Array> {
        const cached = this.chunkCache.get(chunkIndex);
        if (cached) {
            this.touchChunk(chunkIndex, cached);
            return cached;
        }

        const inFlight = this.inFlightChunkLoads.get(chunkIndex);
        if (inFlight) {
            return inFlight;
        }

        const loadPromise = this.loadChunkValues(chunkIndex, signal);
        this.inFlightChunkLoads.set(chunkIndex, loadPromise);

        try {
            const loaded = await loadPromise;
            this.touchChunk(chunkIndex, loaded);
            this.enforceCacheLimit();
            return loaded;
        } finally {
            this.inFlightChunkLoads.delete(chunkIndex);
        }
    }

    private touchChunk(chunkIndex: number, values: Float32Array): void {
        this.chunkCache.delete(chunkIndex);
        this.chunkCache.set(chunkIndex, values);
    }

    private enforceCacheLimit(): void {
        while (this.chunkCache.size > this.maxCachedChunks) {
            const oldestKey = this.chunkCache.keys().next().value as number | undefined;
            if (oldestKey === undefined) {
                return;
            }
            this.chunkCache.delete(oldestKey);
        }
    }

    private async loadChunkValues(chunkIndex: number, signal?: AbortSignal): Promise<Float32Array> {
        throwIfAborted(signal);
        const startSample = chunkIndex * this.chunkSamples;
        const endSample = Math.min(this.header.sampleCount, startSample + this.chunkSamples);
        const sampleCount = Math.max(0, endSample - startSample);

        if (sampleCount === 0) {
            return new Float32Array(0);
        }

        const payloadStart = EROS_HEADER_BYTES + startSample * 4;
        const payloadEnd = EROS_HEADER_BYTES + endSample * 4;
        const chunkBuffer = await this.source.readRange(payloadStart, payloadEnd, signal);
        throwIfAborted(signal);

        const expectedBytes = sampleCount * 4;
        if (chunkBuffer.byteLength !== expectedBytes) {
            throw new Error(
                `Chunk ${chunkIndex} size mismatch: expected ${expectedBytes} bytes, got ${chunkBuffer.byteLength} bytes.`
            );
        }

        const chunkValues = new Float32Array(sampleCount);
        chunkValues.set(new Float32Array(chunkBuffer));
        return chunkValues;
    }

    private static parseHeader(headerBuffer: ArrayBuffer, fileSizeBytes: number): VirtualCurveHeader {
        if (headerBuffer.byteLength < EROS_HEADER_BYTES) {
            throw new Error('Invalid EROS file: file too small.');
        }

        const bytes = new Uint8Array(headerBuffer);
        for (let i = 0; i < EROS_MAGIC.length; i++) {
            if (bytes[i] !== EROS_MAGIC[i]) {
                throw new Error('Invalid EROS file: magic header mismatch.');
            }
        }

        const view = new DataView(headerBuffer);
        const version = view.getUint16(4, true);
        if (version !== EROS_VERSION) {
            throw new Error(`Unsupported EROS file version: ${version}.`);
        }

        const sampleRate = view.getUint32(8, true);
        const sampleCount = view.getUint32(12, true);
        if (sampleRate < 1) {
            throw new Error('Invalid EROS file: sampleRate must be > 0.');
        }

        const expectedSize = EROS_HEADER_BYTES + sampleCount * 4;
        if (fileSizeBytes !== expectedSize) {
            throw new Error(
                `Invalid EROS file: payload size mismatch (expected ${expectedSize}, got ${fileSizeBytes}).`
            );
        }

        return {
            version,
            sampleRate,
            sampleCount,
            fileSizeBytes,
            headerSizeBytes: EROS_HEADER_BYTES,
        };
    }
}
