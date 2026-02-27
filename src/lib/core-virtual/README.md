## core-virtual

`core-virtual` is the large-dataset path for Eros curves (target: 2-4 GB and beyond).

It exists next to `src/lib/core` on purpose:
- `core` remains the in-memory path (fast/simple for smaller data and live streams).
- `core-virtual` is the out-of-core path (only the visible window is loaded/rendered).

## What This Layer Is For

This layer is responsible for reading and serving very large measurement curves without loading full files into browser RAM.

Core goals:
- Keep UI responsive while zooming/panning huge files.
- Avoid `ArrayBuffer`/heap limits for multi-GB datasets.
- Support both overview (downsampled) and local exact detail.

## Planned Responsibilities

`core-virtual` is intended to provide:
- Tile-based data access (fixed-size chunks of samples).
- Multi-resolution levels (LOD pyramid, min/max per bucket).
- Viewport-driven reads (request only `[start, end]` plus a small prefetch margin).
- Memory-bounded cache (LRU/TTL) for loaded tiles.
- Worker-friendly interfaces for decode/fetch off the main thread.

## Conceptual Data Flow

1. User changes viewport (zoom/pan).
2. Chart asks virtual core for data matching current viewport and pixel density.
3. Virtual core selects the best LOD level.
4. Virtual core fetches only required tiles (plus prefetch).
5. Renderer draws the returned segment; cache retains hot tiles.

## Non-Goals

This module should not:
- Replace the current live streaming path.
- Force full-file decode in browser memory.
- Duplicate renderer logic.

## Suggested Public Interface (Draft)

The runtime implementation can evolve, but this is the intended shape:
- `open(source): Promise<DatasetHandle>`
- `getSegment(handle, range, lod): Promise<SegmentData>`
- `prefetch(handle, range, lod): Promise<void>`
- `close(handle): Promise<void>`

Where:
- `range` is sample index space (`start`, `end`).
- `lod` maps to zoom/pixels-per-sample demand.
- `SegmentData` can be exact samples or min/max buckets.

## Why A Separate Core

Keeping `core-virtual` separate avoids destabilizing the current working path and allows independent iteration on:
- file/index formats
- transport strategy (local file slices vs server range API)
- cache policy and worker execution model

This is the foundation for reliable 2-4 GB curve visualization in the browser.

## Implemented Now

This folder now contains a working virtual engine:
- `VirtualCurveEngine.ts`
- `LocalFileCurveSource.ts`
- `HttpRangeCurveSource.ts`
- `BinaryImportDecoder.ts`

What is implemented:
- Chunked local file reads in browser (`Blob.slice(...)`).
- Chunked remote reads via HTTP Range requests.
- On-demand chunk loading for requested ranges.
- Neighbor prefetch (`prefetchRange`) for smoother navigation.
- LRU-style in-memory chunk cache with configurable limit.
- Chunk compose (`composeChunks`) to merge loaded chunks into one contiguous array.

## Runtime Flow (Current Behavior)

This is the actual flow currently used by the frontend (`src/main.ts`).

1. User imports `.erosb` file(s).
2. `decodeBinaryFileForImport(file)` parses header and chooses mode by file size:
   - `<= 1_600_000_000` bytes: classic in-memory decode (`file.arrayBuffer()`).
   - `> 1_600_000_000` bytes: virtual import path.
3. Virtual import path still creates a lightweight preview signal:
   - File is read chunk-by-chunk (`1_048_576` samples per chunk).
   - A stride is applied so preview is capped near `24_000_000` samples.
   - This preview is loaded into analysis chart first (`mode = preview`).
4. In parallel, a `VirtualCurveEngine` session is opened on the original file for exact reads:
   - Chunked random access from local file (`Blob.slice`) or HTTP range source.
   - Cache limit and prefetch are active (currently `maxCachedChunks = 64`, neighbors `= 1`).
5. While user zooms/pans:
   - If preview window becomes small enough (`<= 2_000_000` original samples visible), app switches to `mode = exact`.
   - Engine loads only the needed exact sample window (not the full file).
6. In exact mode:
   - If user zooms out too wide (`>= 3_000_000` local visible samples), app switches back to preview.
   - If viewport approaches window edges (20% margin), engine recenters/reloads a new exact window.
7. Stats panel shows virtual state:
   - `Virtual: PREVIEW` or `Virtual: EXACT`
   - source sample count/size
   - total chunk count
   - current chunk index/range for current viewport
   - cache usage (`cached/max`)

## Time Axis Consistency

Exact mode renders a local window buffer, but timestamps stay in global file time.

- Chart gets a `timeOffsetSamples` equal to the exact window start sample.
- Grid and crosshair time labels use `(localSampleIndex + timeOffsetSamples) / sampleRate`.
- Result: switching preview <-> exact no longer jumps to the wrong second marker.

## Tradeoff

- Preview mode is intentionally downsampled for navigation performance.
- Exact mode restores full-detail samples, but only for the active local window.
- This keeps multi-GB analysis feasible in browser memory limits.

## Step-by-Step Examples

### A) What happens when a large curve is loaded

1. User selects a `.erosb` file.
2. Header is validated (magic, version, sample rate, payload size).
3. If file size is `> 1_600_000_000` bytes, virtual mode is selected.
4. Browser reads the file chunk-by-chunk and builds a downsampled preview.
5. Chart starts in `Virtual: PREVIEW`.
6. `VirtualCurveEngine` opens the same original file for exact on-demand chunk reads.

### B) Zoom into chunks 15-40 of 2000

1. In `PREVIEW`, viewport is mapped to global sample range (covering chunks 15-40).
2. While still zoomed out, preview data is shown (fast navigation).
3. Once visible range becomes small enough (`<= 2_000_000` original samples), mode switches to `Virtual: EXACT`.
4. Engine loads only the needed exact window for that focused region.
5. Neighbor chunks are prefetched (`+/- 1`) and cache is updated.

### C) Then zoom to chunk 20

1. If chunk 20 is already inside the current exact window/cache, render is immediate.
2. If not fully covered, engine loads missing chunk(s) on demand.
3. If viewport is near exact-window edge, a new exact window is recentered around the current focus and loaded.
4. If user zooms out too far (`>= 3_000_000` local visible samples), app returns to `Virtual: PREVIEW`.

### Chunk Index Note

- UI chunk labels are 1-based (`chunk 20` in UI is internal index `19`).
