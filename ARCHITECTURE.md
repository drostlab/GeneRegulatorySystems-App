# GRS App Architecture

## Project Layout

Single `VERSION` file at repo root. `./dev.sh --sync-version` propagates to all packages.

| Folder | Package name | Purpose |
| ------ | ------------ | ------- |
| `backend/` | `GRSServer` (Julia) | HTTP API + simulation engine |
| `frontend/` | `grs-frontend` (npm) | Vue 3 SPA |
| `tauri-app/` | `grs-app` (Cargo) | Desktop shell |

**Architecture:** `tauri-app/` depends on both `frontend/` and `backend/`. Frontend and backend are independent of each other and of Tauri.

### Storage

| Path | Committed | Purpose |
| ---- | --------- | ------- |
| `backend/examples/` | Yes | Curated schedule examples that ship with the app |
| `backend/data/schedules/` | No (gitignored) | User-created schedules |
| `backend/data/results/` | No (gitignored) | Simulation results (Arrow IPC + metadata) |

In Tauri production builds, examples are bundled as resources and seeded into `<app_data>/schedules/examples/` on first launch.

### Development

`./dev.sh` auto-checks Node.js (>=20.19.0) and Julia (>=1.11), runs `npm install` and `Pkg.instantiate()` if needed.

| Command | Mode |
| ------- | ---- |
| `./dev.sh` | Browser: Vite + Julia backend (localhost:8000) |
| `./dev.sh --tauri` | Desktop: Tauri spawns Julia on random port |
| `./dev.sh --sync-version` | Propagate VERSION to all package files |

### Testing

| File | Purpose |
| ---- | ------- |
| `backend/smoke-test.sh` | End-to-end smoke test: boots Julia server, loads a schedule, runs a simulation, polls until completion. |
| `.github/workflows/ci.yml` | CI workflow: runs smoke test on PRs and pushes to `main`. Caches Julia depot. |

## Desktop Shell (Tauri + Rust)

| File | Purpose |
| ------ | --------- |
| `tauri-app/src/lib.rs` | Tauri app entry. Spawns Julia backend, resolves data + examples directories, handles Julia provisioning IPC. `RunEvent::Exit` handler explicitly kills the Julia process (belt-and-braces with `Drop`). |
| `tauri-app/src/julia.rs` | Julia runtime provisioning + system detection. Downloads pinned release if needed. |
| `tauri-app/tauri.conf.json` | Tauri config: window size, bundle targets, dev/build URLs. Bundles `backend/examples/`, `backend/src/`, `grs-package/`. |
| `frontend/src/tauri.ts` | Frontend Tauri bridge. `initialiseBackend()` — Tauri mode calls IPC, browser mode resolves immediately. |
| `frontend/src/config/api.ts` | Runtime-configurable API host. `isTauri()` detects environment. |

**Modes:** Browser (Vite dev + Julia separately, default `localhost:8000`) or Desktop (Tauri spawns Julia on a random free port).

## Backend (Julia — `GRSServer` module)

### Top-level

| File | Purpose |
| ------ | --------- |
| `src/server.jl` | `GRSServer` module. HTTP route definitions (Oxygen.jl). Includes all submodules. Routes: schedules CRUD, network extraction, simulation run/results, phase-space, WS streaming. `set_data_dir(path)` configures runtime storage, `set_examples_dir(path)` configures read-only examples. |
| `src/schedule_bindings.jl` | `ScheduleBindings` module — shared `spec_bindings(spec)` and `spec_seed(spec)` used by both schedule and simulation modules. |
| `src/phase_space.jl` | `PhaseSpace` module — post-simulation adaptive dim-reduction (direct/PCA/UMAP). Types: `PhaseSpacePoint`, `PhaseSpaceResult`. |

### `src/schedule/`

| File | Purpose |
| ------ | --------- |
| `schedule_visualisation.jl` | `ScheduleVisualization` module (facade). Types: `Network`, `UnionNetwork`, `ModelExclusions`, `TimelineSegment`, `StructureNode`, `ScheduleData`, `ReifiedSchedule`, `ValidationMessage`. Public API: `reify_schedule`, `extract_network_for_model_path`, `extract_union_network`, `gene_colours_from_spec`. Includes the subfiles below. |
| `schedule_validation.jl` | `_validate_spec` — validates parsed spec by attempting Model construction. |
| `schedule_structure.jl` | Labels, bindings helpers, segment collection (`_collect_segments`, `_merge_contiguous_segments`), structure tree (`_build_structure_tree`). |
| `gene_colours.jl` | Gene name extraction (`_gene_names`), colour generation: distinct pastels for V1, gray shades for Kronecker, tree hues for differentiation. `_extract_spec_gene_colours(spec)` — hack to extract optional `"color"` fields from raw JSON spec (public Gene struct lacks color field). |
| `network_extraction.jl` | `model_path_to_json_path`, `_unique_model_paths`, `_link_id`, property/value signature helpers. |
| `schedule_storage.jl` | `ScheduleStorage` module — two-source schedule persistence. Read-only `examples_dir` (committed) + read-write `user_dir` (runtime). `set_examples_dir`, `set_data_dir`. Path traversal protection. |

