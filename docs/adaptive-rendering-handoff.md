# Handoff: adaptive (multi-resolution) timeseries rendering

> **STATUS (2026-06-20): phase 1 implemented.** Backend pyramid
> (`backend/src/simulation/viewport.jl`, OHLC time-binned, lazy per-species,
> in-memory cached) + `POST /simulations/{id}/timeseries/viewport` (returns the
> same `SimulationData` shape, ≲2×width_px points). Frontend: `fetchViewport`
> service/store, `MainChart.onViewportChange`/`getViewport` (debounced 150ms) wired
> in `TrackViewer.refreshSimulationData`, `setSimulationData(…, {fitAxes})` preserves
> zoom; live runs bounded via `STREAMING_FIFO_CAPACITY`. Verified on a 256MB run:
> 55× reduction on a 107k-pt series, bound holds, sub-ms cached queries; cold
> per-species build ≈5s (dominated by the Arrow scan, not binning).
>
> **DECISIONS (2026-06-20):** (1) **Keep `step`/`skip` as the source-side storage
> lever** — the pyramid decouples *display* resolution only; we do NOT force
> `record=true` globally (would blow up disk on snapshot-only cel_full). The
> `step→skip` coupling is GRS core (`scheduling.jl:156-173`); to get full events
> you must author schedules without `step`. (2) **GapTracker→Catenation cleanup is
> a separate follow-up commit** (not done here; this commit is additive only).

You're picking up **phase 1** of the TrackViewer redesign (full context:
`docs/trackviewer-redesign.md`). Scope is **only** adaptive subsampling of
trajectory data — do not touch the schedule timeline or panel layout yet.

## Goal

Stop shipping full-resolution timeseries to the client. The client should only
ever hold ~screen-resolution data per series, regardless of total simulation
length. This is what's currently clogging SciChart's memory. Build a
**path-keyed, time-binned, multi-resolution pyramid** and a **viewport query**
that returns ≤ ~2×width_px points for a given window. Decision already made:
**build the full pyramid** (not just on-demand bucketing).

## READ GRS.jl FIRST

GRS.jl is the source of truth. Before writing code, read the canonical
reconstruction in the GRS version the backend actually depends on (the rev pinned
in `backend/Project.toml`), not a local dev checkout that may diverge from it.

Relevant files:
- `tools/inspect/src/visualization.jl` + `InspectTool.jl` — **canonical
  trajectory reconstruction** (`Catenation`, step-function rendering, segment joins).
- `tools/experiment/src/ExperimentTool.jl` — canonical Arrow event storage (`Sink`,
  `Channel`) that the app's `StreamingSimulationSink` copies.

## CRITICAL: the data is SSA (stochastic) step-function data

SSA output is a **piecewise-constant, right-continuous step function** with
**irregular, bursty event times** (a count holds until the next reaction fires).
There is **no source-side resolution knob** for stored SSA data (`JumpModel` records
all jumps or only the final state — verify against the depended-on GRS rev) — so viz
decimation is the only lever, and it must sit ON TOP of the canonical reconstruction,
not replace it.

Build on the native `Catenation` model (`InspectTool`), which already encodes:
- **`stairs!(…, step=:post)`** — right-continuous step rendering. Decimated output
  must still render as post-step stairs.
- **Carry-forward to segment end** is canonical/inline:
  `if last(series.ts) < to → hold last value to to`. (Don't reinvent as "empty-bin
  fill" — it's the same thing the catenation already does.)
- **Cross-episode joins** via computed `previous`/`backlinks` (dashed connector
  from previous segment's `to` to next segment's first point).
- **`LIMITS.catenations = 500`** — upstream itself bails past 500 catenations; the
  adaptive work is exactly what lets the app exceed that.

Pitfalls:
- **Do NOT interpolate.** `backend/src/simulation/timeseries_summary.jl` builds a
  uniform grid and interpolates — WRONG for step data (invents fractional counts,
  smooths discreteness). **Cautionary example, not a foundation.**
- **The app's `GapTracker` (`streaming_sink.jl`: `check_gap`,
  `check_synthetic_start`, endpoint injection, `GapTracking`) is a from-scratch
  reinvention of `Catenation` + `backlinks`.** Prefer mirroring / porting the
  native InspectTool logic over extending GapTracker. If you must touch GapTracker,
  know it duplicates a native idiom.
- **Never average across replicates or paths.** Averaging destroys stochasticity.
  Decimate per `(species, path)`; replicates stay separate series.
- **`Resampling` models are biological** (cell-division molecule subsampling), NOT
  viz decimation — do not conflate.
- **ODE is the same code path.** Adaptive ODE solvers also emit variable
  timepoints; time-binning works (just smoother). Counts are integers, so min/max
  preserve true integer extremes.

