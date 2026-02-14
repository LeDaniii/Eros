/**
 * Eros Charts - High-Performance gRPC Charts mit WebGPU
 *
 * Public API Export
 */

// === Main API ===
export { ErosChart } from './api/ErosChart';
export type { ErosChartOptions, StreamOptions } from './api/ErosChart';

// === Advanced Components (falls jemand direkt darauf zugreifen will) ===
export { WebGPURenderer } from './renderer/WebGPURenderer';
export { GridOverlay } from './renderer/GridOverlay';
export { SharedRingBuffer } from './core/SharedRingBuffer';
