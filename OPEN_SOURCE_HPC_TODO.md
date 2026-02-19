# Eros Charts: Open Source High Performance TODO

Status: Working Draft  
Date: 2026-02-19

## 0. Product Goal (Fixed)

- [ ] Visualize measurement curves for debugging, including long-running sessions.
- [ ] Ship two core modes:
- [ ] `Live Mode`: continuous stream with dynamic display.
- [ ] `Investigation Mode`: overlay and compare multiple curves.
- [ ] Hard investigation target:
- [ ] `5 curves x 2,000,000 points` (total `10,000,000` points per view).
- [ ] Explicitly support these sources:
- [ ] inverter measurements over minutes.
- [ ] analog sensors running at `10 kHz` over long durations.

## 1. Measurable v1.0 Acceptance Criteria (P0)

- [ ] `Live Mode`: stable ingest at `>= 10 kSamples/s` per channel without UI freezes.
- [ ] `Live Mode`: smooth zoom/pan (`p95 input latency < 50 ms`).
- [ ] `Investigation Mode`: load `5 x 2M` points in `< 3 s` on reference hardware.
- [ ] `Investigation Mode`: maintain at least `30 FPS` interaction on large datasets.
- [ ] Signal fidelity: peaks/spikes must not disappear due to downsampling.
- [ ] Define and enforce RAM/VRAM budgets per chart instance.
- [ ] Define reference hardware and browser support matrix.

## 2. Two-Mode Architecture (P0)

- [ ] Separate rendering paths for `Live` and `Investigation`.
- [ ] Build shared axis/cursor logic for multi-curve overlay.
- [ ] Define time-axis alignment options for multiple curves:
- [ ] absolute timestamp.
- [ ] relative start point.
- [ ] manual per-curve offset.
- [ ] Model data sources as independent curve layers.

## 3. Rendering Core (P0)

- [ ] Use incremental GPU uploads; avoid full-buffer uploads every frame.
- [ ] Make ring buffer wraparound and partial uploads correct and robust.
- [ ] Implement LOD strategy:
- [ ] min/max downsampling for zoomed-out views.
- [ ] exact rendering path for zoomed-in views.
- [ ] Optional: multi-resolution mip pyramid for very large time windows.
- [ ] Harden shaders against NaN/Inf/zero-range and device loss.
- [ ] Validate multi-curve rendering in one pass (or well-batched passes).

## 4. Investigation Mode: Multi-Curve Overlay (P0)

- [ ] Define data model for multiple curves (`curveId`, color, visibility, offset).
- [ ] Toggle curve visibility without reloading data.
- [ ] Define alpha/blend rules for overlays.
- [ ] Comparison features:
- [ ] shared cursor across all curves.
- [ ] delta measurement between two curves.
- [ ] markers and notes for findings.
- [ ] Keep synchronized zoom enabled by default for all curves.

## 5. Live Mode: Streaming Robustness (P0)

- [ ] Pass all runtime parameters from main thread to worker (no hardcoded URL).
- [ ] Implement clean stream lifecycle: start, stop, abort, restart.
- [ ] Add reconnect with exponential backoff + jitter.
- [ ] Define backpressure behavior:
- [ ] drop oldest.
- [ ] drop newest.
- [ ] adaptive decimation.
- [ ] Surface health/error state in both UI and API.

## 6. OSS API Design (P0)

- [ ] Keep a stable public API (`ErosChart`) for both modes.
- [ ] Add multi-curve API:
- [ ] `addCurve(source, options)`.
- [ ] `removeCurve(curveId)`.
- [ ] `setCurveVisibility(curveId, visible)`.
- [ ] `setCurveOffset(curveId, offsetMs)`.
- [ ] Add typed events (`onStats`, `onError`, `onViewportChange`, `onStreamState`).
- [ ] Document SemVer policy.

## 7. Testing and QA (P0)

- [ ] Unit tests: downsampler, ring buffer, viewport, curve alignment.
- [ ] Worker tests: stream protocol, abort, reconnect, error handling.
- [ ] Integration: server -> worker -> renderer for both modes.
- [ ] Regression: zoom/pan behavior on very large datasets.
- [ ] Visual regression for overlay quality and peak preservation.
- [ ] E2E with large fixture datasets (`5 x 2M`).

## 8. Benchmarking and Profiling (P0)

- [ ] Provide reproducible datasets:
- [ ] inverter-minutes fixture.
- [ ] 10kHz long-run fixture.
- [ ] 5x2M investigation fixture.
- [ ] Build KPI dashboard (`FPS`, `frame time p95`, `input latency`, `RAM`, `VRAM`).
- [ ] Add CI performance gates (fail build on regression beyond threshold).

## 9. OSS Readiness (P0)

- [ ] Choose license (`MIT` or `Apache-2.0`) and add `LICENSE`.
- [ ] Add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue/PR templates.
- [ ] Add `SECURITY.md` and disclosure process.
- [ ] Rewrite README focused on Live + Investigation + performance.
- [ ] Add architecture and troubleshooting docs (COOP/COEP, HTTPS, CORS).

## 10. CI/CD and Release (P0)

- [ ] Pipeline: lint, typecheck, unit, integration, e2e-smoke, perf-smoke.
- [ ] Test multiple Node versions in CI.
- [ ] Enable dependency and security scans.
- [ ] Configure automated npm release for tags.
- [ ] Automate changelog and versioning.

## 11. Next 2 Weeks (Concrete)

- [ ] Decouple worker configuration and implement proper stream abort.
- [ ] Remove hot-path debug logs and isolate crosshair/grid redraw cost.
- [ ] Implement incremental GPU uploads instead of full uploads.
- [ ] Deliver first multi-curve API vertical slice (`addCurve/removeCurve`).
- [ ] Build `5x2M` benchmark fixture and establish baseline metrics.
- [ ] Add base OSS files (`LICENSE`, `CONTRIBUTING`, `CODE_OF_CONDUCT`).

## 12. v1.0 Definition of Done

- [ ] Live Mode is stable for minute-long runs and useful for debugging.
- [ ] Investigation Mode can overlay `5 x 2M` points with smooth interaction.
- [ ] Peak/spike preservation is proven by tests and benchmarks.
- [ ] API is documented, versioned, and OSS-ready.
- [ ] CI/CD and release process are reproducible.