## Per-bin summary: OHLC-style, not single-value

For each time-bin store `(t, first, min, max, last)`:
- `min`/`max` catch spikes within the bin (single-value-per-bin loses them — the
  trap).
- `first`/`last` give entry/exit values so a **step trace** connects correctly to
  neighboring bins.

Render client-side as a step/digital line (not linear), using last-carry across
empty bins.

## Pyramid: hierarchically aligned bins (cheap to build)

Align bins so each level-(k+1) bin is the union of two level-k bins. Build coarse
from fine by merging — no rescanning raw:
- `min = min(left.min, right.min)`
- `max = max(left.max, right.max)`
- `first = left.first`
- `last = right.last`

Level 0 should be a thin wrapper over the raw Arrow events. **Prefer building
higher levels lazily/cached per accessed (species, path)** rather than eagerly for
every species at finalize — cel_full has many paths and you rarely view them all.
**Measure build-cost-at-finalize and disk footprint on a real cel_full run before
committing to eager-all.** Storage is already columnar Arrow alongside
`events_*.arrow`, so pyramid levels are just more Arrow files.

## Transport: HTTP pyramid for finished results, simple FIFO for live

The pyramid/viewport complexity lives ONLY in the finished-result path. Live
streaming is deliberately simple.

- **Finished result:** viewport query is request/reply → **HTTP**. Params
  `{species, path, t0, t1, width_px}`, returns ≤ ~2×width_px bins from the offline
  pyramid. Stateless, cacheable. Wire to SciChart's `visibleRangeChanged`
  (debounce ~150ms). Which branches/paths are shown is governed by the user's
  path-filter / selection — never render the full fan-out at once.
- **Live run = follow the single active execution path.** Branches run
  **sequentially** in wall-clock (they overlap in model-time, re-covering
  `[t_branch, t_end]` each), so at any instant only one branch is producing data.
  Stream only that active path over the existing WebSocket (`streaming_sink.jl`)
  into a SciChart DataSeries with **`fifoCapacity`** (trailing window, WASM bound
  for free). **On branch switch** (model-time resets to the branch point), **clear
  the live series and start fresh** for the new active path — the previous branch
  is already flushed to Arrow, so nothing is lost.
  - No client-side pyramid, no whole-run-in-memory, no multi-branch overlay live.
  - Completed/other branches are NOT shown during the run; they become available
    via the finished-result path when the run ends.
  - Because only one monotonic branch is shown at a time, the non-monotonic-time
    problem does not arise; don't try to auto-chase a "leading edge" across
    branches.
- **Zoom into history during a live run:** the past is already flushed to Arrow
  incrementally, so this is just an HTTP query against the partial files. The two
  regimes compose; no special handling needed.

DEFERRED (phase 2, with the timeline redesign — NOT this phase): the schedule
timeline should indicate which branch is currently live, so a branch switch reads
as intentional rather than the data mysteriously resetting.

## Frontend: reuse SciChart series, don't recreate them

`MainChart.setSimulationData` currently **recreates** renderable series every call
— that's the slow/janky path and will flicker on resolution swaps. For adaptive,
**keep the `XyDataSeries`/`RenderableSeries` objects alive** and on a resolution
swap call `dataSeries.clear()` + `appendRange(x, y)` (bulk typed-array copy into
WASM, sub-ms at screen resolution). Optionally keep previous data until the new
window arrives to avoid flashes.

Do **not** use SciChart's built-in `resamplingMode` — it cuts draw time but still
needs all points resident client-side, which is the memory problem we're solving.

## Key files

- `backend/src/simulation/simulation.jl` — `load_timeseries_for_species`,
  `_load_events_as_timeseries` (HTTP load path; add viewport query here).
- `backend/src/simulation/streaming_sink.jl` — live WS push + the gap logic to reuse.
- `backend/src/simulation/timeseries_summary.jl` — cautionary example (uniform-grid
  interpolation); salvage nothing but the structure.
- `backend/src/GapTracking` — reuse for empty-bin carry-forward.
- `frontend/src/charts/MainChart.ts` — `setSimulationData` / `appendStreamingData...`
  (refactor to series-reuse + clear/appendRange).
- `frontend/src/composables/useSimulationStream.ts` — WS message handling.
- `frontend/src/stores/simulationStore.ts` — timeseries fetch/cache.

## Definition of done for phase 1

- Viewport HTTP query returning OHLC-step bins, ≤ ~2×width_px, gap-correct.
- Pyramid built (lazy per-path) and queries pick the right level.
- Live streaming applies the same bucketing.
- Frontend swaps resolution on zoom/pan via clear+appendRange without flicker.
- Measured: client memory stays bounded on a long cel_full run; report
  finalize-time + disk cost of the pyramid.
</content>
