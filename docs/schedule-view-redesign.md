# Schedule view redesign — design notes + plan

Status: **design settled, implementation in progress** (updated 2026-06-21, session 2).
Supersedes the old `trackviewer-redesign.md`. Captures a brainstorm between Stefan
and Claude on extracting the schedule timeline into a standalone component and
rebuilding its data model off the GRS.jl engine instead of an app-side re-walk.

> **Session-2 decisions (2026-06-21) — read `## Update (session 2)` below before
> implementing C.** Headlines: (1) `TimelinePanel` and the promoter panel are
> removed from the charts entirely (clean break, promoter goes *dark* until the
> aggregation track lands); (2) phase C ships only the trie *parser* + deletions —
> `computePathYRanges` is dropped as premature; (3) a new, separate **branch-
> aggregation track** (principled mean/quantiles across replicate branches, served
> from the backend) replaces the old per-lineage y-subdivision for both promoter
> activity and count trajectories. Priority: **C → D → aggregation track.**

Phase 1 (adaptive SSA-aware rendering) is **done** — this doc is only about the
schedule/timeline view, not the trajectory charts.

### The prize (what success looks like)

Three goals, in priority order — these are the lens for every design call below:

1. **A better schedule viewer.** The standalone lineage view (trunk forks into
   tracks), progressive disclosure, collapse.
2. **More representative of GRS.jl structure.** The view should mirror what
   GRS.jl *actually does*, read from the engine's **native output**, not an
   app-side re-derivation. This is the decisive tie-breaker (see below).
3. **Decoupling from SciChart.** The schedule is its own component with its own
   coordinate system; it shares only a flat segment payload with the trajectory
   view and links by lineage identity.

We represent the **unrolled execution**, not the authored spec: every branch item
and every `:to` iteration is a real track/segment (an `Each` over 100 shows as 100
lineages, not one node). The C. elegans lineage figure is execution structure.

### Why rebuild, not patch (the fork we closed)

There's a 2-line "minimal fix": drop the `_subtree_has_branch` taint in
`_build_structure_tree` and type purely on the `branch` flag — that alone fixes the
mis-typing bug with no frontend rewrite. **Rejected**, on goal #2: even un-tainted,
the structure tree is the *app re-walking the spec* to approximate the execution
topology. GRS.jl already emits that topology natively in `execution_path` (verified
in the engine: Scope descent `scheduling.jl:488` appends `/` for branch-scope else
`+`; sequence stepping `:538` yields `…/i` for branch items, `…-i` for sequence
items — the char before the index disambiguates, unambiguously). Reading GRS's own
output beats re-deriving it. So the re-walk goes; paths become the single topology
source.

---

## What we're building

A **standalone Vue component that renders only the schedule** — fully decoupled
from the SciChart trajectory view. Horizontal time, stacked lineage tracks, a
shared trunk that forks downward into branches (the orientation in Stefan's
C. elegans reference figure). It is its own coordinate system; it is **not**
pixel-aligned with the trajectory chart.

The two views link by **lineage identity (`execution_path`)**, never by physical
layout or a shared x-pixel.

---

## Core principles (settled)

### Path-first, not segment-first

