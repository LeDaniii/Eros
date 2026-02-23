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

## 11. Power User v1 Scope (P0/P1)

- [ ] `P0`: Dual cursors with delta readout (`dt`, `dY`, slope/frequency helpers).
- [ ] `P0`: Multi-curve controls (visibility, color, units, per-curve Y lock/auto).
- [ ] `P0`: Fast navigation (overview/minimap + jump to timestamp/sample index).
- [ ] `P0`: Markers/bookmarks with notes for investigation findings.
- [ ] `P0`: Session state save/load (viewport, curve config, markers, alignment).
- [ ] `P0`: Export selected time range to `CSV` and `PNG` snapshot.
- [ ] `P0`: Stream controls (pause/resume/reconnect + buffer occupancy indicator).
- [ ] `P1`: Keyboard-first workflow (shortcuts for cursors, zoom presets, curve toggles).
- [ ] `P1`: Data quality overlays (gaps, clipping, dropouts, saturation).
- [ ] `P1`: Lightweight performance HUD (`FPS`, frame time, memory).

## 12. Next 2 Weeks (Concrete)

- [ ] Decouple worker configuration and implement proper stream abort.
- [ ] Remove hot-path debug logs and isolate crosshair/grid redraw cost.
- [ ] Implement incremental GPU uploads instead of full uploads.
- [ ] Deliver first multi-curve API vertical slice (`addCurve/removeCurve`).
- [ ] Deliver first power-user analysis slice (dual cursor + delta readout).
- [ ] Add jump-to-time/sample command for fast navigation.
- [ ] Build `5x2M` benchmark fixture and establish baseline metrics.
- [ ] Add base OSS files (`LICENSE`, `CONTRIBUTING`, `CODE_OF_CONDUCT`).

## 13. v1.0 Definition of Done

- [ ] Live Mode is stable for minute-long runs and useful for debugging.
- [ ] Investigation Mode can overlay `5 x 2M` points with smooth interaction.
- [ ] Peak/spike preservation is proven by tests and benchmarks.
- [ ] Power-user analysis flow is usable end-to-end (cursor delta, markers, export, session restore).
- [ ] API is documented, versioned, and OSS-ready.
- [ ] CI/CD and release process are reproducible.

---

## 14. Industry-Grade Features

Excludes: industrial protocols (Siemens, OPC UA, PROFINET, EtherCAT, Modbus, etc.)

### 14.1 Multi-Axis / Split Pane Layout (P0)

- [ ] Multiple Y-axes per chart (left + right, or N axes).
- [ ] Per-curve axis assignment with independent scaling.
- [ ] Split pane / sub-chart layout (vertically stacked panels sharing one X-axis).
- [ ] Drag-and-drop curves between panes.
- [ ] Configurable pane heights (drag dividers to resize).
- [ ] Synchronized X-axis zoom/pan across all panes.
- [ ] Independent Y-axis auto-scale per pane.

### 14.2 Signal / Channel Tree (P0)

- [ ] Hierarchical signal browser (tree view with groups/folders).
- [ ] Drag-and-drop signals from tree into chart panes.
- [ ] Signal metadata display (name, unit, sample rate, data type, source).
- [ ] Search/filter signals by name, unit, or tag.
- [ ] Favorite/pin frequently used signals.
- [ ] Signal grouping (e.g., "Motor 1", "Temperature Sensors").

### 14.3 Time Axis Formatting (P0)

- [ ] Absolute timestamp axis (date + time with configurable format).
- [ ] Relative time axis (seconds/minutes from trigger or recording start).
- [ ] Auto-scale tick formatting: `ns` → `us` → `ms` → `s` → `min` → `h`.
- [ ] Playback mode (animate viewport forward at configurable speed).
- [ ] Scroll-through mode (arrow keys or mouse wheel to step through time).

### 14.4 Cursor Readout Panel (P0)

- [ ] Table showing `Signal | Value@A | Value@B | Delta | Unit` for all visible curves.
- [ ] Cursor lock to specific curve for value readout.
- [ ] Horizontal reference lines (draggable Y-thresholds with labels).

### 14.5 Trigger & Search (P1)

- [ ] Find next/previous point where `signal > threshold` (rising/falling edge).
- [ ] Pattern search (spike, dropout, saturation).
- [ ] Search results as navigable list with jump-to-time.
- [ ] Highlight found regions on the chart.
- [ ] Boolean trigger expressions (e.g., `signal_A > 5.0 AND signal_B < 1.0`).

### 14.6 Math / Virtual Channels (P1)

- [ ] Formula editor: virtual signals from expressions (e.g., `A - B`, `abs(A)`, `A * 0.5 + offset`).
- [ ] Built-in math functions: `abs`, `sqrt`, `pow`, `log`, `sin`, `cos`, `min`, `max`, `clamp`.
- [ ] Derivative (`dY/dt`) and integral channels.
- [ ] Moving average / low-pass filter channel.
- [ ] RMS calculation over configurable window.
- [ ] Math channels render like normal curves (color, axis, visibility).

