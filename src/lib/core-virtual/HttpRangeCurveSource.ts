import { throwIfAborted, type VirtualByteSource } from './VirtualByteSource';

export interface HttpRangeCurveSourceOptions {
    headers?: HeadersInit;
    credentials?: RequestCredentials;
    mode?: RequestMode;
    cache?: RequestCache;
}

export class HttpRangeCurveSource implements VirtualByteSource {
    public readonly kind = 'http-range';
    private resolvedSizeBytes: number | null = null;

    constructor(
        private readonly url: string,
        private readonly options: HttpRangeCurveSourceOptions = {}
    ) { }

    async getSize(signal?: AbortSignal): Promise<number> {
        throwIfAborted(signal);
        if (this.resolvedSizeBytes !== null) {
            return this.resolvedSizeBytes;
        }

        const headResponse = await fetch(this.url, {
            method: 'HEAD',
            headers: this.options.headers,
            credentials: this.options.credentials,
            mode: this.options.mode,
            cache: this.options.cache,
            signal,
        });

        if (headResponse.ok) {
            const contentLength = Number(headResponse.headers.get('content-length'));
            if (Number.isFinite(contentLength) && contentLength >= 0) {
                this.resolvedSizeBytes = Math.floor(contentLength);
                return this.resolvedSizeBytes;
            }
        }

        const probeResponse = await fetch(this.url, {
            method: 'GET',
            headers: this.withRangeHeader(0, 0),
            credentials: this.options.credentials,
            mode: this.options.mode,
            cache: this.options.cache,
            signal,
        });

        if (!probeResponse.ok) {
            throw new Error(`Range probe failed: HTTP ${probeResponse.status}`);
        }

        const contentRange = probeResponse.headers.get('content-range');
        if (contentRange) {
            const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange);
            if (match) {
                const totalSize = Number(match[1]);
                if (Number.isFinite(totalSize) && totalSize >= 0) {
                    this.resolvedSizeBytes = Math.floor(totalSize);
                    return this.resolvedSizeBytes;
                }
            }
        }

        const fallbackLength = Number(probeResponse.headers.get('content-length'));
        if (Number.isFinite(fallbackLength) && fallbackLength >= 0) {
            this.resolvedSizeBytes = Math.floor(fallbackLength);
            return this.resolvedSizeBytes;
        }

        throw new Error('Could not determine remote file size (missing Content-Length/Content-Range).');
    }

    async readRange(startByte: number, endByteExclusive: number, signal?: AbortSignal): Promise<ArrayBuffer> {
        throwIfAborted(signal);

        const start = Math.max(0, Math.floor(startByte));
        const endExclusive = Math.max(start, Math.floor(endByteExclusive));
        if (endExclusive <= start) {
            return new ArrayBuffer(0);
        }

        const expectedLength = endExclusive - start;
        const endInclusive = endExclusive - 1;
        const response = await fetch(this.url, {
            method: 'GET',
            headers: this.withRangeHeader(start, endInclusive),
            credentials: this.options.credentials,
            mode: this.options.mode,
            cache: this.options.cache,
            signal,
        });

        if (!response.ok) {
            throw new Error(`Range request failed: HTTP ${response.status}`);
        }

        if (response.status !== 206) {
            throw new Error('Server does not support byte ranges (expected HTTP 206 Partial Content).');
        }

        const buffer = await response.arrayBuffer();
        throwIfAborted(signal);

        if (buffer.byteLength !== expectedLength) {
            throw new Error(
                `Range size mismatch: expected ${expectedLength} bytes, got ${buffer.byteLength} bytes.`
            );
        }

        return buffer;
    }

    private withRangeHeader(startInclusive: number, endInclusive: number): HeadersInit {
        const headers = new Headers(this.options.headers);
        headers.set('Range', `bytes=${startInclusive}-${endInclusive}`);
        return headers;
    }
}
