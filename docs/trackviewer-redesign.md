# TrackViewer redesign — design notes

Status: **design only** (2026-06-20). No code written yet. Captures a brainstorm
between Stefan and Claude on overhauling the schedule timeline + trajectory viewer
(`frontend/src/components/TrackViewer.vue` and the `charts/` layer).

## Problem with the current viewer

Three things are conflated onto **one SciChart surface with a shared X axis**:
the schedule timeline (discrete, branching, glyph-like) and the trajectory plots
(continuous quantitative data). That coupling is the root of the pain:

- The schedule is forced into fit-to-window rectangles in a chart panel — can't
  do glyphs, hover flags, vertical scrolling, or arbitrary tree structure.
- Hover is **segment-first**: hovering one segment shows only that segment's slice
  of the trajectories. Wrong mental model (see path-first below).
- Trajectory tracks are a hardcoded fixed list; not user-configurable, not movable.
- SciChart "memory gets clogged" with too many timepoints — because the client
  holds full-resolution timeseries. This is a **data-volume** problem, not a
  SciChart problem.

## Target architecture

Three tools, each doing what it's good at:

1. **Trajectories → keep SciChart.** WASM line rendering of many series / many
   points is its niche. The memory issue is fixed by adaptive rendering (below),
   not by switching libraries.
2. **Schedule timeline → standalone SVG/DOM component** (D3 for layout math or
   hand-rolled). DOM gives signposts, glyphs, hover flags, vertical scroll, and
   collapsible branch trees for free — none of which fit a chart panel.
3. **Layout shell → tiling/dock layout** (e.g. dockview / golden-layout / CSS grid
   with resize handles) wrapping N plots, so panels can be moved/resized. SciChart
   doesn't own layout — a surface is just a canvas in a DOM container.

Sequencing: **(1) adaptive rendering → (2) SVG timeline → (3) flexible panels.**
Rendering is the unlock: cheap (screen-resolution) panels are the prerequisite for
both a flexible dashboard and many simultaneous plots.

## Path-first, not segment-first

A **path is a root-to-leaf lineage** through the branch tree. Branches share a
common prefix (the trunk) then diverge — a trie. Trajectories are "one line per
path." Hovering a branch node highlights the **whole lineage start-to-finish**
(shared trunk + that branch's divergent tail), not a single segment.

Consequence: the branch **tree becomes the primary object** the timeline renders,
with model glyphs/segments hung off it — not the current parallel
`StructureNode` (sidecar) + flat `TimelineSegment[]` reconciled by execution_path
string matching (`rectangleLayout.ts`).

Backend gaps to close (`schedule_structure.jl`):
- `StructureNode` does not store the `as` branch-variable. `spec.as` is consumed
  in `_structure_node(::Each, …)` but dropped. Add `as`/`branch_var` so branches
  can be labelled. NOTE: `as` only exists for `Each` branches; hand-written `List`
  sibling branches have no `as` → need a fallback label (model label / channel
  suffix). **Confirm which cel_full's knockouts actually use before designing the
  label code path.**
- Surface the merged per-model bindings (the `{add}`/`{do}`/`{adjust}` payload)
  for the hover flag, rather than re-deriving frontend-side.

## Scheduling architecture (confirmed from GRS.jl core)

Read `GeneRegulatorySystems.jl/src/models/scheduling.jl` +
`src/specifications.jl` (≈1250 lines total — small, read it). Key facts that
drive the timeline design:

- **A branch = a `Scope` with `branch=true` whose `step` is a `Sequence`
  (`List` or `Each`).** Executing a branching sequence forks the state into
  **parallel independent copies**, one per item, each reseeded
  `Xoshiro(hash((parent_seed, i)))`, sharing the trajectory up to the fork and
  diverging after (returns a `Branched` state). This *is* path-first: each leaf
  is an independent trajectory; the shared prefix is simulated/stored once.
- **`execution_path` is a complete serialization of the tree topology.** Grammar:
  - `+` = descend a non-branch `Scope`; `/` = descend a **branching** `Scope`
    (`spec.branch ? '/' : '+'`) → **`/` marks branch points.**
  - `-i` = sequence item i (non-branch); `/i` = branch item i.
  - `.name` = descend into a binding/definition.
  So the frontend can build the branch **trie by parsing `execution_path`
  strings** on `+ - / .`; `StructureNode` is the same info pre-walked. Shared
  prefixes ⇒ shared trajectory data; `/`-divergence ⇒ independent branches.
- **`reify(schedule, path)`** descends ONE branch to reconstruct the model at a
  path (used by network extraction); path components drive descent.

### cel_full branch structure (settled)

All `Each`, no `List`:
`each experiments as exp` → `each exp.knockouts as knockouts` →
`do knockout(of EMS_circuit, genes=knockouts)`, with inner `each num_replicates
as rep`. So:
- Branch label = the `Each`'s `as` symbol; per-branch value is
  `evaluate(each.items)[i]` — **can be a list** (e.g. `["med-1"]`,
  `["end-3","elt-7"]`). Label renderer must handle list/object values.
- Backend gap (precise): add `as`/`branch_var` (Symbol) + the per-branch bound
  value to `StructureNode` at the branch node. `Each.as` is the source; for the
  (currently nonexistent in cel_full) hand-written `List` branch case there is no
  `as` → fallback to model label / channel suffix.

## Lean on GRS.jl; treat app-side objects as suspect wrappers

GRS.jl is the source of truth. Several backend objects in this app are
re-implementations of things GRS.jl already does canonically, and should be
replaced by (or thinly wrapped around) the native idioms rather than extended:

Read the GRS version the backend actually depends on (the rev pinned in
`backend/Project.toml`), not a local dev checkout that may diverge from it.

### Canonical trajectory reconstruction = InspectTool `Catenation`

`tools/inspect/src/{visualization.jl,InspectTool.jl}` reconstruct step-function
trajectories from stored Arrow events. The native model:
- **`Catenation`**: events grouped per segment; segments linked by computed
  `previous`/`backlinks`; capped at `LIMITS.catenations = 500` (upstream itself
  bails past that → the gap our adaptive work fills).
- **Step semantics: `stairs!(…, step=:post)`** (right-continuous) — the SSA step
  function.
- **Carry-forward to segment end is canonical/inline**:
  `if last(series.ts) < to → stairs([last_t,to],[last_y,last_y])`.
- **Cross-episode joins**: dashed connector from `previous` segment's `to` to the
  next segment's first point.

⇒ The app's **`GapTracker`** (gap detection, synthetic start, endpoint injection in
`streaming_sink.jl`) is a from-scratch reinvention of `Catenation` + `backlinks`.
Mirror InspectTool's logic instead of extending GapTracker.