### 14.7 FFT / Frequency Analysis (P1)

- [ ] FFT of selected time window (configurable window size and overlap).
- [ ] Magnitude spectrum display (linear and dB scale).
- [ ] Spectrogram / waterfall view (frequency vs time heatmap).
- [ ] Windowing functions: Hanning, Hamming, Blackman, Flat-Top, Rectangular.
- [ ] Peak detection in frequency domain with frequency/amplitude readout.
- [ ] Cursor-linked FFT (auto-update when cursor or viewport moves).

### 14.8 Statistics Panel (P1)

- [ ] Per-curve stats for visible range: `min`, `max`, `mean`, `RMS`, `std dev`, `peak-to-peak`.
- [ ] Statistics table with all visible curves in rows.
- [ ] Live update as viewport changes.
- [ ] Optional: histogram view of value distribution.

### 14.9 Line Style & Visual Customization (P0)

- [ ] Line width (thin/medium/thick or pixel value).
- [ ] Line style: solid, dashed, dotted.
- [ ] Point markers at sample positions (circle, square, cross — when zoomed in).
- [ ] Fill/area mode (fill between curve and zero or between two curves).
- [ ] Step/staircase rendering mode (for digital/discrete signals).
- [ ] Grid line style and density control.
- [ ] Axis label formatting (engineering notation, scientific, fixed decimals).

### 14.10 Data Import / Export (P0)

- [ ] CSV import/export (configurable delimiter, header, timestamp format).
- [ ] TDMS file import (NI LabVIEW standard format).
- [ ] MDF/MF4 file import (ASAM standard, automotive).
- [ ] HDF5 file import (scientific data).
- [ ] Export selected time range (not just full recording).
- [ ] PNG/SVG screenshot export (publication-quality with axes, labels, legend).
- [ ] PDF report export (chart + statistics + metadata).
- [ ] Clipboard copy of cursor values or statistics table.

### 14.11 Print / Report Generation (P2)

- [ ] Print layout configuration (page size, orientation, margins).
- [ ] Multi-chart print layout (multiple views on one page).
- [ ] Header/footer with metadata (recording name, date, operator, comments).
- [ ] Batch report generation (template-based).

### 14.12 Annotation & Range Markers (P0)

- [ ] Range markers (highlighted time regions with color and label).
- [ ] Text annotations anchored to (time, value) coordinates.
- [ ] Marker management panel (list, edit, delete, jump-to).
- [ ] Import/export markers (JSON or CSV).
- [ ] Markers visible in overview/minimap.

### 14.13 Layout & Workspace Management (P1)

- [ ] Save/load workspace layouts (signals, panes, axis config, colors).
- [ ] Layout templates for common use cases.
- [ ] Tab-based multi-chart views.
- [ ] Responsive layout (adapt to window resize, fullscreen mode).
- [ ] Detachable/floating chart panels (pop out into separate window).

### 14.14 Recording / Session Management (P1)

- [ ] Recording browser (list sessions with metadata: date, duration, channel count, size).
- [ ] Recording metadata editor (name, description, tags, operator notes).
- [ ] Auto-save live recordings to disk (configurable trigger).
- [ ] Recording segmentation (split long recordings into named segments).
- [ ] Recording comparison (side-by-side or overlay of two recordings).

### 14.15 Multi-Channel Scalability (P0)

- [ ] Support `50+` channels simultaneously loaded in memory.
- [ ] Lazy loading: only decode/render channels that are currently visible.
- [ ] Channel enable/disable without unloading from memory.
- [ ] Per-channel sample rate support (mixed rates, proper time alignment).
- [ ] Efficient memory management (shared time axis, columnar storage).

### 14.16 Alarm / Threshold Visualization (P2)

- [ ] Configurable alarm thresholds per signal (upper/lower warning + critical).
- [ ] Visual threshold bands on chart (colored zones: green/yellow/red).
- [ ] Alarm event log (timestamp + signal + value + threshold crossed).
- [ ] Color-code curve segments that exceed thresholds.
- [ ] Alarm statistics (count, duration above threshold, first/last occurrence).

### 14.17 Digital / Boolean Signal Support (P1)

- [ ] Dedicated digital/boolean rendering (high/low states, not analog line).
- [ ] Compact digital pane (multiple booleans stacked like a logic analyzer).
- [ ] State label display ("ON"/"OFF", "OPEN"/"CLOSED" instead of 1/0).
- [ ] Configurable state colors (green=ON, red=FAULT).
- [ ] Edge counting and timing measurement for digital signals.

### 14.18 Plugin / Extension System (P2)

- [ ] Plugin API: register custom data sources, renderers, analysis tools.
- [ ] Custom data source adapter interface (for proprietary formats).
- [ ] Custom analysis plugin interface (run user code on visible data range).
- [ ] Custom visualization plugin (render overlays on chart canvas).
- [ ] Plugin discovery and loading mechanism.
