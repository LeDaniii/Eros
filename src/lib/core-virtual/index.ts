export { LocalFileCurveSource } from './LocalFileCurveSource';
export { HttpRangeCurveSource } from './HttpRangeCurveSource';
export type { HttpRangeCurveSourceOptions } from './HttpRangeCurveSource';

export { VirtualCurveEngine } from './VirtualCurveEngine';
export type {
    VirtualCurveEngineOptions,
    VirtualCurveHeader,
    VirtualCurveChunk,
    VirtualCurveExactRangeRequest,
    VirtualCurvePrefetchRequest,
} from './VirtualCurveEngine';

export {
    decodeBinaryFileForImport,
    shouldUseVirtualCoreForFile,
    VIRTUAL_CORE_SWITCH_THRESHOLD_BYTES,
} from './BinaryImportDecoder';
export type { BinaryImportCoreMode, BinaryImportDecodeResult } from './BinaryImportDecoder';

export type { VirtualByteSource } from './VirtualByteSource';