### `src/simulation/`

| File | Purpose |
| ------ | --------- |
| `simulation.jl` | `Simulation` module — result management, execution, filtered timeseries loading from Arrow. |
| `timeseries_summary.jl` | `TimeseriesSummary` module — computes mean + SE across execution paths. Auto-detects shared grid (step-based schedules) vs uniform interpolation (continuous). `compute_summary(path, species; n_points)`. |
| `simulation_controller.jl` | `SimulationControl` module — live simulation lifecycle (pause/resume, WS streaming, gene subscriptions). `SimulationController` holds `ws_ref`/`ws_lock` (shared Ref to global WS client) and looks up the WebSocket lazily on each `send_*` call, avoiding the race where the WS connects after the controller is constructed. |
| `streaming_sink.jl` | `StreamingSink` module — Arrow IPC storage + real-time WS streaming during execution. Uses `GapTracker`. Per-segment progress tracking via `SegmentProgress` for monotonic progress with branching schedules. |
| `gap_tracking.jl` | `GapTracking` module — shared gap detection logic (`GapTracker`, `register_episode!`, `check_gap`, `check_synthetic_start`) used by both streaming and post-hoc loading. |

## Frontend (Vue 3 + Pinia + SciChart + Cytoscape)

### Stores

| File | Purpose | Key State/Actions |
| ------ | --------- | ------------------- |
| `scheduleStore.ts` | Schedule data, union network | State: `schedule`, `unionNetwork`, `isLoading`, `isNetworkLoading`. Computed: `allGenes`, `geneColours`, `segments`, `modelPaths`, `allOtherSpecies` (non-gene species from union network). Actions: `loadScheduleByKey`, `loadScheduleBySpec`, `fetchUnionNetwork`, `clearNetwork`. Spec-skip: compares new spec to current before reloading. |
| `viewerStore.ts` | All selection/interaction state | State: `currentTimepoint`, `selectedGenes`, `selectedSpeciesNodes`, `selectedOtherSpecies` (non-gene species for chart panel), `selectedSpeciesTypes`, `selectedSegmentIds`, `pathFilter`, `channelFilter`, `maxRenderedGenes` (default 10), `maxTimelinePaths` (default 20), `hoveredModelPath`, `hoveredExecutionPath` (exposed), `hoveredGeneId` (exposed). Computed: `activeModelPath` (hovered model takes priority, else derived from currentTimepoint + segments), `filteredSegments` (segments matching both `pathFilter` prefix and `channelFilter`), `filteredPaths` (execution paths surviving both filters), `selectedPaths`, `proteinCountsAtTimepoint` (filters to hovered path or selected/filtered/active paths), `maxProteinCounts`. Actions: `selectSegments`, `selectExecutionPath(path)`, `setHoveredRectModel`, `setHoveredInstantModel`, `setHoveredGene(gene)`, `setPathFilter(prefix)`, `setChannelFilter(channel)` |
| `simulationStore.ts` | Simulation results with lazy loading + streaming | State: `currentResult`, `isSimulationRunning`, `isPaused`, `autoRunOnSave`, `pendingAutoRun`, `timeseriesCache`, `fetchedGenes`, `fetchedOtherSpecies`, `streamingBuffer`, `phaseSpaceResult`, `isPhaseSpacePending`, `summaryCache` (`TimeseriesSummary | null`). Computed: `timeseries`, `summary`, `progress`, `currentResultId`, `currentResultLabel`, `isPhaseSpaceAvailable`. Actions: `runSimulation`, `loadResult`, `fetchGeneTimeseries(genes)`, `fetchOtherSpeciesTimeseries(species)`, `fetchSummary(genes)`, `getTimeseries(genes?, paths?, otherSpecies?)`, `pauseSimulation`, `resumeSimulation`, `updateStreamSubscription(genes, otherSpecies?)`, `clearResult`. `autoRunOnSave` toggle: when true, ScheduleEditor sets `pendingAutoRun` after save, which TrackViewer watches to trigger `runSimulation()` with full chart cleanup. `fetchSummary` calls `fetchTimeseriesSummary` service and caches result; cleared on `clearResult`. Phase-space wiring: on status=completed, registers `trackPhaseSpace(simId, _onPhaseSpaceReady)` before `untrack()`; `_onPhaseSpaceReady` fetches HTTP and sets `phaseSpaceResult`. `loadResult` also eagerly tries `fetchPhaseSpace` (best-effort). |
| `logStore.ts` | Diagnostic log ring buffer | State: `lines` (max 2000), `drawerVisible`. Actions: `pushBackend(text, stream)`, `pushFrontend(level, text)`, `showDrawer`, `toggleDrawer`, `formatAll` (clipboard text), `clear`. Computed: `backendLines`, `frontendLines`. |

