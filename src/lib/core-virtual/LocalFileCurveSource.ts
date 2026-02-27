import { normalizeByteRange, throwIfAborted, type VirtualByteSource } from './VirtualByteSource';

export class LocalFileCurveSource implements VirtualByteSource {
    public readonly kind = 'local-file';

    constructor(private readonly file: Blob) { }

    async getSize(signal?: AbortSignal): Promise<number> {
        throwIfAborted(signal);
        return this.file.size;
    }

    async readRange(startByte: number, endByteExclusive: number, signal?: AbortSignal): Promise<ArrayBuffer> {
        throwIfAborted(signal);
        const { start, end } = normalizeByteRange(startByte, endByteExclusive, this.file.size);
        if (end <= start) {
            return new ArrayBuffer(0);
        }

        const buffer = await this.file.slice(start, end).arrayBuffer();
        throwIfAborted(signal);
        return buffer;
    }
}
