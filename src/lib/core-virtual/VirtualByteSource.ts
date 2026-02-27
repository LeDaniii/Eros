export interface VirtualByteSource {
    readonly kind: string;
    getSize(signal?: AbortSignal): Promise<number>;
    readRange(startByte: number, endByteExclusive: number, signal?: AbortSignal): Promise<ArrayBuffer>;
    close?(): Promise<void> | void;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
    }
}

export function normalizeByteRange(
    startByte: number,
    endByteExclusive: number,
    totalSizeBytes: number
): { start: number; end: number } {
    const totalSize = Math.max(0, Math.floor(totalSizeBytes));
    const start = Math.max(0, Math.min(totalSize, Math.floor(startByte)));
    const end = Math.max(start, Math.min(totalSize, Math.floor(endByteExclusive)));
    return { start, end };
}