### Charts (SciChart)

| File | Purpose |
| ------ | --------- |
| `MainChart.ts` | Orchestrates all panels. Manages two `PanelGroup`s (`timeseriesGroup`, `phaseSpaceGroup`) and a `ChartLayout` tree. Scoped modifiers only operate on `timeseriesGroup`. Streaming: `appendStreamingDataOnly(timeseries)` pushes data without axis updates, returns per-panel y data ranges; `setStreamingRanges(xMin, xMax, yRanges)` sets interpolated visible ranges (called by `StreamingAnimator`). `setPromoterData(timeseries)` pushes raw timeseries only to the PromoterPanel (used in mean-se mode to avoid wiping summary data on CountsPanels). Phase-space API: `showPhaseSpace(result)`, `hidePhaseSpace()`, `setPhaseSpaceData(result)`, `setPhaseSpaceTimepoint(t)`, `onPhaseSpacePathSelect(cb)`, `onPhaseSpaceHover(cb)`. Highlight: `highlightPath(path)` and `highlightGene(gene)` fan out to all panels (composable -- both filters apply simultaneously). Callbacks: `onTimepointChange`, `onSelectionChange`, `onSegmentClick`, `onHoverChange`, `onTimeseriesPathHover(cb)`, `onDrillIn(cb)` (double-click on timeline rectangle). |
| `StreamingAnimator.ts` | Frame-rate-independent axis animation during streaming. Lerps displayed x/y ranges toward targets using exponential easing (`1 - e^(-speed * dt)`, speed=8/s). `start()`, `stop()`, `setTargetX(xMax)`, `setTargetY(panelId, yMin, yMax)`. Calls `onUpdate(RangeUpdate)` each frame with interpolated ranges. |
| `panels/BasePanel.ts` | Abstract base: SciChartSubSurface, wasmContext, visibility, `setTimeExtent`. Composable highlight system: `highlightPath(path)` + `highlightGene(gene)` set independent filters, both call `_applyHighlightFilters()`. Helper `_seriesMatchesFilters(name)` checks `<gene>:<path>` naming against both active filters. Exported utilities: `extractGene(name)`, `extractPath(name)`, `PATH_DIM_OPACITY`. Methods: `applyTheme`, `dispose`. |
| `panels/TimeseriesPanel.ts` | Abstract: adds `metadata`, `pathTimeRanges`, segment boundary dashed lines (`setSegmentBoundaries`), `onPathHover(cb)` (wired to `TimeseriesHoverModifier`), abstract `setData`, `appendStreamingData`, `clearData` |
| `panels/TimelinePanel.ts` | FastRectangleRenderableSeries for schedule segments. Dynamic label sizing. Click-to-select zooms x-axis. Double-click fires `onDrillIn(executionPath)` for path-prefix drill-in. Hover fires `onHoverChange`. Overrides `highlightPath` to dim segments by execution path (maps `segment:<id>` -> `LayoutRectangle.executionPath`). Hover transition guard: `currentHoveredExecution` prevents stale unhover from clearing a newly-hovered rectangle. |
| `panels/PromoterPanel.ts` | FastBandRenderableSeries for promoter activity, positioned by `pathYRanges`. Streaming with cursor extension. `setPathDisplay(mode)` switches between per-path bands and averaged mode (`mean-se`), which shows one band per gene with mean activity across paths. |
| `panels/promoterAverage.ts` | `averagePromoterByGene(dataByPath)`: averages digital promoter step-function timeseries across execution paths per gene. Returns fractional activity (0-1). |
| `panels/CountsPanel.ts` | FastLineRenderableSeries for mRNA/protein counts. `setGeneLayout(stacked/overlaid)` creates per-gene y-axes via `LeftAlignedOuterVerticallyStackedAxisLayoutStrategy`; `setPathDisplay(overlaid/mean-se)` switches between per-path lines and mean+SE bands. `setMeanSEData(summary)` renders mean line + SE band per gene (SE band skipped when all SE=0, e.g. single-path schedules). Stacked mode: default y-axis kept visible but stripped to zero thickness (so cursor annotations remain bound to a visible axis); floating `TextAnnotation` serves as panel title; per-gene axes have gene-coloured tick labels, no axis titles. |
| `panels/PhaseSpacePanel.ts` | BasePanel subclass for phase-space embedding. Per-path trajectory lines + scatter points + hollow-circle timepoint highlight (theme-aware stroke). Methods: `setPhaseSpaceData(result)`, `setTimepoint(t)`, `onPathSelect(cb)`, `onHover(cb)`. Overrides `highlightPath` to skip when `PhaseSpaceHoverModifier` is active (avoids circular dimming). Hover/dimming/tooltip delegated to `PhaseSpaceHoverModifier`. Own zoom/pan modifiers (independent of timeseries). |
| `charts/chartConstants.ts` | Centralised font family, font sizes, axis thickness, segment palette. |
| `charts/timeFormat.ts` | Adaptive time formatting. `formatTime(seconds)` converts raw seconds to human-readable strings (e.g. "2.5 h", "3 d"). `setupTimeAxis(xAxis)` attaches adaptive formatting to a SciChart `NumericAxis`: sets `labelProvider.formatLabel` to include the unit suffix on each tick (e.g. "2.5 h"), subscribes to `visibleRangeChanged` to update the unit, and sets axis title to "Time". Returns an unsubscribe function. Used by all time x-axes (CountsPanel, PromoterPanel, TimelinePanel) and `formatTime` is used directly in cursor/tooltip formatters. |
| `layout/PanelGroup.ts` | Lightweight registry of related panels. `add(id, panel)`, `remove(id)`, `visibleSurfaces`, `allSurfaces`. Used by scoped modifiers and ChartLayout. |
| `layout/ChartLayout.ts` | Recursive tree-based layout engine replacing SubChartLayoutModifier. `LayoutNode` = `GroupNode` (vertical stack of a PanelGroup) or `SplitNode` (horizontal/vertical split with ratio). Manages `SciChartVerticalGroup` per PanelGroup. Adaptive y-axis font scaling. |
| `layout/rectangleLayout.ts` | `layoutRectangles(structure, segments, yMin, yMax, maxPaths?)` and `collectPathYRanges`. Caps duration paths at configurable `maxPaths` (default `DEFAULT_MAX_TIMELINE_PATHS=20`, overridden via `viewerStore.maxTimelinePaths`); excess paths are excluded from layout. |
| `modifiers/AxisSyncModifier.ts` | Scoped to a `PanelGroup`. Syncs X-axis visible range only across group's surfaces. |
| `modifiers/DragGuardModifier.ts` | Tracks mouse delta between mouseDown/mouseMove. Exposes `isDrag` flag for click-vs-drag discrimination. |
| `modifiers/SelectSyncModifier.ts` | Scoped to a `PanelGroup`. Syncs selection by group key across group's surfaces. Accepts generic `GroupingFn`. |
| `modifiers/SharedTimeCursorModifier.ts` | Scoped to a `PanelGroup`. Vertical cursor line synced across group's surfaces. |
| `modifiers/TimeseriesHoverModifier.ts` | Custom `ChartModifierBase2D` for timeseries hover. Nearest-point hit-test with tooltip. Fires `onPathHover(path)` callback when the hovered execution path changes, enabling bidirectional path highlight sync. |
| `modifiers/PhaseSpaceHoverModifier.ts` | Custom `ChartModifierBase2D` for phase-space hover. Uses `hitTestProvider.hitTestDataPoint` on scatter series for accurate sub-surface hit-testing. Path dimming, tooltip DOM, hover callback. Exposes `isHovering` getter for external guard. |

