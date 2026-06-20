# Plan: rebuild live streaming as HTTP-only (no WebSocket)

Status: **design, not started** (2026-06-20). Phase-1 adaptive rendering for
*finished* results is already merged and works
(`docs/adaptive-rendering-handoff.md`); this plan covers **only the live-run path**,
which is being torn down and rebuilt.

## Why

The current live path is buggy because there are too many representations of "the
current trajectory" that must stay in sync, across several independent timing
loops:

- Backend `StreamingSimulationSink` does Arrow storage **and** re-implements the
  entire display reconstruction inline per-event (`pending_timeseries`,
  `check_gap`/`check_synthetic_start`/endpoint injection, `species_path_prev_end`)
  — a second copy of `_load_events_as_timeseries`'s logic.
- Frontend chains WS → `streamingDelta` ref → `useStreamingController` (EMA
  adaptive speed + buffer + RAF loop + branch tracking) → `StreamingAnimator` (a
  *second* RAF loop lerping axes separately from the data). Axis range and data
  are appended by different loops off a Vue watcher off a WS callback → desync,
  flicker, "data resets weirdly."

## Target design (agreed with Stefan)

**The live view is dead simple: a single active-branch FIFO showing the window
`[T − fixed, T]`, where `T` is the last streamed model-time and `fixed` is a small
constant. Nothing else is shown** — not other branches, not the trunk history.
Completed branches are reachable only after the run via the finished-result
(viewport) path.

**Transport: HTTP polling, no WebSocket.** A small fixed trailing window updated a
few times a second does not benefit from push latency. Poll an in-process "live
tail" endpoint at ~4 Hz.

### The one thing that must be right

**Serve the live tail from in-process sink state, NOT by re-reading the
`.stream.arrow` files.** The sink flushes to disk only on a 200k-event threshold,
so disk lags badly mid-run, and reading a file being appended is racy. Both
problems vanish if the tail comes from memory. The simulation already runs as an
async task in the same process and `active_controller[]` (in `GRSServer.jl`) is a
live handle to it.

## Backend changes

Files: `backend/src/simulation/streaming_sink.jl`,
`backend/src/simulation/simulation_controller.jl`, `backend/src/GRSServer.jl`.

1. **Add a live ring buffer to the sink** for the *active branch only*:
   - `Dict{Symbol, CircularBuffer-or-Vector}` keyed by species, holding recent
     `(t, value)` for the current `execution_path`, bounded to `fixed` (by time
     window or point count — point count is simpler).
   - Track `active_path::String`. When an episode with a different `path` is
     traced (branch switch), **clear the ring** and reset `active_path`.
   - Append in the existing `each_event` loop. This *replaces* `pending_timeseries`
     + `_accumulate_subscribed` + all the per-species gap/synthetic/endpoint blocks
     and `species_path_prev_end`. The ring stores raw events; no gap logic —
     `[T−fixed,T]` of one contiguous branch has no cross-episode joins to draw.
   - Keep `subscribed_species` to decide which species to retain in the ring.

2. **Strip the sink of WS/timeseries push:** delete `_stream_update`,
   `_ws_send_timeseries`, `_accumulate_subscribed`, `_ws_send` timeseries usage.
   Keep: Arrow storage (`_flush_channel!`, `_write_index!`, `flush!`), per-segment
   progress tracking, pause check, and the new ring. Progress no longer needs WS;
   it's read via the live endpoint.

3. **New endpoint** `GET /simulations/{id}/live` in `GRSServer.jl`:
   - If `id` is the running sim (`active_controller[]` matches), return from the
     sink ring: `{ status, current_time, active_path, series: { species: [[t,v],…] } }`.
     `current_time` = latest `t` seen; `series` = the ring contents (already
     `[T−fixed,T]`).
   - If not running (already finished), return `{ status: "completed", … }` so the
     poller knows to stop and switch to the viewport path.
   - Needs a lock around ring reads (sim task writes concurrently) — mirror the
     existing `ws_lock`/`active_controller` pattern.

