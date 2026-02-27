import { ErosChart, type ErosBinaryCurve } from '../charts/ErosChart';

export type BinaryImportCoreMode = 'classic' | 'virtual';

export interface BinaryImportDecodeResult {
    decoded: ErosBinaryCurve;
    coreMode: BinaryImportCoreMode;
    sampleStride: number;
    originalSampleRate: number;
    originalSampleCount: number;
}

interface ErosBinaryHeader {
    version: number;
    sampleRate: number;
    sampleCount: number;
}

const EROS_BINARY_MAGIC = new Uint8Array([0x45, 0x52, 0x4f, 0x53]); // "EROS"
const EROS_BINARY_VERSION = 1;
const EROS_BINARY_HEADER_SIZE = 20;

export const VIRTUAL_CORE_SWITCH_THRESHOLD_BYTES = 1_600_000_000;
const VIRTUAL_CORE_TARGET_SAMPLES = 24_000_000;
const VIRTUAL_CORE_CHUNK_SAMPLES = 1_048_576;

export function shouldUseVirtualCoreForFile(fileSizeBytes: number): boolean {
    return fileSizeBytes > VIRTUAL_CORE_SWITCH_THRESHOLD_BYTES;
}

function parseErosBinaryHeader(headerBuffer: ArrayBuffer, fileSizeBytes: number): ErosBinaryHeader {
    if (headerBuffer.byteLength < EROS_BINARY_HEADER_SIZE) {
        throw new Error('Invalid EROS file: file too small.');
    }

    const bytes = new Uint8Array(headerBuffer);
    for (let i = 0; i < EROS_BINARY_MAGIC.length; i++) {
        if (bytes[i] !== EROS_BINARY_MAGIC[i]) {
            throw new Error('Invalid EROS file: magic header mismatch.');
        }
    }

    const view = new DataView(headerBuffer);
    const version = view.getUint16(4, true);
    if (version !== EROS_BINARY_VERSION) {
        throw new Error(`Unsupported EROS file version: ${version}.`);
    }

    const sampleRate = view.getUint32(8, true);
    const sampleCount = view.getUint32(12, true);
    if (sampleRate < 1) {
        throw new Error('Invalid EROS file: sampleRate must be > 0.');
    }

    const expectedFileSizeBytes = EROS_BINARY_HEADER_SIZE + sampleCount * 4;
    if (fileSizeBytes !== expectedFileSizeBytes) {
        throw new Error('Invalid EROS file: payload size mismatch.');
    }

    return {
        version,
        sampleRate,
        sampleCount,
    };
}

async function readErosBinaryHeader(file: Blob): Promise<ErosBinaryHeader> {
    const headerBuffer = await file.slice(0, EROS_BINARY_HEADER_SIZE).arrayBuffer();
    return parseErosBinaryHeader(headerBuffer, file.size);
}

function getVirtualImportStride(sampleCount: number): number {
    if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
        return 1;
    }

    return Math.max(1, Math.ceil(sampleCount / VIRTUAL_CORE_TARGET_SAMPLES));
}

async function decodeLargeBinaryFileVirtual(
    file: Blob,
    header: ErosBinaryHeader,
    sampleStride: number
): Promise<ErosBinaryCurve> {
    const targetSampleCount = Math.max(1, Math.ceil(header.sampleCount / sampleStride));
    const values = new Float32Array(targetSampleCount);
    const effectiveSampleRate = Math.max(1, Math.round(header.sampleRate / sampleStride));

    let writeIndex = 0;
    let nextSampleIndex = 0;

    for (let chunkStart = 0; chunkStart < header.sampleCount; chunkStart += VIRTUAL_CORE_CHUNK_SAMPLES) {
        const chunkEnd = Math.min(header.sampleCount, chunkStart + VIRTUAL_CORE_CHUNK_SAMPLES);
        const byteStart = EROS_BINARY_HEADER_SIZE + chunkStart * 4;
        const byteEnd = EROS_BINARY_HEADER_SIZE + chunkEnd * 4;
        const chunkBuffer = await file.slice(byteStart, byteEnd).arrayBuffer();
        const chunkValues = new Float32Array(chunkBuffer);

        if (nextSampleIndex < chunkStart) {
            const delta = chunkStart - nextSampleIndex;
            const skippedStrides = Math.ceil(delta / sampleStride);
            nextSampleIndex += skippedStrides * sampleStride;
        }

        while (nextSampleIndex < chunkEnd && writeIndex < values.length) {
            values[writeIndex] = chunkValues[nextSampleIndex - chunkStart];
            writeIndex++;
            nextSampleIndex += sampleStride;
        }

        if (chunkStart > 0 && chunkStart % (VIRTUAL_CORE_CHUNK_SAMPLES * 16) === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }

    const finalValues = writeIndex === values.length
        ? values
        : values.slice(0, writeIndex);

    return {
        sampleRate: effectiveSampleRate,
        values: finalValues,
        version: header.version,
    };
}

export async function decodeBinaryFileForImport(file: File): Promise<BinaryImportDecodeResult> {
    const header = await readErosBinaryHeader(file);
    const virtualCoreSelected = shouldUseVirtualCoreForFile(file.size);

    if (!virtualCoreSelected) {
        const fileBuffer = await file.arrayBuffer();
        const decoded = ErosChart.decodeBinary(fileBuffer);
        return {
            decoded,
            coreMode: 'classic',
            sampleStride: 1,
            originalSampleRate: decoded.sampleRate,
            originalSampleCount: decoded.values.length,
        };
    }

    const sampleStride = getVirtualImportStride(header.sampleCount);
    const decoded = await decodeLargeBinaryFileVirtual(file, header, sampleStride);
    return {
        decoded,
        coreMode: 'virtual',
        sampleStride,
        originalSampleRate: header.sampleRate,
        originalSampleCount: header.sampleCount,
    };
}