### Network (Cytoscape)

| File | Purpose |
| ------ | --------- |
| `network/NetworkView.ts` | Orchestrator. Owns Cytoscape instance, lifecycle. Creates and coordinates sub-modules. Uses `layoutstop` event (not timeout). Layout: fcose with nodeRepulsion=50000, idealEdgeLength=100, edgeElasticity=0.8, numIter=5000. |
| `network/networkElements.ts` | `getGeneViewElements(network, geneColours)` — gene nodes + orphan species + scope `all`/`gene` edges (resolved to gene parents via `buildNodeParentMap`). `getSpeciesViewElements(network, geneColours)` — species/reaction compound children + scope `all`/`species` edges (actual endpoints); also includes gene-level `all`-scoped edges where at least one endpoint is a gene without species children (flat genes stay visible in species view). `buildNodeParentMap(network, geneNames)` — maps node names to gene parents for generic endpoint resolution. |
| `network/networkStyles.ts` | `buildStylesheet()` returns Cytoscape style array. `.excluded { display: none }` for ModelFilter. Compound parent selector `$node > node` for gene label positioning. Self-loop edge style. |
| `network/AdaptiveZoom.ts` | Zoom threshold (1.2). Precomputes gene-view and species-view element sets on `attach()`. Below threshold: gene nodes + gene-scope edges. Above: swaps in species/reaction nodes + species-scope edges. `.species-view` class only applied to regulatory edges with at least one species/reaction endpoint (gene-level edges keep normal styling). Species positioning: known types (mRNA/protein/active) cascade below gene, unknowns circular, reactions at neighbour centroid. 50ms debounce. Fires `onDetailChange` callback. |
| `network/ModelFilter.ts` | Watches `viewerStore.activeModelPath`. Toggles `.excluded` CSS class on nodes/edges (no add/remove, avoids conflicts with AdaptiveZoom). |
| `network/SelectionSync.ts` | Two-way sync: `viewerStore.selectedGenes` + `viewerStore.selectedSpeciesNodes` <-> Cytoscape node tap. Gene taps toggle `selectedGenes`; orphan-species taps toggle `selectedSpeciesNodes`. Local `visualSelection` (union of both) drives all dimming/highlighting uniformly via `resolveSelectable` — no node-type special-cases. Highlights selected genes, dims everything else. Edges undimmed when either endpoint is in `visualSelection`. |
| `network/HoverSync.ts` | Bidirectional gene hover sync. Network -> Store: `mouseover`/`mouseout` on `node.gene` sets `viewerStore.hoveredGeneId`. Store -> Network: watches `hoveredGeneId` and toggles `.gene-hover` CSS class (border highlight) on the corresponding Cytoscape node. `fromCy` guard prevents circular events. |
| `network/DynamicsSync.ts` | Watches `viewerStore.proteinCountsAtTimepoint` + `selectedGenes`. Only resizes selected genes; unselected stay at base size. Debounced at 16ms. Scales `padding` (6-40px) on gene nodes in both gene and species view — works for both leaf and compound-parent nodes. `notifyDetailChanged()` called by `NetworkView` on view transitions to reapply sizing immediately. |
| `network/Tooltip.ts` | Unified parameterised tooltip. `Tooltip` class: selector, content function, tooltip ID. Factories: `createEdgeTooltip()` (shows link kind on edge hover), `createNodeTooltip()` (shows node name/kind on node hover). Lightweight DOM element positioned at cursor. |

