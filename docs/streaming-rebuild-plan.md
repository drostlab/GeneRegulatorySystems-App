# Live simulation over HTTP

Status: **implemented** (2026-06-21).

This rebuild replaces the WebSocket/delta/animation pipeline with a bounded,
lineage-aware in-process live tail polled over HTTP. Finished results continue to
use the adaptive viewport pyramid described in `adaptive-rendering-handoff.md`.

## Behaviour

- The live view follows one currently executing **lineage**. A lineage is the
  execution-path prefix through its last branching `/n` component, matching the
  branch identity used by the pinned GRS `InspectTool`.
- Sequential `+` and `-n` path changes remain in the same live tail. Entering a
  nested branch or moving to a sibling branch clears it.
- Series remain keyed by their exact execution paths. This preserves the current
  promoter/timeline layout while making lineage the enclosing identity.
- Only selected species retain history. The sink keeps one latest scalar value
  for every encountered species so a newly selected species can start at the
  current model time. Its earlier live history is deliberately unavailable; the
  finished viewport provides definitive history after completion.
- Live series contain raw events only. They do not perform gap, synthetic-start,
  or cross-episode reconstruction. A temporary endpoint is added only to the
  returned snapshot so quiet digital lines reach the current-time cursor.

## Backend

`SimulationController` owns a thread-safe `LiveTail`:

```text
active_lineage / active_path
current_time / frame_count / total_progress
latest_values       one scalar per encountered species
selected_species
series              selected species → execution path → raw points
```

Each selected series is bounded by both model time and point count. The current
defaults are a 1,800-model-time-unit window and 2,000 points per series, with a
128-species live-selection guard. Pruning retains a left-edge baseline where
possible. These are tuning constants, not storage-format contracts.

The poll endpoint atomically reconciles selection and returns a snapshot:

```http
POST /simulations/{id}/live
{ "species": ["gene.mRNAs", "gene.proteins"] }
```

The response contains `status`, `current_time`, `window_start`, progress,
`active_lineage`, `active_path`, and `series`. A completed/error/cancelled result
returns terminal metadata even after its controller has been released.

Lifecycle controls are HTTP-only:

```http
POST /simulations/{id}/pause
POST /simulations/{id}/resume
POST /simulations/{id}/cancel
```

Only one run may be active or starting; another run receives HTTP 409. Simulation
execution uses `Threads.@spawn`, and every supported launcher starts Julia with
`--threads=auto`, keeping Oxygen responsive during CPU-bound simulation. The run
wrapper always publishes `completed`, `error`, or `cancelled` and releases the
active controller in `finally`.

Phase-space computation is independent. After completion the frontend polls the
existing phase-space endpoint until its background computation has produced a
result.

## Frontend

`TrackViewer` owns a non-overlapping recursive poll loop:

1. Resolve currently displayed genes/other species to species names.
2. Fetch one live snapshot (normally every 250 ms; 500 ms while paused).
3. Replace panel data in place and set data, time ranges, cursor, and progress
   from that same snapshot.
4. On a terminal status, enable zoom and switch to the finished viewport path.

A generation token prevents stale responses or phase-space retries from applying
after result changes/unmount. `setTimeout` is scheduled only after each request
finishes, so live requests cannot overlap.

Deleted components:

- backend `/ws`, global WebSocket state, and WS send helpers;
- `useSimulationStream.ts`;
- `useStreamingController.ts`;
- `StreamingAnimator.ts`;
- `streamingDelta`, client streaming buffers, RAF loops, and SciChart FIFO series.

## Finished-result reconstruction

The shared `GapTracking` module was deleted. The one remaining reconstruction pass
is local to `_load_events_as_timeseries` and preserves the existing exact-path GAP
sentinel output. It still derives snapshot bridging runs from `index.arrow`.

`index.arrow` does **not** store `previous`; pinned GRS computes backlinks while
loading. Genuine backlink-derived root-to-leaf trajectory assembly is therefore
deferred to the path-first trajectory/schedule-visualisation refactor. That work
will change the finished representation deliberately instead of disguising an
exact-path reconstruction as native `Catenation` semantics.

## Verification and tuning

- Frontend production build.
- Backend module load plus lineage/live-tail assertions.
- End-to-end backend smoke simulation.
- Still tune the live window, point cap, selection guard, and polling cadence on a
  representative long `cel_full` run.