### Storage format = ExperimentTool `Sink`

`tools/experiment/src/ExperimentTool.jl`'s `Sink`/`Channel` is the canonical Arrow
event format. The app's `StreamingSimulationSink` is a near-verbatim copy + streaming
/ pause / progress. The storage half is fine to keep; the GapTracker half is the
reinvention.

### No source-side resolution knob (pinned version)

Pinned `JumpModel` uses `record = false` (all jumps or final-state-only); there is
**no `dense` lever**. So viz decimation is the ONLY resolution lever for stored SSA
data — a genuinely necessary new wrapper, but it must sit ON TOP of the canonical
catenation reconstruction and still render as `step=:post` stairs with `previous`
joins. (`Resampling` models are *biological* molecule subsampling at cell division,
NOT viz decimation — do not conflate.)

### StructureNode is also a re-walk

`StructureNode` re-walks the spec tree the app already has via
`Specifications` (`Scope`/`Each`/`List`) + `reify`/`locate` descent, reconciled to
segments by `execution_path` string matching. Worth exploring whether the timeline
can drive off native descent + the `execution_path` grammar directly (see
scheduling-architecture section) instead of maintaining a parallel tree.

## Signpost timeline (the SVG component, phase 2)

- Instant models (`from==to`): red circle, glyph inside (`+` for Adjust, empty
  default). Multiple instants at the same time **stack on one vertical "pole."**
- Do models: purple node + play-triangle; hover reveals a horizontal extent bar
  across the branches it spans (have `from`/`to`/`execution_path`).
- Branches: **scrollable vertically** (reddit-thread style), **collapsible**
  subtrees for complex schedules (cel_full knockouts). Collapse → summary node.
- Hover flag: pops the model's set variables / bindings.

### Two decouplings (keep them distinct)

1. **Visual-length decoupling** (want this): the timeline's horizontal axis is no
   longer the same px/sec as the trajectory chart. Instants can take visual width;
   do-models can compress. Needs a piecewise/nonlinear `time → x` map + reverse
   lookup in the SVG component.
2. **Cursor decoupling** (do NOT want this): keep the schedule and trajectory
   linked **by time value** so hovering a trajectory at t still highlights the
   active schedule model. Independent axis transforms, shared time value.

### Selection identity

Stacking glyphs on a pole changes hit-testing: a click must disambiguate *which*
glyph, so the timeline needs **per-glyph hit targets**, finer-grained than the
current `onSegmentClick(segmentId)`.

## Flexible trajectory panels (phase 3)

- Panel = config object: `{ id, speciesType|custom, species[], paths[] (branch
  filter), genes[] }`.
- Keep the current 6 tracks as **default presets**; let the user add/remove/reorder
  and configure each panel's branch+species+gene filters.
- Movable/resizable via the tiling shell. Mostly a refactor of `MainChart.tracks`
  (fixed array → dynamic config-driven list); `ChartLayout`/`PanelGroup` already
  support dynamic layout.
- **Memory tension:** today panels are sub-surfaces sharing one WASM context
  (efficient). Free-floating windows push toward independent surfaces, each with
  WASM overhead. Affordable ONLY because adaptive rendering caps each panel at
  screen-resolution data. Rendering → cheap panels → flexible dashboard.

## Why SciChart (and why not Makie)

- Adaptive subsampling on the **server** is renderer-independent and is the real
  win. No browser renderer holds millions of points/series — SciChart, WGLMakie,
  Plotly all need server decimation. So the valuable work carries over regardless,
  de-risking the SciChart bet.
- SciChart's built-in `resamplingMode` does NOT help: it cuts draw time but still
  needs all points resident client-side — which is the memory problem. Server-side
  decimation cuts memory. Don't reach for the built-in.
- Makie: native (GL/Cairo) renders to an OS window / static image, not a DOM
  webview widget. Only WGLMakie embeds in-browser, via a JSServe/Bonito WebSocket
  bridge — every interaction round-trips Julia↔browser, and you'd re-architect the
  whole Vue/PrimeVue/Tauri frontend around Julia-served plots and still hit the
  same memory wall without decimation. Not better; a different app.

## Adaptive rendering (phase 1 — see handoff doc)

Full design + traps in `docs/adaptive-rendering-handoff.md`.
</content>