### Theming & Dark Mode

| File | Purpose |
| ------ | --------- |
| `config/theme.ts` | Single source of truth. Palettes (RED, PURPLE, GREEN, GREY), EDGE_COLOURS (mode-independent; includes `produces` for summary production edges), light/dark ThemeMode objects, `getTheme(isDark)`, `palette` export for PrimeVue preset. Each ThemeMode bundles a SciChart `IThemeProvider`. |
| `config/api.ts` | Runtime-configurable API host, `isTauri()` environment detection, `setBackendHost()`. |
| `composables/useTheme.ts` | Reactive `isDark` ref, OS-preference fallback, localStorage persistence. `toggle()`, `onThemeChange(fn)` for imperative consumers. Toggles `.app-dark` class on `<html>`. |
| `utils/logging.ts` | Lightweight tagged logger: `getLogger(tag)` returns `{ debug, info, warn, error }`. Debug only in dev. |
| `utils/grsTooltip.ts` | `v-grs-tooltip` Vue directive — shared DOM tooltip on hover, consistent with Cytoscape/timeline tooltips. |
| `utils/saveFile.ts` | Unified file save: Tauri native dialog (`@tauri-apps/plugin-dialog` + `plugin-fs`) or browser download. `saveFile(blob, opts)`. |
| `utils/canvasExport.ts` | `compositCanvasesToBlob(root)` — composites all child canvases of a DOM element onto a single output canvas at 4x resolution. Used for Tauri PNG export (WKWebView can't export canvases via html-to-image's foreignObject pipeline). |
| `utils/consoleCapture.ts` | `installConsoleCapture()` — monkey-patches `console.info/warn/error` (+ debug in dev) to push lines to `logStore`. Called once after Pinia init. |
| `components/LogDrawer.vue` | Sliding bottom drawer showing diagnostic logs. Filter tabs (All/Backend/Frontend), copy-all, clear. Opened via app menu View > Show Diagnostic Logs (Cmd+Shift+L). |

**Architecture:** `theme.ts` defines hex palettes once. Mode themes reference only palette entries. PrimeVue reads `palette.*` in `main.ts` preset. SciChart/Cytoscape call `getTheme(isDark)`. `useTheme` composable provides reactive state; Vue components wire `onThemeChange` to call `MainChart.applyTheme(dark)` / `NetworkView.applyTheme(dark)` for runtime switching.