4. **Move pause/resume to HTTP** (currently WS messages in `_handle_ws_message`):
   `POST /simulations/{id}/pause` and `/resume` calling `pause!`/`resume!` on
   `active_controller[]` + `update_result_metadata`. Subscriptions
   (`subscribe_genes!`) also move to an HTTP call or a query param on `/live`
   (e.g. `?species=a,b`) so the ring retains the right species.

5. **Delete** `@websocket "/ws"`, `_handle_ws_message`, `ws_client`, `WS_LOCK`
   (keep a lock for the ring), and the phase-space `phasespace_ready` WS push —
   `phasespace` becomes "noticed on the next `/live` poll" or a one-shot poll of
   the existing `/simulations/{id}/phasespace` after completion.

## Frontend changes

Files: `frontend/src/composables/useSimulationStream.ts` (delete),
`frontend/src/composables/useStreamingController.ts` (delete),
`frontend/src/charts/StreamingAnimator.ts` (delete),
`frontend/src/stores/simulationStore.ts`, `frontend/src/components/TrackViewer.vue`,
`frontend/src/charts/MainChart.ts`, `frontend/src/services/simulationService.ts`,
`frontend/src/charts/panels/{CountsPanel,PromoterPanel}.ts`.

1. **Delete** `useSimulationStream`, `useStreamingController`, `StreamingAnimator`,
   `streamingDelta`, and the store's `_onTimeseries`/`_onProgress`/WS tracking.

2. **New poll loop** (small composable or inline in `TrackViewer`): while
   `isSimulationRunning`, `setInterval(~250ms)` →
   `simulationService.fetchLive(id, subscribedSpecies)` →
   - update progress/status from the response;
   - `chart.setSimulationData(series, { fitAxes: false })` for the active branch;
   - pin the x-axis to `[current_time − FIXED, current_time]` (new small
     `MainChart` helper, e.g. `setLiveWindow(t0, t1)`; zoom already disabled during
     streaming via `setZoomEnabled(false)`);
   - when status flips to `completed`/`error`: stop the loop, re-enable zoom,
     `clearTimeseriesCache`, and fall through to the normal finished-result
     viewport refresh (`refreshSimulationData()`), then poll phasespace once.

3. **Client FIFO:** keep `STREAMING_FIFO_CAPACITY` on the live series in
   `CountsPanel`/`PromoterPanel` as a safety bound, sized to `fixed` (or just rely
   on the server ring already being `[T−fixed,T]` and use plain `clear()`+`appendRange`
   each poll — simpler, and avoids the live-vs-finished `seriesMap` fifo mismatch
   that exists today). **Prefer clear+appendRange each poll** since the window is
   small and server-bounded; drop the per-series `fifoCapacity` entirely.

4. `runSimulation` in the store: drop the `stream.connect()/track()` dance and the
   fast-completion WS race handling; just POST `/simulations/run`, then start the
   poll loop. The fast-finish case is handled naturally — first poll returns
   `completed`.

## Gap-reconstruction cleanup (fold into this rebuild)

After the rebuild, gap/discontinuity reconstruction is needed in **exactly one
place**: the post-hoc load path that feeds the viewport pyramid
(`_load_events_as_timeseries` in `backend/src/simulation/simulation.jl`). Live no
longer reconstructs anything (the sink ring stores raw events of one contiguous
branch — no cross-episode joins to draw). So this is the moment to delete the
`GapTracker` reinvention rather than maintain it.

Files: `backend/src/simulation/gap_tracking.jl` (delete the module),
`backend/src/simulation/simulation.jl`, `backend/src/GRSServer.jl` (drop
`using .GapTracking`), `backend/src/simulation/streaming_sink.jl` (its `GapTracker`
usage is already removed by the streaming rebuild above).

Steps:

1. **Mirror the native `Catenation` reconstruction** (canonical source:
   `tools/inspect/src/visualization.jl` in the pinned GRS rev — the
   `attach_trajectory_components!(::Type{CountSeries})` method). The native model
   per `(species, path)`:
   - events grouped per segment/episode, rendered as `stairs(step=:post)`;
   - **carry-forward to segment end** is inline: `if last(series.ts) < to → hold
     last value to to` — this is the same thing the app calls "endpoint injection",
     not a separate concept;
   - **cross-episode join**: a connector from the previous segment's `to`/last-y to
     the next segment's first point. The app encodes the discontinuity as a `GAP`
     (`-1`) sentinel pair so the frontend breaks the line (`drawNaNAs`), instead of
     drawing the native dashed connector — keep the sentinel encoding (the pyramid
     and `CountsPanel` already understand it), just derive it from the same
     per-segment walk.

2. **Replace `GapTracker` + `check_gap`/`check_synthetic_start` with a single clean
   pass** in `_load_events_as_timeseries`: it already groups by
   `(path, episode_i)`, sorts episodes by `from`, and walks them in order. Fold the
   discontinuity decision directly into that walk — when the next episode's start
   does not abut the previous episode's `to` (using the `index.arrow`
   `from`/`to`/`previous` columns, which *are* the native backlinks), emit the
   `GAP` sentinel pair; carry forward to `to`; prepend the synthetic start only at a
   genuine bridging-run boundary. No separate stateful tracker object, no
   `run_predecessor`/`last_to` dicts.

3. The `index.arrow` already carries `from`, `to`, and enough to reconstruct
   `previous` (segment ordering per path) — prefer driving joins off that
   (native-style backlinks) rather than re-deriving via float-keyed dicts.

Net: `gap_tracking.jl` is deleted; `_load_events_as_timeseries` becomes one
readable per-`(species,path)` segment walk that mirrors `Catenation`; the pyramid
consumes its output exactly as today (`GAP` sentinels unchanged).

## What stays

- Adaptive viewport pyramid + `/timeseries/viewport` (finished results) — unchanged.
- Arrow storage format and `index.arrow` (the `from`/`to`/`previous` columns become
  the backlinks the cleaned-up reconstruction drives off).
- `_load_events_as_timeseries` stays as the reconstruction feeding the pyramid, but
  its **gap logic is rewritten** per the cleanup section above.
- `MainChart.setZoomEnabled` (zoom locked during live), `setSimulationData`,
  panels' series reuse, the `GAP`/`-1` sentinel contract.

## Caveats / decisions already made

- **Active branch only** (not all branches) during live — confirmed.
- Update cadence = poll interval (~250ms); tunable. Imperceptible for a monitor.
- `GapTracker` (both the streaming copy *and* the HTTP-load copy) is deleted in
  this rebuild — see "Gap-reconstruction cleanup" above. The streaming side stops
  reconstructing entirely; the load side is rewritten to mirror native
  `Catenation`+backlinks (`docs/adaptive-rendering-handoff.md`).
- Storage resolution stays governed by the schedule's `step`/`skip` (source-side
  lever); the pyramid decouples display only. Do **not** force `record=true`.

## Suggested order

1. Backend: ring buffer in sink + `/live` endpoint + HTTP pause/resume; keep WS
   temporarily so the app still runs.
2. Frontend: build the poll loop against `/live`; verify on a real run.
3. Delete WS (`/ws`, `useSimulationStream`, controller, animator) once polling works.
4. Gap-reconstruction cleanup: rewrite `_load_events_as_timeseries`'s gap logic to
   mirror `Catenation`, then delete `gap_tracking.jl` and its `using`s. Verify the
   viewport pyramid output is unchanged on an existing result (same `GAP` sentinels,
   same decimated points) before/after — this is a pure refactor of the load path.
5. Tune `FIXED` window + poll interval on a `cel_full` run.