A **path is a root-to-leaf lineage** through the branch tree. This is exactly what
the GRS engine does: a branch forks state into independent reseeded copies
(`Xoshiro(hash((parent_seed, i)))`) that share the trunk and diverge after. So
"one track per lineage, the shared trunk drawn once, hovering a branch highlights
the whole lineage" is the *correct model of the computation*. The current
segment-first hover (hovering one segment shows only that segment's slice) is
actively misleading and goes away.

### Linking = lineage selection + node brushing. No time cursor.

The time cursor is the **wrong primitive** and the existing code shows why:
`getModelPathAtTime` (`types/schedule.ts`) returns the *first* segment matching `t`
with a fallback — because under branching, "the active model at time `t`" is not a
single thing, it's a **set**, one per live branch (in cel_full, dozens). A single
cursor line can't express that, so the code picks one and lies.

The shared key is lineage, not time. Three tiers:

1. ~~Time cursor~~ — **dropped.**
2. **Lineage selection (the spine)** — click a track/branch → the chart filters or
   highlights that lineage's line(s). Structural, robust under any branching. Uses
   the existing prefix filter (`matchesPathPrefix` / `filterSegmentsByPrefix`).
3. **Node brushing (the detail)** — hover a glyph → pop its bindings flag and brush
   its `[from, to]` as a **band** (region, not line) on the chart's own time axis.

### Bindings flag on glyph hover, toggle-pin on click

The `{add}/{do}/{adjust}` payload pops only when hovering a glyph; clicking toggles
it pinned. Not always-on (the reference figure shows everything at once only because
it's a static figure; the live tool needs progressive disclosure).

### Glyph taxonomy — derived frontend-side from GRS-native signals

**Settled (this session): the backend does not invent a do/adjust/durational
enum.** GRS.jl draws exactly one structural line — `Instant <: Model` vs
durational — and surfaces it by setting `Δt = 0` for instants
(`scheduling.jl:131-133`), i.e. our `from == to`. There is no "do" or "adjust"
*kind* in the engine; `Adjust`, `Slice`, `Merge` are just concrete models, some of
which happen to be `<: Instant`. ("do" in the DSL is merely the binding *name* that
holds the model to run, not a model type.)

So the backend emits two faithful, GRS-native signals and the **frontend maps them
to glyphs**:

- `from == to` → instant-ness (engine's own `Δt = 0`).
- `model_type` = the unwrapped model's GRS type name,
  `nameof(typeof(unwrap(primitive!)))` (e.g. `"Adjust"`, `"Merge"`, a v1
  `"Definition"`). One honest source; no taxonomy invented server-side.

Frontend glyph mapping (presentation, not wire):

- **Durational** (`from < to`): every durational segment *is* a model run — a
  circuit. So there is **no "plain bar / other durational"** category; durational ⇒
  circuit node + play-triangle (the figure's "do").
- **Instant** (`from == to`): red circle on a pole, with an **inner glyph chosen by
  a `model_type → glyph` map** — not special-cased to `Adjust`. Any instant model
  gets its own mark; e.g.

  ```ts
  const INSTANT_GLYPH: Record<string, string> = {
    Adjust: "+",     // {set}/{add}/{multiply}
    Merge:  "⋈",
    Filter: "▽",
    Pass:   "·",
    // …extend as new instant models appear
  };
  // fallback for unmapped instant types: a neutral dot
  ```

  Instants at the same time stack on one vertical pole. The map lives frontend-side
  (pure presentation); adding a glyph for a new GRS instant model is a one-line edit
  with no backend change, because the backend already ships the real `model_type`.

The GRS instant models today (all `<: Instant`): `Plumbing.Pass`, `Plumbing.Filter`,
`Plumbing.Adjust`, `Scheduling.Merge`. New ones surface automatically as their
type name in `model_type`; the map just needs an entry (else the fallback glyph).

### Dropped / deferred / out of scope

- **Channel** — removed from the schedule view entirely (coloring, filtering,
  `TimelineSegment.channel`). It is an experiment-tool storage concept (`into`
  partitions events into separate Arrow files) and serves no purpose for display;
  the path/branch is the identity. **Kept as-is in `streaming_sink.jl`** (storage
  layer) — we are *not* touching `into` there. Trajectory identity never depended
  on channel: events are keyed by segment index `i`, and the index maps `i → path`.
- **Sub-segment stages, per-segment colour, measurement ticks** — not priorities;
  ignored for now.
- **Branch-var labels** (the `as` symbol → `E&MS`, `med-1`) — nice-to-have, deferred
  (see backend caveat below).
- **Nonlinear / visual-length time map** — deferred; start linear (instants still
  need pole treatment even under linear time).
- **Flexible/movable trajectory panels** — the old doc's phase 3, separate effort.

---

## The backend insight (why we delete `StructureNode`)

The backend has **two** schedule-extraction paths today, and one is dead weight:

- `_collect_segments` — a **dryrun pass**: the real engine runs with a `FlatState`
  and a `dryrun` hook. Canonical. **Keep.**
- `_build_structure_tree` — a **reify-style spec re-walk** (`_structure_node`
  dispatch + `Scheduling.evaluate` to re-expand `Each`). The suspect wrapper. It
  re-derives branch typing and gets it wrong: `_subtree_has_branch` taints any
  sequence containing a branch descendant as `:branch`, which forces
  `rectangleLayout.ts` to recover branch-vs-sequence from **time-overlap
  heuristics**. A whole frontend dance compensating for a backend re-walk that lies.

Two facts from `GeneRegulatorySystems.jl/src/models/scheduling.jl` settle it:

1. **Instant detection is native.** In a dryrun the `Primitive` itself checks
   `f! isa Models.Instant` and sets `Δt = 0.0` (`scheduling.jl:131-133`), then hands
   the callback `primitive!`, `path`, `Δt`. You don't detect instants — the engine
   tells you. (The skip / `do`-via-number shortcut is covered by the existing
   `!isfinite(Δt) || Δt == 0` guard.)
2. **The dryrun walks every branch; `reify` deliberately does not.** A branch
   `Sequence` copies state and invokes `step!` for *each* item with `context...`
   (carrying `dryrun`) — `scheduling.jl:544-553` — so the dry pass fires on every
   branch, emitting `/i` paths. `reify`'s own docstring (`scheduling.jl:583`) says it
   "will only descend on one branch per inner node." Reify is single-path
   reconstruction for network extraction — using a reify-shaped walk to build the
   *whole* tree fights its grain.

**`execution_path` is a complete, faithful serialization of the topology.** Grammar
emitted natively by the engine:

- `+` = descend a non-branch `Scope`
- `/` = descend a **branching** `Scope`  → **`/` marks branch points**
- `-i` = sequence item `i`; `/i` = branch item `i`
- `.name` = descend into a binding/definition

So the branch/sequence distinction the frontend currently *guesses* is sitting in
the separators: `…/2` is a branch item, `…-2` is a sequence item. Free, correct, no
taint.

Everything a path-first trie needs is available at dryrun time:

| need                     | source                                   |
|--------------------------|------------------------------------------|
| topology / branch points | `path` grammar (`+ - / .`)               |
| instant vs durational    | engine-set `Δt` → `from == to`           |
| model_type (GRS type)    | `nameof(typeof(Models.unwrap(primitive!)))` |
| from / to                | `x.t`, `x.t + Δt`                        |
| bindings (hover flag)    | **deferred** — see below                 |

**Caveat — branch-var labels.** The dryrun doesn't cleanly hand you the `as` symbol
(`E&MS`, `med-1`). The bound *value* lives in `primitive!.bindings[as]`, but "which
key is the branch var at this level" needs spec knowledge the dry pass doesn't
carry. Labels are nice-to-have → **defer**; add a thin branch-var sidecar later if
wanted.

### Target data model

Backend emits a **flat list of enriched segments** (wire format stays flat):

```
{ id, execution_path, model_path, json_path, from, to, model_type, label }
```

- `model_type` is a `String` (not `Symbol`) — `TimelineSegment` round-trips through the
  `/schedules/union-network` request, so the wire field stays a plain string,
  matching the struct's other fields.
- `channel` is **dropped** from the segment (storage-layer `into` stays in
  `streaming_sink.jl` — untouched).

**`bindings` is deferred, deliberately.** Raw `primitive!.bindings` is *not* a
JSON-safe hover payload — it carries seeds, `into`/`channel`, `Locator`s, and
evaluated model values. GRS has no *universal* serializer either: `representation`
is defined per type (v1 `Definition` yes; `Adjust` has no `Val{false}` method), and
`_label(::Adjust)` already encodes the adjustment text for the main instant case.
So the hover payload is wired **per-model_type from GRS's own surface
(`representation`/`describe`) in the glyph phase (D)**, where it's actually
consumed — not fabricated now. The B+A verification gate (trie-from-paths) doesn't
need it.

The **path-first trie is derived on the frontend** by parsing `execution_path` on
the `+ - / .` grammar (frontend owns collapse/layout state anyway; it's pure string
parsing; flat-on-the-wire also serves the SciChart decoupling — both views consume
one payload). `StructureNode` is **deleted on both sides**. This kills three things
at once: the taint bug, `computeYRangesFromStructure`'s overlap heuristic, and the
structure↔segment string-matching reconciliation.

Confirmed safe: `StructureNode`'s only consumers are timeline-side
(`types/schedule.ts`, `types/index.ts`, `MainChart.ts`, `rectangleLayout.ts`,
`TimelinePanel.ts`, `TrackViewer.vue`) — no network-extraction or editor consumer.

Trie-build worked example:

```
+-1        trunk model A        (seq item)
+-2/1      branch 1, model B    (branch point at +-2/)
+-2/2      branch 2, model B
+-2/2+-1   nested seq under branch 2
```
→ branch node at `+-2/` with children `/1`, `/2`; everything else is sequence/scope
descent. Looped (`:to`) models emit multiple segments with the same path over
disjoint intervals → a trie node maps to a *list* of segments (already handled by
`_merge_contiguous_segments`).

---

## Layout (tree-of-rows)

A node's vertical span = **sum** of its branch-children's spans (parallel) or
**shared** by its sequence-children (in series). This is what `rectangleLayout`'s
`rowsNeeded`/`assign` already compute — but now fed the *correct* topology from the
trie instead of recovered from interval overlap. The shared trunk is drawn once;
branches diverge to child rows beginning at the fork time.

**Collapse is a must-have** (cel_full knockouts — the `⋮` elision in the reference).
A collapsed branch group becomes one summary row. Layout is dynamic/stateful from
day one.

---

## Update (session 2, 2026-06-21) — C finalized; promoter → aggregation track

A working session refined the plan around two questions: does the trie handle the
entrained/looping shapes, and what happens to the promoter panel once the timeline
is gone. Decisions below **override** the earlier glyph/promoter notes where they
conflict.

### Entrained / looping is handled by construction

The trie reads topology from the `/` vs `-` separator and **never looks at time**,
so the cases that broke the old overlap heuristic are free:

- A `:to` loop re-running the same sub-schedule emits the **same `execution_path`
  repeated** over disjoint intervals → **one trie node** (list of segments). No
  interval reasoning.
- "Switch model every step" inside a sequence is `-1, -2, -3, …` → **series
  siblings** (share a row, `max` not `sum`). Branch points appear only as `/`.

This is strictly more robust than the heuristic, which had to special-case loops
(disjoint intervals looking like overlap).

### TimelinePanel + promoter panel: removed from the charts (clean break)

- **`TimelinePanel` is deleted from the charts entirely** (not stubbed). It is
  pulled out of `MainChart`/`ChartLayout`; the lineage/track view returns as the
  standalone phase-D component.
- **The promoter panel goes dark in C too.** Its old layout encoded *lineage in
  vertical position* (y subdivided by `paths × genes`), which shrinks bands to
  nothing exactly when there's most to see — and it duplicated the very
  spatial-lineage coupling this redesign deletes ("link by selection, not layout").
  So it is removed from the charts alongside the timeline and **returns with the
  aggregation track** (below), re-rendered as a per-gene strip.
- Consequence: **C ships only the trie *parser*** (`buildTrie` + tests). With no
  consumer, `computePathYRanges` (the y-range layout math) is **dropped as
  premature** — that logic belongs to phase D's component.

This is the accepted "timeline goes dark until D" clean break, extended to the
promoter panel.

### New track — backend branch-aggregation (serves promoter *and* counts)

This is a **separate feature track**, not part of the schedule redesign. It exists
because removing the promoter panel orphaned its display, and the right replacement
turned out to generalise to count trajectories too.

**Unifying principle.** A branch point forks state into reseeded replicates, so the
per-branch signals for a species are *samples from the distribution the dynamics
induce*. Aggregation = a **pointwise summary over replicate branches of a
step-function signal on a common time grid**:

- counts → **median + quantile band** (chosen over mean±std: robust for
  non-negative, skewed counts; band stays ≥ 0).
- promoter activity ∈ {0,1} → **mean = fraction active = P(active) = opacity.** The
  per-gene opacity strip *is* the {0,1} instance of the same operator. One operator,
  both uses — build it once.

**Grouping (what counts as a "replicate").** Aggregate signals whose execution
paths are identical after **collapsing branch indices `/i → /*`** (keep `-i`, `+`,
`.name` — real structure), grouped **per species**. This is self-correcting:

- Heterogeneous branches (repressilator's per-gene `/` fork; knockout-A vs
  knockout-B): a given species lives in exactly one branch → group size 1 → **never
  averaged.** Correct.
- Replicate ensembles (`Each` over the whole sim): the same species recurs across
  every reseeded branch → averaged. Correct.
- Nested (ensemble of repressilators) falls out automatically: geneA averages across
  replicates, not across genes.

**Opt-in viewing mode** (default off; lineages shown separately/selectable). A
parameter-sweep `Each` is replicate-*shaped* but not i.i.d.; turning aggregation on
is the user asserting comparability. The math stays rigorous; the semantic judgment
sits with the toggle.

**Backend placement.** The per-path streams already live server-side (Arrow via the
sink) and time-decimation already runs through the pyramid; branch aggregation is
decimation over the *branch axis* — same place, same machinery. The query gains a
mode (`aggregate: none | quantiles`) + the grouping key, and returns a compact
`(median, band, n_live)` series per group rather than shipping every branch to the
client.

**Correctness details:**
- **Live denominator** — divide by branches *live at t* (t within the path's
  `[from,to]`), not total, else a gene reads "inactive" merely because some branches
  ended. Expose `n_live` so the strip can fade where confidence is low.
- **Common grid** — union of members' breakpoints in the window (step functions only
  change at breakpoints); reuse the pyramid grid.

**Frontend (when the track runs):** count panels gain a median+band render; the
promoter panel returns as a **per-gene opacity strip** (one fixed row per gene,
opacity = mean activity), no lineage y-subdivision.

### Phase C — DONE (2026-06-21, session 2, uncommitted on `dev`)

Frontend clean break landed; `vue-tsc -b` + `vite build` both green.

- **`frontend/src/charts/layout/executionTrie.ts` (new)** — the C artifact:
  `buildTrie(paths)` parses the `+ - / .` grammar into a path-first trie;
  `childrenAreParallel(node)` reads branch-vs-series off the child separator
  (`/` = parallel). `TrieNode = { path, sep, children }`. **No y-range layout** —
  that math is D's. Verified on three shapes via a throwaway tsx spike (linear+
  3-way branch, nested branch×sequence, `:to` loop → one node); **no test
  committed** (project has no test runner — promote to a regression test when one
  is added, same as the backend spike).
- **Deleted:** `charts/layout/rectangleLayout.ts` (overlap heuristic +
  `layoutRectangles`), `charts/panels/TimelinePanel.ts`. **Kept but unwired:**
  `charts/panels/PromoterPanel.ts` (its opacity-decimation rendering is the base
  for the aggregation track's per-gene strip — do **not** delete it).
- **`MainChart`** — `schedule` (timeline) and `active` (promoter) tracks removed
  from `this.tracks`; only `CountsPanel`s remain. `setScheduleData(segments,
  metadata)` (dropped `structure`/`maxTimelinePaths`) now only feeds count panels
  their metadata + `pathTimeRanges` + time extent. Timeline callbacks
  (`onSegmentClick`/`onHoverChange`/`onInstantHoverChange`/`onDrillIn`/
  `deselectSegment`) + their types removed; `highlightPath`/`highlightGene` kept.
- **Types** (`types/schedule.ts` + `types/index.ts`) — removed `StructureNode`,
  `ScheduleData.structure`, `TimelineSegment.channel`, `extractChannels`,
  `filterSegmentsByChannel`. Added `COUNT_SPECIES_TYPES` (= `GENE_SPECIES_TYPES`
  minus `active`) for chart track listings; `DEFAULT_VISIBLE_SPECIES_TYPES` is now
  `['mrnas','proteins']`. **`GENE_SPECIES_TYPES` keeps `active`** so `gene.active`
  stays classified as a gene species (not "other") — `scheduleStore.allOtherSpecies`
  depends on this.
- **`colorUtils.ts`** — removed `buildChannelColourMap` (+ now-unused
  `hexLightness`).
- **`viewerStore`** — removed `channelFilter`/`setChannelFilter` and the dead
  `maxTimelinePaths`. Segment-selection machinery (`selectedSegmentIds`/
  `selectSegments`/`selectExecutionPath`/`selectedPaths`) **kept** — still driven by
  phase-space path-select + the path-prefix filter.
- **`TrackViewer.vue`** — removed the channel-filter UI + suggestions, all `structure`
  references, the timeline callback registrations, and the `schedule` track option/
  default. `setVisibleTracks([])` initially; defaults to count tracks when a sim loads.
- **Known inert leftover:** `viewerStore.setHoveredInstantModel` /
  `hoveredInstantModelPath` now have no setter-caller (they fed the editor-highlight
  from timeline instant hover). Harmless; rewire or remove when D's component
  provides its own hover.

### Priority (settled)

Two independent tracks, ordered by the prize:

1. **Schedule redesign (the prize):** C (trie parser + remove TimelinePanel &
   promoter) → **D (standalone schedule component)** → E (linking).
2. **Branch-aggregation track (separate):** backend quantile aggregation →
   promoter strip + count quantile bands. Real value, but **does not block D** — do
   it after D (or interleave), as its own effort. It is the single biggest chunk on
   the table (per-t quantiles across branches at viewport resolution).

---

## Plan / order

Dependencies are linear: **C needs B; D needs C; E needs D.** A rides with B.
**(Session-2 override: see the priority + scope changes in `## Update (session 2)`
above — C no longer touches the promoter layout; it removes both panels and ships
only the trie parser.)**

1. **B + A — backend data model.** One dryrun pass → flat enriched segments
   (`model_type` added; `channel` dropped; `bindings` deferred to D). Delete
   `_build_structure_tree` + `StructureNode`. Cheapest, best-understood chunk; it
   de-risks the central claim.
   - **Order within B (risk-cheap):** *spike the reconstruction first* — emit the
     enriched segments, then prove paths→trie rebuilds the topology faithfully on
     real dryrun output **before** deleting `_build_structure_tree`. Don't demolish
     on faith and rebuild; verify, then delete.
   - **Verification gate:** confirm trie-from-paths reconstructs correctly on three
     shapes — repressilator (linear), cel_full (deep branching), and a `:to`
     loop/repeat schedule (multiple disjoint intervals per path).
   - **Status (2026-06-21): B+A backend DONE (uncommitted).** `TimelineSegment`
     now carries `model_type` (= `nameof(typeof(unwrap(primitive!)))`), `channel`
     dropped; `ScheduleData.structure` removed; `_build_structure_tree` + all
     `_structure_node`/`StructureNode` machinery deleted from
     `schedule_structure.jl` (+ dead `Specifications`/`Scheduling` imports). Module
     loads and reifies cleanly; viewport tests untouched/passing.
   - **Spike PASSED** on real dryrun output: path→trie reconstruction is faithful
     on repressilator (linear → 5-way parallel `/i` branch at equal `[from,to]`),
     switch + celegans_ems (deep nested `seq`/`BRANCH`), and repressilator-entrained
     (`:to` loop → repeated path over disjoint intervals collapses to one node).
     Branch-vs-sequence comes purely from the `/` vs `-` separator — no time-overlap
     heuristic. (Spike was a throwaway script, removed; could be promoted to a
     regression test later.)
   - **Next:** C — frontend trie parser + delete the `rectangleLayout` overlap
     heuristic and TS `StructureNode`/`channel` types (frontend currently broken by
     the wire-format change — the accepted clean break).
2. **C — frontend trie + clean break. DONE (2026-06-21, session 2).** See
   `### Phase C — DONE` above for the full landed change list. Ship `buildTrie`,
   delete `rectangleLayout.ts` + `TimelinePanel.ts`, strip `StructureNode`/`channel`/
   `structure` + channel UI, remove the timeline & promoter tracks from `MainChart`.
   `vue-tsc -b` + `vite build` green.
3. **D-spike — layout spike.** Throw the SVG tree-of-rows layout against *real*
   reconstructed data (tracks + collapse + pole-stacking) to validate the hardest
   interaction before building the full component. (Decision: we spike rather than
   trust the design blind. Real data beats a mock, so spike after B/C, not before.)
4. **D — full component.** Glyph taxonomy, hover flags, collapse. Render-only
   first (no chart link).
5. **E — linking.** Lineage-selection → chart `paths[]` filter; node-brush band;
   remove the time cursor.

**Separate track — branch aggregation** (does not block D; see `## Update
(session 2)` for the full design). Backend: structural-key grouping (`/i → /*`),
per-species, median + quantile band + `n_live` over live members on the pyramid
grid, exposed as an opt-in `aggregate` query mode. Frontend: count median+band
render; promoter returns as a per-gene opacity strip.

**Clean break is accepted.** When B lands, the current `TimelinePanel` breaks and
the timeline goes dark on the feature branch until D — no compatibility shim. Fits
the ruthless-refactor mandate.

Deferred (post-redesign, separate): branch-var label sidecar, nonlinear/visual-length
time map, flexible trajectory panels. Not happening: storage-layer `into` removal.

---

## Pointers

- Engine: `GeneRegulatorySystems.jl/src/models/scheduling.jl` (read the rev pinned in
  `backend/Project.toml`, not a local dev checkout). Key lines: dryrun short-circuit
  + instant detection `129-139`; branch traversal `544-553`; `reify` single-path
  docstring `571-595`; path grammar `286-312`, `488`, `538`.
- Backend today: `backend/src/schedule/schedule_structure.jl`
  (`_collect_segments` — `_build_structure_tree` deleted in B+A), assembled in
  `schedule_visualisation.jl`.
- Frontend (post-C): `frontend/src/charts/layout/executionTrie.ts` (the trie
  parser), `frontend/src/types/schedule.ts` (wire types), `frontend/src/components/
  TrackViewer.vue` (where the new component will mount). `TimelinePanel.ts` and
  `rectangleLayout.ts` are **deleted** — read them in git history for reference.

---

## Phase D — handoff for the next agent

**Goal:** the prize — a standalone Vue **SVG** schedule component (lineage tracks,
trunk forks downward into branches, progressive disclosure/collapse), fully
decoupled from SciChart. Render-only first; chart linking is phase E.

**Start by reading, in order:** the `## Core principles`, `## Update (session 2)`,
`### Phase C — DONE`, and `## Layout (tree-of-rows)` sections of this doc. Then
`frontend/src/charts/layout/executionTrie.ts`.

**What you're handed (from C):**
- `buildTrie(paths)` → path-first `TrieNode` tree; `childrenAreParallel(node)` tells
  branch (sum rows) from series (max rows) off the `/` vs `-` separator. Verified on
  linear/nested/loop shapes.
- Wire per segment: `{ id, execution_path, model_path, json_path, from, to,
  model_type, label }` (flat list; `viewerStore.filteredSegments` /
  `scheduleStore.segments`). A trie node (path) maps to a **list** of segments (a
  `:to` loop yields several disjoint intervals on one node). **Instant-ness =
  `from === to`** (engine sets Δt=0); there is no kind field.

**D-spike first (do not trust the layout blind).** Reimplement the tree-of-rows
y-layout *on the trie* (the math dropped from C): `rowsNeeded` = branch→Σ children,
series/scope→max children; `assign` splits a branch node's span among children,
shares it for series. Throw it at real reconstructed data (repressilator, switch,
celegans_ems, repressilator-entrained) and eyeball tracks + collapse + instant-pole
stacking before building the full component.

**Then the component:**
- **Durational** segment (`from < to`) ⇒ a circuit node + play-triangle (every
  durational *is* a model run — no plain-bar category).
- **Instant** (`from === to`) ⇒ red circle on a vertical pole + an inner glyph from a
  frontend `model_type → glyph` map (`Adjust`→`+`, `Merge`, `Filter`, `Pass`, …;
  fallback neutral dot). Instants at the same time stack on one pole. The map is pure
  presentation — adding a glyph for a new GRS instant model is a one-line edit (the
  backend already ships the real `model_type`).
- **Collapse is must-have** (cel_full knockouts → `⋮` elision); layout is
  dynamic/stateful from day one.
- **Mounting:** the `schedule` chart track is gone, so this component needs a home in
  `TrackViewer.vue`'s layout (its own pane above/beside the SciChart counts), not as a
  SciChart panel.
- **Bindings hover payload is deferred** — wire it per `model_type` from GRS's own
  `representation`/`describe` (a backend change) only when the glyph hover-flag needs
  it; raw `primitive!.bindings` is not JSON-safe and there's no universal serializer.

**Phase E (after D):** lineage selection → chart `paths[]` filter (reuse
`matchesPathPrefix`/`filterSegmentsByPrefix`, already present); node-brush a
`[from,to]` band on the chart; remove the (already-unused) time cursor. Note the
inert `viewerStore.setHoveredInstantModel`/`hoveredInstantModelPath` left by C —
rewire them to the component's hover or delete.

**Do not** revive `StructureNode`, the overlap heuristic, or `channel`; **do not**
delete `PromoterPanel.ts` (the aggregation track needs it).

---

## Update (session 3, 2026-06-21) — Phase-D visual spike + topology blocker

This section **overrides the Phase-D glyph/layout details above where they
conflict**. A live browser iteration exposed both the preferred visual language
and a missing structural signal in the flat path payload. Do not continue polishing
the SVG until the topology point below is resolved.

### Current uncommitted spike

The working tree on `revamp-schedule-visualisation` contains an in-progress
standalone schedule renderer:

- `frontend/src/components/schedule/ScheduleView.vue` — SVG renderer + interactions.
- `frontend/src/components/schedule/ScheduleViewer.vue` — reads `scheduleStore`
  directly; no chart dependency.
- `frontend/src/components/schedule/scheduleLayout.ts` — pure trie row layout.
- `frontend/src/types/schedule.ts` — adds the missing TS `model_type` field.
- `frontend/src/App.vue` / `TrackViewer.vue` — the component is mounted **inside
  TrackViewer between its header and SciChart container, but is not a SciChart
  panel and does not participate in `MainChart`/`ChartLayout`.** This is temporary;
  flexible panels remain a future effort.

`npm run build` was green throughout the spike. `./dev.sh` runs the browser app at
`http://localhost:1420`; the first Julia launch may spend about a minute
precompiling GRSServer.

### Visual/interaction decisions from the live spike

- The default view is a **structural lineage diagram**, not a Gantt chart.
  Lineage branches are thicker horizontal lines. Primitive models are compact signs
  hanging from posts above those lines.
- Durational models use a small Julia-purple play flag (no permanent capsule).
  Hovering or pinning reveals the faithful `[from,to]` span in purple with end caps.
- Instants use a small red circle/post; `Adjust` has a small red stroked plus.
  Instant and durational signs must share one stack keyed by **visual row + time**,
  not by path + time, because distinct paths can occupy the same row.
- Remove SVG `<title>` elements: they produce a second native grey tooltip. Detail
  flags use the app's shared `.grs-tooltip` visual style, connect back to the sign
  with a leader, and click toggles **multiple** pinned flags independently.
- No zoom toolbar. Mouse wheel zooms horizontally around the pointer; double-click
  returns to fit; drag pans horizontally when zoomed.
- The schedule pane has no title/segment-count header and no tinted background.
- Hovering a lineage should highlight its whole related chain: ancestors before it
  plus its descendant tail; unrelated paths dim. Use an invisible wide hit stroke
  so the visible line need not become clumsy.
- Collapse is two-state and subtle. A collapsed subtree retains a dashed summary
  line spanning the longest descendant time extent; it must not disappear into a
  zero-width marker. Hover explains “Collapse branches” / “Expand branches”.

### Critical blocker: ACDC proves path grammar alone is insufficient

ACDC contains two nested `each` dimensions of length 3. The intended visual result
is **two fork levels and 3×3 = 9 leaf lineages**:

```
outer Each
├─ value 1 → inner Each /1, /2, /3
├─ value 2 → inner Each /1, /2, /3
└─ value 3 → inner Each /1, /2, /3
```

Its real dryrun paths are:

```
-2-1/1+  -2-1/2+  -2-1/3+
-2-2/1+  -2-2/2+  -2-2/3+
-2-3/1+  -2-3/2+  -2-3/3+
```

All nine durational primitives span `[0,200000]`. The current trie interprets the
outer `-1/-2/-3` as ordinary series siblings and reuses three rows, so it renders
only one visible three-way fork with multiple signs stacked on each row. Grouping
coincident collapse controls merely hid this problem; it is not the solution.

The frontend cannot distinguish an ordinary `List` sequence from a non-branch
`Each` expansion using `execution_path` alone: both use `-i`. Reintroducing time-
overlap inference would recreate the rejected heuristic. Re-walking the entire spec
would recreate the rejected `StructureNode` architecture. The next agent must find
the **smallest faithful structural signal**, preferably engine-native or captured
during the dryrun, that marks unrolled `Each` levels versus genuine series.

Possible direction: a lightweight per-prefix operator-kind sidecar (only structural
provenance, not layout) or an engine trace event. Do not decide this by guesswork;
inspect the pinned GRS scheduler and determine what can be surfaced without another
app-side execution approximation.

### Structural x mapping is now required, not deferred

Nested forks can occur at the same simulation time (ACDC: both at `t=0`). A literal
linear time scale maps both fork levels to the same x pixel. The standalone schedule
therefore needs **structural fork lanes**: reserve horizontal visual space for each
fork depth, then begin the physical-time span. For ACDC, outer fork lane → inner
fork lane → the real `0…200000` model span.

Those structural pixels do not represent elapsed time. This is the concrete reason
the schedule owns its coordinate system and must link to SciChart by lineage identity
and `[from,to]`, never shared x pixels or a global time cursor.

### Next-agent order

1. Read this session-3 update and reproduce ACDC in the live app.
2. Undo/replace any coincident-fork grouping that masks the two `Each` levels.
3. Establish the minimal reliable `Each`-vs-series structural metadata.
4. Extend the trie/layout to produce nine ACDC leaves.
5. Add structural fork-depth x lanes and confirm both fork levels are visible.
6. Only then resume collapse and tooltip polish across ACDC, differentiation-tree,
   repressilator-entrained, minimal, and a deep C. elegans schedule.

---

## Update (session 4, 2026-06-21) — topology signal resolved

The ACDC ambiguity is resolved with a deliberately narrow backend sidecar:
`ScheduleData.each_prefixes` contains only execution prefixes produced by a
**non-branch `Each`**. The collector walks GRS's already parsed/evaluated scheduler
objects and records operator provenance only; it does not rebuild timing, models,
branches, or layout. `/i` remains sufficient for branching `Each`; the sidecar is
needed only where non-branch `Each` and `List` both serialize as `-i`.

The trie treats children of those prefixes as parallel visual lineages. ACDC now
has an outer three-way fork plus the native inner `/` forks, producing nine rows.
Forks use a time-preserving piecewise x transform. Every primitive interval shares
one physical-time scale; fixed-width structural gutters are inserted only at the
actual times where forks occur. Coincident nested forks consume multiple lanes
inside the same gutter, while later forks get gutters at their own times. ACDC's
shared bootstrap `Adjust` occupies the pre-event part of the `t=0` gutter before
the two fork lanes. The time axis is hidden until this hybrid mapping gets an
explicit visual legend.

Duration flags now represent maximal consecutive runs of an execution model, not
every dryrun time slice and not every occurrence of a model globally. Adjacent
slices with the same `model_path` coalesce (C. elegans), but returning to a model
after another model creates a new flag (dark/light/dark entrainment). Instant
actions remain individual signs. `TrackViewer` is temporarily hidden during the
visual spike; `ScheduleViewer` occupies the lower app pane independently.

---

## Update (session 5, 2026-06-21) — structural spike stabilised; aesthetics next

The standalone schedule now has a coherent, general layout across the schedules
tested during live iteration. The important geometry rule is that collapse changes
visibility, never topology coordinates: spline endpoints and incoming branch starts
are computed from `fullLayout`, while `layout` controls only what is visible. This
fixed the short branch-line tips that appeared only when a nested fork was collapsed.
Collapse controls sit at the actual fork origin on the parent line. Their hover
tooltip has been removed; the chevron is sufficient.

Current interaction/rendering state:

- drag pans both axes whenever either axis overflows; both scrollbars are permanent;
- poles render in a shared back layer so stacked sign faces always cover them;
- HTML tooltip overlays are viewport-clamped outside the SVG clipping region;
- duration selection spans are fully opaque purple, and tooltip details no longer
  repeat the model's `[from,to]` interval;
- repeated dryrun slices coalesce into maximal consecutive runs of one
  `model_path`, while a later return to that model creates another flag;
- lineage geometry, duration lengths, and later fork events remain physically
  time-proportional, with fixed structural gutters only at fork times;
- the physical time axis remains intentionally hidden because those structural
  gutters make x a piecewise time mapping rather than one globally linear axis.

The next pass should focus on visual hierarchy (flag density, tooltip typography,
line weights/colour balance, and how repeated alternating models read) rather than
changing topology or adding schedule-specific exceptions. Validate every aesthetic
change on ACDC, differentiation-tree, repressilator-entrained, minimal, and a deep
C. elegans schedule.

### Replace generic `JumpModel` with definition provenance

Showing `JumpModel` is technically true but semantically useless: V1, Kronecker,
Differentiation, and RandomDifferentiation definitions all compile to that same
runtime model. Do not infer a friendlier kind in the frontend from labels,
`model_path`, or JSON path strings. GRS already preserves the generating definition
as a chain of `Models.Wrapped` values.

Add one backend `model_kind` field to `TimelineSegment`, derived by Julia dispatch
over that provenance chain during the existing dryrun collection. Dispatch on
`V1.Definition`, `KroneckerNetworks.Definition`, `Differentiation.Definition`, and
`RandomDifferentiation.Definition`; recursively descend through unrelated
`Wrapped` layers (including the scheduling `Locator`) and retain a neutral fallback
for truly direct models. This is a small presentation sidecar, analogous in spirit
to `each_prefixes`: it reports engine-held provenance and does not re-walk the spec.
The tooltip can then show a stable human label such as `V1`, `Kronecker`,
`Differentiation`, or `Random differentiation`, while `model_type` remains available
for instant-glyph dispatch and debugging.

### Handoff status

All changes remain uncommitted on `revamp-schedule-visualisation`.
`frontend/src/components/schedule/` is currently untracked as a directory, so plain
`git diff` will not display those files; use `git status --short` and inspect them
directly. `TrackViewer` is deliberately hidden during the spike, and the schedule is
mounted as its own component above/independent of it. The frontend build was green
after the session-5 presentation changes.

---

## Update (session 6, 2026-06-21) — semantic hover and model occupancy

The visual spike now distinguishes three identities which must remain separate:

1. **Lineage identity** comes from compatible choices in the execution-path trie.
   Hovering a child highlights its ancestors, that child, and its descendant tail;
   sibling choices dim. Hovering a shared trunk may highlight every compatible
   downstream lineage. Each fork spline is independently interactive.
2. **Model occurrence identity** is a connected component of durational segments
   with the same engine-provided `model_path`. Components join only where time
   intervals touch/overlap and execution paths are lineage-compatible. This lets a
   purple flag highlight the complete extent over which that selected model applies,
   including inherited occupancy through forks, without joining sibling lineages or
   a later return to the same model after an intervening model.
3. **Authored schedule semantics** are labels/stages/operator bindings, not primitive
   execution-segment identity. They are now transported separately from the model
   description and should drive schedule annotations.

Raw dryrun segments remain the faithful geometry/time substrate but are not
first-order interaction objects, and a model flag is not repeated merely because
one inherited model was split into several execution paths. In particular, the
duplicate purple `cel_atlas` flag after the fork is suppressed when the child
continues the parent's `model_path`.

### New semantic sidecar

`ScheduleData.operators` is a lightweight companion to `each_prefixes`. It is
collected during the same narrow walk over GRS's already evaluated scheduling
operators and contains:

- operator path, `each`/`list` kind, and whether it is parallel;
- authored operator label;
- `Each.as` binding name;
- evaluated child paths, child binding values, and child labels.

`TimelineSegment` also carries `scope_label` and `stage` separately from `label`.
`label` now consistently describes the primitive/model; schedule scope labels no
longer overwrite it. The frontend uses operator metadata at fork controls and child
lineages: a fork can report e.g. `Each · rep · 3 branches`, while a child can report
its authored lineage label and `rep = 2`. This is engine/spec provenance, not label
parsing, overlap inference, or schedule-specific frontend logic.

The collapse chevron still has no redundant “Collapse/Expand” help bubble. Hovering
it may show the fork's semantic metadata and must also highlight the compatible
lineage. Collapsed extent summaries remain interactive.

Other presentation changes in this pass:

- purple-flag hover/pin draws the complete connected model occurrence, including
  the appropriate fork splines;
- tooltip widths are content-derived within minimum/maximum bounds rather than a
  fixed wide card;
- a model description beginning with the primitive type no longer repeats that type
  (the `Adjust`/`Adjust` duplication);
- detail cards retain execution path for now, but model `[from,to]` text remains
  omitted;
- frontend production build and Julia package loading are green. The full five-
  schedule reification sweep was started but interrupted, so ACDC and the remaining
  fixtures must still be explicitly re-run after these schema additions.

### Defects visible in the final screenshots

The current screenshots identify two semantic/picking issues, not isolated styling
bugs:

- **`JumpModel` should not be shown in the normal tooltip.** It is a runtime
  implementation type and adds no information beside a useful model description.
  Complete the `model_kind` provenance work described in session 5; show that kind
  only when it adds semantic value. Keep `model_type` internally for instant glyphs
  and diagnostics.
- **The visible lineage before a purple flag is not fully hoverable.** `branchSpans`
  currently derives its hit interval from durational primitives, so a visible
  structural/temporal lead-in can exist before the first duration-derived hit span.
  Do not widen it with a magic pixel offset. Define rendered lineage geometry once
  as typed pieces (`structural connector`, `temporal occupancy`, `collapsed
  summary`), and give every visible piece the same lineage identity and wide hit
  stroke. A hover anywhere on the visible lead-in must therefore select the same
  lineage as the portion to the right of the flag.

Scope/stage hover is not finished. The principled direction is to group adjacent
geometry by explicit `scope_label`/`stage`, render a subtle scope emphasis plus a
small inline label, and simultaneously retain the thicker neutral lineage emphasis.
Do not restore raw segment tooltips as the primary interaction.

### Branch limiting / progressive disclosure

The topology is now stable enough to add a branch budget. This must be a view over
the complete trie, not data truncation and not a synthetic lineage pretending to be
real:

- each parallel fork owns an independent visible-child budget;
- show a deterministic initial window (for example the first few children), plus
  any selected, pinned, hovered, or chart-linked child even if it lies outside that
  window;
- replace hidden children with one explicit `N more` aggregate row/control whose
  thin summary spans the longest hidden descendant extent;
- expanding that control reveals the real children; collapsing restores the same
  stable ordering and coordinates outside that fork;
- nested fork budgets compose independently, and ACDC's two 3-way levels should not
  be limited under a default budget of at least three;
- an aggregate row is navigational only: it must not claim one execution path or be
  sent to SciChart as a lineage filter.

This uses the same progressive-disclosure principle as subtree collapse while
remaining honest about lineage identity. Implement it in the layout's visibility
projection; keep `fullLayout` as the immutable source for fork endpoints, model
extent, and chart linking.

### Immediate next steps

1. Re-run backend reification for ACDC, differentiation-tree,
   repressilator-entrained, minimal, and `cel_atlas`; assert ACDC still has nine
   leaves and inspect emitted operator paths/bindings.
2. Replace duration-derived `branchSpans` picking with typed, shared lineage
   geometry so the pre-flag lead-in is hoverable.
3. Finish backend `model_kind` provenance and remove ordinary `JumpModel` display.
4. Add semantic scope/stage emphasis using the explicit fields, without making raw
   segments interaction objects.
5. Add per-fork branch budgets and `N more` aggregation as a visibility projection.
6. Only after those semantics settle, tune tooltip typography, flag density, and
   line weights across the validation suite.