### Data Flow

1. Schedule loaded -> `scheduleStore.loadScheduleByKey/Spec` -> server returns `ScheduleData` (segments, structure, genes, gene_colours, no network)
2. `TrackViewer` watches schedule data -> `MainChart.setScheduleData` -> `TimelinePanel` computes layout rectangles -> `collectPathYRanges` passed to `PromoterPanel`. Then calls `scheduleStore.fetchUnionNetwork()` which eagerly fetches union of all models. The schedule data watcher uses `viewerStore.filteredSegments` (filtered by `pathFilter`) so changing the path prefix re-layouts the timeline.
3. `NetworkDiagram` watches `scheduleStore.unionNetwork` -> `NetworkView.setNetwork()` -> renders gene-level graph (gene nodes + orphan species + resolved edges) -> fcose layout runs once -> sub-modules attach: `AdaptiveZoom` precomputes both view element sets, `ModelFilter` hides excluded nodes for first model, `SelectionSync` + `DynamicsSync` start watching.
4. Simulation loaded -> `simulationStore.loadResult` loads metadata only. `selectedGenes` watcher triggers `fetchGeneTimeseries(genes)` which lazily loads per-gene timeseries via `POST /simulations/{id}/timeseries`. After fetch -> `refreshSimulationData()` pushes to chart with `SweepAnimation`.
5. Gene selection: click on series (chart) -> `viewerStore.selectedGenes` updates -> lazy fetch for new genes -> `SelectionSync` highlights in network. Click on gene node (network) -> same flow.
6. `activeModelPath` is a computed that prioritises `hoveredModelPath` (from timeline hover), falling back to `currentTimepoint` + segments. Hovering a timeline segment updates the network in real-time.
7. **Path highlight sync:** `viewerStore.hoveredExecutionPath` is the single hub. Writers: `TimelinePanel` hover, `PhaseSpaceHoverModifier`, `TimeseriesHoverModifier` (all via `setHoveredRectModel`). Reader: one watcher in `TrackViewer` calls `MainChart.highlightPath(path)` which fans out `BasePanel.highlightPath()` to every panel. `TimelinePanel` overrides to map `segment:<id>` to execution paths. `PhaseSpacePanel` overrides to skip when its own modifier is active. `PromoterPanel` overrides to rewrite `fillY1` alpha (band opacity doesn't affect fill). `PATH_DIM_OPACITY` exported from `BasePanel`.
8. **Gene highlight sync (bidirectional):** `viewerStore.hoveredGeneId` is the hub. Writers: `HoverSync` (network gene node hover) and `TimeseriesHoverModifier` (timeseries panel hover, via `onGeneHover` callback -> `TrackViewer` -> store). Readers: (a) watcher in `TrackViewer` calls `MainChart.highlightGene(gene)` which fans out to all panels; (b) `HoverSync` watches the store and toggles `.gene-hover` on the Cytoscape node. Composable with path highlight: `BasePanel._seriesMatchesFilters()` checks both gene and path filters on `<gene>:<path>` series names. `PhaseSpacePanel` and `TimelinePanel` override `highlightGene` as no-ops.
9. Zoom in past threshold -> `AdaptiveZoom` swaps gene-scope edges for species-scope edges and adds species/reaction compound children (gene positions pinned) -> `ModelFilter.refresh()` + `SelectionSync.refresh()`.
10. **Path prefix filter:** `viewerStore.pathFilter` (empty = show all). `filteredSegments` computed uses `filterSegmentsByPrefix` (same regex as inspect tool: `^prefix(?=[/+-]|$)`). Propagated to: timeline layout (schedule data watcher), timeseries (`refreshSimulationData` uses `filteredPaths`), phase space (`activePhaseSpaceResult` filters points/timeseries by `filteredPaths`), network dynamics (`proteinCountsAtTimepoint` falls back to `filteredPaths`). Double-click on timeline rectangle triggers drill-in via `onDrillIn` callback -> `setPathFilter`. AutoComplete input in TrackViewer toolbar.
11. **Channel filter:** `viewerStore.channelFilter` (empty = show all). Composed with path filter in `filteredSegments` via `filterSegmentsByChannel`. AutoComplete input stacked vertically with path filter. Timeline rectangles are shaded per-channel using `buildChannelColourMap` (grey tones from 40-75% lightness); `TimelinePanel.channelColourMap` + `segmentChannelMap` drive per-rect colours.

### Simulation Streaming

**Backend flow:**
1. `POST /simulations/run` creates a `SimulationController` with `ws_ref` pointing to the global `ws_client` Ref and `ws_lock = WS_LOCK`. Returns immediately with `status=running`.
2. `StreamingSimulationSink` receives every simulation event. It writes Arrow IPC to disk, and if the controller has subscribed species, accumulates timeseries data per species/path. WS sends use the controller's lazy `ws_ref` lookup.
3. At time-window intervals (`stream_interval = 500ms` wall-clock), the sink sends a `progress` message and a `timeseries` batch to the WS client via the controller.
4. When the simulation completes, the controller sends a final `status: completed` message.

**WS protocol** (`/ws`):
- Client -> Server: `{ type: "subscribe", species: [...] }`, `{ type: "pause" }`, `{ type: "resume" }`
- Server -> Client: `{ type: "progress", simulation_id, current_time, frame_count }`, `{ type: "timeseries", simulation_id, data: TimeseriesData }`, `{ type: "status", simulation_id, status, error? }`, `{ type: "phasespace_ready", simulation_id }` (sent after phase-space computation completes; client then fetches `GET /simulations/{id}/phasespace`)

**Pause/resume:** `check_pause!(controller)` is called on every sink event. When paused, the simulation thread blocks on a `Threads.Condition`. Resume notifies the condition.

**Frontend flow:**
1. `simulationStore.runSimulation()` awaits `stream.connect()` (returns a Promise that resolves on `ws.onopen`), then fires the HTTP POST. This ensures the backend has a valid `ws_client` before the simulation starts. Tracks the simulation ID, and subscribes the first N selected genes.
2. WS `progress` callbacks update `currentResult.current_time`; `streamingDelta` holds the latest timeseries batch (not cumulative).
3. `useStreamingController` composable owns the entire streaming lifecycle: buffer accumulation, RAF-based data flushing (via `MainChart.appendStreamingDataOnly`), and smooth axis animation (via `StreamingAnimator`). Data is appended as fast as it arrives; axis ranges lerp smoothly toward targets using frame-rate-independent exponential easing. On completion, the composable discards the buffer and stops — the full data is fetched via HTTP and rendered through `setSimulationData`.
4. Each panel maintains a `seriesMap` of persistent `XyDataSeries` / `XyyDataSeries` and a **trailing cursor extension point**: a temporary last point at `min(currentTime, pathEndTime)` with the last known value. Cursor points are clamped to the path's time range via `pathTimeRanges` (computed from segments by `getPathTimeRanges`) so they don't extend into later segments.
5. `PromoterPanel` pre-computes band layout params (yCenter, bandHeight) for every (gene, path) key when `setPathYRanges` or `setMetadata` is called, so streaming doesn't need to guess band dimensions.
6. Progress-driven time cursor sync moves `viewerStore.currentTimepoint` during simulation.
7. On completion, the store clears the streaming cache and refetches definitive timeseries via HTTP. `setData` renders the complete result with `SweepAnimation`.
8. Before calling `untrack()` on status=completed, the store registers `trackPhaseSpace(simId, _onPhaseSpaceReady)`. When the server sends `phasespace_ready`, `_onPhaseSpaceReady` fetches `GET /simulations/{id}/phasespace` and sets `phaseSpaceResult`. `TrackViewer` auto-shows `PhaseSpacePanel` when `isPhaseSpaceAvailable` flips to true. `PhaseSpacePanel` also tries to load a pre-existing phase-space result when `loadResult` is called for an already-completed simulation.

### Loading UX Pattern

Two overlay classes:
- `.disabled-overlay`: dim, no spinner, pointer-events disabled. Used when a component is waiting for an earlier loading stage.
- `.loading-overlay` + `.loading-card`: dim with centred spinner + text. Used when that component's data is actively being fetched.

Schedule change stages:
1. Editor clears content, shows "Validating schedule..." spinner overlay. Chart and network show `.disabled-overlay` (old content visible, dimmed).
2. When validation returns, editor updates. Chart/network get new data; old content replaced.
3. Network fetch fires non-blocking after schedule data arrives. Network shows spinner only during `isNetworkLoading`.

Simulation timeseries: first-ever fetch shows full overlay on chart; subsequent gene selections show spinner in MultiSelect only.

### Key Naming Convention

`dataSeriesName` format: `{geneId}:{executionPath}` for timeseries, `segment:{segmentId}` for timeline rectangles. Sync modifiers extract gene ID as prefix before `:` and skip `segment:` prefixed names.

### Types

| File | Key Types |
| ------ | ----------- |
| `types/schedule.ts` | `TimelineSegment` (id, execution_path, model_path, json_path, from, to, label, channel), `StructureNode` (type, execution_path, label, children), `ScheduleData`, `ReifiedSchedule`. Functions: `getPathTimeRanges`, `getSegmentBoundaryTimes`, `getActivePathsAtTime`, `matchesPathPrefix`, `filterSegmentsByPrefix`, `extractChannels`, `filterSegmentsByChannel` |
| `types/simulation.ts` | `TimeseriesData` = `Record<species, Record<path, [t,v][]>>`, `TimeseriesMetadata`, `SimulationResult` (unified; `current_time`, `max_time`, `total_progress`, `status` includes `'paused'`), `SimulationStatus`, `PhaseSpacePoint` (x, y, path, t, colour), `PhaseSpaceResult` (simulation_id, method, axis_labels, axis_top_genes, points, n_genes, n_cells), `getProgress()` (prefers `total_progress`), `getMaxTime()`, `formatResultLabel()` |
| `types/network.ts` | `Node`, `Link` (with `scope: LinkScope`), `LinkScope` (`'all' | 'gene' | 'species'`), `Network`, `UnionNetwork`, `ModelExclusions`, `linkId()`, `MODEL_NODE_KINDS` |

### Components

| File | Purpose |
| ------ | --------- |
| `App.vue` | 3-panel splitter layout |
| `TrackViewer.vue` | Toolbar (run/load/gene filter/track settings/phase-space toggle) + MainChart. `showPhaseSpace` ref auto-set true when `isPhaseSpaceAvailable` becomes true; toggles `chart.showPhaseSpace(result)` / `chart.hidePhaseSpace()`. Watches phase-space result + timepoint. |
| `NetworkDiagram.vue` | Cytoscape graph via `NetworkView`. Model label overlay (bottom-left). Watches `scheduleStore.unionNetwork`. |
| `ScheduleEditor.vue` | Schedule dropdown + Monaco JSON editor + validation. No schedule is loaded on startup; user must select one. Watches `viewerStore.hoveredModelPath` and `selectedSegmentIds`; resolves the corresponding `json_path` from loaded segments via `findRangeForJsonPath`, then calls `highlightScope`/`clearScopeHighlight` to highlight and optionally scroll to the active scope in the editor. |

### Utils and Services

| File | Purpose |
| ------ | --------- |
| `utils/colorUtils.ts` | `parseColour` (hex + HSL), `rgbToHex`, `lerpColor`, `lighten`, `darken`, `withOpacity`, `buildChannelColourMap`, `contrastTextColour` |
| `utils/jsonPathUtils.ts` | `findRangeForJsonPath(text, path)` — resolves a `(string|number)[]` JSONPath (as produced by the backend's `model_path_to_json_path`) to `{ startOffset, endOffset }` inside a JSON string using `jsonc-parser` |
| `utils/api.ts` | `apiFetch`, `apiFetchJson`, `apiFetchText` with retry (exponential backoff, no timeout) |
| `services/scheduleService.ts` | Schedule API: load, save, list, `fetchUnionNetwork` |
| `services/simulationService.ts` | Simulation API: `runSimulation`, `loadResult`, `listResults`, `fetchTimeseriesForSpecies`, `fetchPhaseSpace(resultId)`, `fetchTimeseriesSummary(resultId, species, nPoints)` (POST `/simulations/{id}/timeseries/summary`). |

### Composables

| File | Purpose |
| ------ | --------- |
| `composables/useSimulationStream.ts` | WebSocket connection for live simulation streaming. Singleton via `getSimulationStream()`. Functions: `connect`, `disconnect`, `subscribe(species)`, `pause`, `resume`, `track(id, callbacks)`, `untrack` (clears only progress/timeseries/status callbacks), `trackPhaseSpace(simId, cb)` (separate callback that survives `untrack()`), `clearPhaseSpaceTracking()`. Callbacks: `ProgressCallback`, `TimeseriesCallback`, `StatusCallback`, `PhaseSpaceReadyCallback`. Handles `phasespace_ready` WS message type. Auto-reconnect on disconnect. |
| `composables/useStreamingController.ts` | Streaming lifecycle: buffer accumulation, RAF data flush, smooth axis animation. `start()` sets up watchers on `streamingDelta` and `currentResult.current_time`, starts `StreamingAnimator`. `stop()` cancels RAF, discards buffer, stops animator, tears down watchers. `dispose()` for cleanup. Decouples data ingestion speed from visual axis updates. |
| `composables/useMonacoEditor.ts` | Monaco editor lifecycle: `init`, `setValue`, `getContent`, `updateOptions`, `dispose`. Scope highlighting: `highlightScope(startOffset, endOffset, scroll?)` adds a decoration (`scope-highlight` + `scope-highlight-gutter` CSS classes) and optionally scrolls; `clearScopeHighlight()` removes it. |
