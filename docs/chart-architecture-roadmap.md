# Chart Architecture Roadmap

Status: agreed target architecture (recorded on 2026-02-24)

## Goal

Split the current chart implementation into two public chart types with clear responsibilities:

- `ErosChart` = Analysis chart
  - Zoom / pan
  - Binary import/export
  - Compare overlays
  - Sample-based or relative-time axis semantics
- `ErosStripChart` = Strip chart
  - Fixed time window
  - Real wall-clock time axis
  - Right edge = now
  - Left edge = past

## Shared vs. Specialized

Only keep truly generic pieces in shared library code:

- Renderer (`WebGPURenderer`)
- Worker / streaming pipeline
- Shared ring buffer
- Base overlays (generic grid/crosshair primitives)

Strip-chart-specific behavior must stay out of shared components:

- Strip viewport policy (follow-latest / freeze / resume)
- Wall-clock time axis formatting/rendering
- Strip-specific overlays (e.g. `StripTimeAxisOverlay`)

## Guardrails (Important)

Do not reintroduce strip-specific logic into:

- `src/lib/charts/ErosChart.ts`
- `src/lib/renderer/GridOverlay.ts`
- `src/lib/renderer/WebGPURenderer.ts`

The previous hotfix approach made behavior visible quickly, but it polluted shared components and is not the correct open-source library shape.

## Current Direction (after cleanup)

- Shared renderer and generic overlays were reset to generic behavior
- `ErosChart` was cleaned from strip time/grid hacks
- Build is green again (`npm run build`)

## Next Refactor Slices

1. Add `src/lib/charts/ErosStripChart.ts`
   - Implement as a wrapper/facade around shared chart primitives (prefer composition)
2. Remove strip-mode API/state from `src/lib/charts/ErosChart.ts`
   - Strip display-mode state and live-strip viewport strategy methods
3. Split demo usage in `src/main.ts`
   - Analysis demo uses `ErosChart`
   - Strip demo uses `ErosStripChart`
4. Add strip-specific wall-clock axis overlay
   - `StripTimeAxisOverlay` (real-time labels)
5. Add `totalWritten` to `SharedRingBuffer`
   - Needed for long-running operation and correct strip timing across ring-buffer wraparound

## Why `totalWritten` matters

`currentHead` alone is not enough for a long-running strip chart because it resets/wraps in ring-buffer terms. A monotonic counter (`totalWritten`) is required to maintain stable time mapping and correct wall-clock axis behavior during wraparound.

## Acceptance Criteria (target state)

- `ErosChart` can exist without any strip-chart concepts in its public API
- `ErosStripChart` provides strip behavior without modifying generic renderer logic
- Shared renderer/overlay code remains reusable for future chart types
- Demo app can showcase both chart types independently
