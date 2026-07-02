<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { useSimulationStore } from '@/stores/simulationStore'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useViewerStore } from '@/stores/viewerStore'
import type { SimulationResult } from '@/types/simulation'
import { formatResultLabel } from '@/types/simulation'
import { speciesTypeLabels, DEFAULT_VISIBLE_SPECIES_TYPES, COUNT_SPECIES_TYPES } from '@/types/schedule'
import type { SpeciesType } from '@/types/schedule'
import Button from 'primevue/button'
import Select, { type SelectChangeEvent } from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import InputText from 'primevue/inputtext'
import ProgressSpinner from 'primevue/progressspinner'
import ProgressBar from 'primevue/progressbar'
import OverlayPanel from 'primevue/overlaypanel'
import Checkbox from 'primevue/checkbox'
import * as simulationService from '@/services/simulationService'
import { MainChart, type Viewport } from '@/charts/MainChart'
import { LiveBuffer } from '@/charts/liveBuffer'
import { useTheme } from '@/composables/useTheme'
import { buildClientPhaseSpace, recolourPhaseSpace } from '@/charts/phaseSpaceBuilder'
import { GREEN, RED } from '@/config/theme'
import { contrastTextColour } from '@/utils/colorUtils'
import type { TimeseriesData } from '@/types/simulation'
import { getTimeExtent } from '@/types/schedule'
import LoadingOverlay from '@/components/LoadingOverlay.vue'
import PanelState from '@/components/PanelState.vue'
import { compatibleExecutionPaths } from '@/schedule/executionTrie'

const simulationStore = useSimulationStore()
const scheduleStore = useScheduleStore()
const viewerStore = useViewerStore()
const { isDark, onThemeChange } = useTheme()

const DEFAULT_SELECTED_GENES_COUNT = 5
const LIVE_POLL_INTERVAL_MS = 500

const containerRef = ref<HTMLDivElement>()
const results = ref<SimulationResult[]>([])
const selectedTracks = ref<string[]>([])
/** Stashed track selection preserved across simulation reload blips. */
let previousTrackSelection: string[] | null = null
const trackSettingsPanel = ref()
const previousGeneSelection = ref<string[] | null>(null)
const showPhaseSpace = ref(false)
const countsLogScale = ref(false)
const isFinalizingSimulation = ref(false)
/** Error message shown as overlay when a result fails to load. */
const resultError = ref<string | null>(null)

const chart = new MainChart()
let livePollGeneration = 0
let livePollTimer: ReturnType<typeof setTimeout> | null = null
const liveBuffer = new LiveBuffer()
let phasePollTimer: ReturnType<typeof setTimeout> | null = null
let resizeRaf: number | null = null
let stopThemeListener: (() => void) | null = null

const OTHER_SPECIES_COLOUR = '#9e9e9e'

const isScheduleLoading = computed(() => scheduleStore.isLoading)
const isSimulationBusy = computed(() =>
    simulationStore.isSimulationRunning || simulationStore.isLoadingResult || isFinalizingSimulation.value
)
const isUiDisabled = computed(() => !scheduleStore.isLoaded || isScheduleLoading.value || isSimulationBusy.value)
const hasSimulationContent = computed(() =>
    simulationStore.isSimulationRunning || Boolean(simulationStore.currentResultId)
)
const showSimulationEmptyState = computed(() =>
    scheduleStore.isLoaded
    && !hasSimulationContent.value
    && !isSimulationBusy.value
    && !resultError.value
)

/** The backend reports `finalizing` while it pre-builds the viewport pyramids
 *  after a run finishes computing but before flipping to `completed`. During that
 *  window the chart is frozen on the last live frame, so we show the small
 *  spinner to signal the wait isn't silent. */
const isFinalizingResult = computed(() => simulationStore.currentResult?.status === 'finalizing')

/** Smoothly-tweened progress in [0,1]. The store value only refreshes per live
 *  poll (~500 ms), so the raw value ticks in visible steps. Rather than ease
 *  *toward* the latest sample (an exponential filter chasing a steadily-rising
 *  target settles to a constant lag below it, then snaps up at the end — the
 *  bar reads low the whole way then races to 100%), we linearly tween from the
 *  previous sample to the new one across one poll interval. That gives steady,
 *  genuinely proportional motion with no persistent under-read. */
const displayedProgress = ref(0)
let progressRaf: number | null = null
let progressTweenFrom = 0
let progressTweenTarget = 0
let progressTweenStart = 0

function animateProgress() {
    const target = simulationStore.progress
    if (target !== progressTweenTarget) {
        // New sample arrived -- start a fresh linear segment from where the bar
        // currently sits toward the new target.
        progressTweenFrom = target < progressTweenTarget - 0.001
            ? target // backwards (new run / reset): snap, don't crawl down.
            : displayedProgress.value
        progressTweenTarget = target
        progressTweenStart = performance.now()
    }
    const f = Math.min((performance.now() - progressTweenStart) / LIVE_POLL_INTERVAL_MS, 1)
    displayedProgress.value = progressTweenFrom + (progressTweenTarget - progressTweenFrom) * f
    progressRaf = requestAnimationFrame(animateProgress)
}

/** Bar fill percentage (0-100), fine-grained so the width grows smoothly. */
const progressPercent = computed(() => Math.round(displayedProgress.value * 1000) / 10)

/** Integer label that grows in step with the eased bar. */
const progressLabel = computed(() => `${Math.round(displayedProgress.value * 100)}%`)

function requestChartResize(): void {
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
    resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        chart.resizeToContainer()
    })
}

function syncVisibleTracks(): void {
    chart.setVisibleTracks(selectedTracks.value)
    requestChartResize()
}

/** Determine which loading overlay to show with priority (only one shown at a time). */
const activeLoadingState = computed(() => {
    // A result load owns its nested schedule load, so describe the user action
    // rather than the internal step currently in progress.
    // Once result metadata and its schedule are ready, hand timeseries loading
    // over to the small chart spinner instead of keeping the full overlay up.
    if (simulationStore.isLoadingResult && !simulationStore.isFetchingTimeseries) return 'result'
    if (isScheduleLoading.value) return 'schedule'
    if (simulationStore.isPreparingSimulation) return 'preparing'
    return null
})

// -- Combined gene/species selector --------------------------------------------------

/** Set of other-species names for quick lookup. */
const otherSpeciesSet = computed(() => new Set(scheduleStore.allOtherSpecies))

/** Grouped options for the combined MultiSelect. */
const selectorOptionGroups = computed(() => {
    const groups: Array<{ group: string; items: Array<{ label: string; value: string }> }> = []
    const genes = scheduleStore.allGenes ?? []
    if (genes.length > 0) {
        groups.push({ group: 'Genes', items: genes.map(g => ({ label: g, value: g })) })
    }
    const other = scheduleStore.allOtherSpecies
    if (other.length > 0) {
        groups.push({ group: 'Other species', items: other.map(s => ({ label: s, value: s })) })
    }
    return groups
})

/** Merged selection array for the MultiSelect model. */
const combinedSelection = computed(() => [
    ...viewerStore.selectedGenes,
    ...viewerStore.selectedOtherSpecies,
])

/** Route selection changes back to the correct store arrays. */
function onCombinedSelectionChange(newValues: string[]): void {
    const others = otherSpeciesSet.value
    viewerStore.selectedGenes = newValues.filter(v => !others.has(v))
    viewerStore.selectedOtherSpecies = newValues.filter(v => others.has(v))
}

/** Remove a single item from the combined selection. */
function removeCombinedSelection(id: string): void {
    if (otherSpeciesSet.value.has(id)) {
        viewerStore.selectedOtherSpecies = viewerStore.selectedOtherSpecies.filter(s => s !== id)
    } else {
        viewerStore.selectedGenes = viewerStore.selectedGenes.filter(g => g !== id)
    }
}

/** Chip style: gene colour for genes, neutral grey for other species. */
function selectorChipStyle(id: string): Record<string, string | undefined> {
    const isOther = otherSpeciesSet.value.has(id)
    const bg = isOther ? OTHER_SPECIES_COLOUR : scheduleStore.geneColours?.[id]
    return {
        backgroundColor: bg,
        borderColor: bg,
        color: bg ? contrastTextColour(bg) : undefined,
    }
}

/** Swatch style for dropdown options. */
function selectorSwatchStyle(id: string): Record<string, string | undefined> {
    const isOther = otherSpeciesSet.value.has(id)
    const bg = isOther ? OTHER_SPECIES_COLOUR : scheduleStore.geneColours?.[id]
    return { backgroundColor: bg, borderColor: bg }
}

// -------------------------------------------------------------------------------------

const trackOptions = computed(() => {
    const options: Array<{ label: string; value: string }> = []

    // Only include species types if simulation loaded. (The schedule timeline and
    // promoter panels were removed from the charts — session-2 clean break.)
    if (simulationStore.isLoaded) {
        COUNT_SPECIES_TYPES.forEach(type => {
            options.push({ label: speciesTypeLabels[type], value: type })
        })
        // Only show "Other species" when the schedule has non-gene species
        if (scheduleStore.allOtherSpecies.length > 0) {
            options.push({ label: speciesTypeLabels['other'], value: 'other' })
        }
    }

    return options
})

watch(
    () => ({
        scheduleLoaded: scheduleStore.isLoaded,
        simulationLoaded: simulationStore.isLoaded,
        hasOtherSpecies: scheduleStore.allOtherSpecies.length > 0
    }),
    (state, oldState) => {
        const validTracks: string[] = []

        if (state.simulationLoaded) {
            COUNT_SPECIES_TYPES.forEach(type => validTracks.push(type))
            if (state.hasOtherSpecies) {
                validTracks.push('other')
            }
        }

        // Simulation just became unloaded -- stash current tracks so we can restore them
        const simulationJustUnloaded = !state.simulationLoaded && oldState?.simulationLoaded
        if (simulationJustUnloaded) {
            previousTrackSelection = [...selectedTracks.value]
        }

        // Set defaults when simulation transitions to loaded (only if no tracks already selected)
        const simulationJustLoaded = state.simulationLoaded && !oldState?.simulationLoaded
        if (simulationJustLoaded) {
            // Restore stashed selection if available (re-run preserves user choice)
            if (previousTrackSelection !== null) {
                const restored = previousTrackSelection.filter(t => validTracks.includes(t))
                previousTrackSelection = null
                if (restored.length > 0) {
                    selectedTracks.value = restored
                    return
                }
            }
            if (selectedTracks.value.length === 0) {
                selectedTracks.value = [...DEFAULT_VISIBLE_SPECIES_TYPES]
            }
            return
        }
        
        const filtered = selectedTracks.value.filter(t => validTracks.includes(t))
        
        if (filtered.length !== selectedTracks.value.length) {
            selectedTracks.value = filtered
            updateViewerStore()
        }
    }
)

// A committed schedule replacement invalidates every trajectory panel, even
// before the associated simulation result is cleared by the initiating view.
watch(
    () => scheduleStore.schedule.spec,
    (spec, previousSpec) => {
        if (spec === previousSpec) return
        previousTrackSelection = null
        chart.clearSimulationData()
        showPhaseSpace.value = false
        selectedTracks.value = []
    },
)

/** Active phase-space result: client-side for 1-2 genes, server-precomputed otherwise. */
const activePhaseSpaceResult = computed(() => {
    const genes = viewerStore.selectedGenes
    const timeseries = simulationStore.timeseries
    const metadata = scheduleStore.timeseriesMetadata
    const resultId = simulationStore.currentResult?.id
    const pathSet = viewerStore.filteredPaths

    if (genes.length >= 1 && genes.length <= 2 && timeseries && metadata && resultId) {
        const filtered = pathSet ? filterTimeseriesByPaths(timeseries, pathSet) : timeseries
        return buildClientPhaseSpace(filtered, genes, metadata.gene_colours, resultId)
    }

    const serverResult = simulationStore.phaseSpaceResult
    if (serverResult && genes.length >= 1 && timeseries && metadata) {
        const filteredResult = pathSet
            ? { ...serverResult, points: serverResult.points.filter(p => pathSet.has(p.path)) }
            : serverResult
        const filtered = pathSet ? filterTimeseriesByPaths(timeseries, pathSet) : timeseries
        return recolourPhaseSpace(filteredResult, genes, filtered, metadata.gene_colours)
    }
    return serverResult
})

// Phase space is not auto-shown when its result becomes available; the user
// reveals it via the toolbar button. `showPhaseSpace` stays false (and is
// reset to false on every run) until then.

// When showPhaseSpace toggles via the button, show/hide in MainChart
watch(showPhaseSpace, (show) => {
    if (show && activePhaseSpaceResult.value) {
        chart.showPhaseSpace(activePhaseSpaceResult.value)
    } else {
        chart.hidePhaseSpace()
    }
})

// When active phase-space result changes, update the chart
watch(activePhaseSpaceResult, (result) => {
    if (result && showPhaseSpace.value) {
        chart.setPhaseSpaceData(result)
    }
})

// When timepoint changes, update highlighted position in phase space
watch(
    () => viewerStore.currentTimepoint,
    (t) => {
        if (activePhaseSpaceResult.value && showPhaseSpace.value) {
            chart.setPhaseSpaceTimepoint(t)
        }
    }
)

watch(
    () => ({ segments: viewerStore.filteredSegments, metadata: scheduleStore.timeseriesMetadata }),
    ({ segments, metadata }) => {
        if (segments && segments.length > 0 && metadata) {
            // Stale-closure guard: ignore if schedule changed mid-flight
            const specAtStart = scheduleStore.schedule.spec
            console.debug(`[TrackViewer] Schedule data ready: ${segments.length} segments (filter="${viewerStore.pathFilter}")`)
            try {
                chart.setScheduleData(segments, metadata)
            } catch (error) {
                // Chart rendering is imperative and must not abort Vue's update
                // cycle (in particular, removal of the loading overlay).
                console.error('[TrackViewer] Failed to render schedule data:', error)
                scheduleStore.isLoading = false
                return
            }

            // Only refresh if schedule hasn't changed during the above
            if (scheduleStore.schedule.spec === specAtStart) {
                refreshSimulationData()
            }
        }
        // A direct setSchedule (save/upload) raises isLoading without going
        // through the fetch path; clear it now that the new tracks have rendered.
        scheduleStore.isLoading = false
    },
    // The same schedule commit also clears scheduleStore.isLoading. Let Vue
    // render that state before doing the comparatively heavy SciChart update.
    { flush: 'post' },
)

watch(
    () => scheduleStore.allGenes,
    (allGenes, oldGenes) => {
        if (!allGenes || allGenes.length === 0) return
        // Preserve selection if the gene set hasn't changed
        const genesChanged = !oldGenes || allGenes.length !== oldGenes.length || allGenes.some((g, i) => g !== oldGenes[i])
        if (!genesChanged) return
        // Keep existing selection if it's still valid for the new gene set
        const newGeneSet = new Set(allGenes)
        const stillValid = viewerStore.selectedGenes.filter(g => newGeneSet.has(g))
        if (stillValid.length > 0) {
            viewerStore.selectedGenes = stillValid
        } else if (simulationStore.isLoaded) {
            viewerStore.selectedGenes = allGenes.slice(0, DEFAULT_SELECTED_GENES_COUNT)
        } else {
            // No simulation: select all genes so the network looks complete
            viewerStore.selectedGenes = [...allGenes]
        }
    }
)

// Lazy-fetch timeseries when selected genes change
watch(
    () => viewerStore.selectedGenes,
    async (genes) => {
        if (!simulationStore.isLoaded || genes.length === 0) return
        const capped = genes.slice(0, viewerStore.maxRenderedGenes)

        // The next live poll atomically reconciles this selection.
        if (simulationStore.isSimulationRunning) return

        await simulationStore.fetchGeneTimeseries(capped)
        refreshSimulationData()
    },
    { deep: true }
)

// Re-fetch/refresh when max rendered genes limit changes
watch(
    () => viewerStore.maxRenderedGenes,
    async (maxGenes) => {
        if (!simulationStore.isLoaded || viewerStore.selectedGenes.length === 0) return
        if (simulationStore.isSimulationRunning) return
        const capped = viewerStore.selectedGenes.slice(0, maxGenes)
        await simulationStore.fetchGeneTimeseries(capped)
        refreshSimulationData()
    }
)



// Lazy-fetch timeseries when selected other species change
watch(
    () => viewerStore.selectedOtherSpecies,
    async (species) => {
        if (!simulationStore.isLoaded || species.length === 0) return

        if (simulationStore.isSimulationRunning) return

        await simulationStore.fetchOtherSpeciesTimeseries(species)
        refreshSimulationData()
    },
    { deep: true }
)

/**
 * Push screen-resolution data to the chart for a finished result, filtered by
 * selected genes/paths. Decimation happens server-side (the pyramid), so the
 * client only ever holds ~viewport-resolution data per series.
 *
 * Called with no argument for a full refresh (gene/path selection change) — fits
 * both axes over the schedule's full time extent. Called from `onViewportChange`
 * with a `vp` on zoom/pan — re-queries at the new window and preserves the range.
 */
let viewportRequestGeneration = 0

async function refreshSimulationData(vp?: Viewport, fullExtent = false, animate = true): Promise<void> {
    if (!simulationStore.isLoaded || simulationStore.isSimulationRunning) return
    const genes = viewerStore.selectedGenes.slice(0, viewerStore.maxRenderedGenes)
    if (genes.length === 0 && viewerStore.selectedOtherSpecies.length === 0) return
    const paths = viewerStore.selectedPaths ?? viewerStore.filteredPaths
    const pathArray = paths ? [...paths] : null

    // Window: the user's current view (zoom/pan) or, on a full refresh, the
    // schedule's whole time extent.
    const extent = getTimeExtent(scheduleStore.segments)
    const window = fullExtent
        ? { t0: extent.min, t1: extent.max, widthPx: 1500 }
        : vp ?? chart.getViewport() ?? { t0: extent.min, t1: extent.max, widthPx: 1500 }

    const generation = ++viewportRequestGeneration
    const data = await simulationStore.fetchViewport(
        genes, viewerStore.selectedOtherSpecies, pathArray,
        window.t0, window.t1, window.widthPx,
    )
    if (data && generation === viewportRequestGeneration) {
        chart.setSimulationData(data, { fitAxes: vp === undefined, animate })
        requestChartResize()
    }
}

/** Filter timeseries data to only include entries for paths in the given set. */
function filterTimeseriesByPaths(ts: TimeseriesData, paths: Set<string>): TimeseriesData {
    return Object.fromEntries(
        Object.entries(ts).map(([species, pathData]) => [
            species,
            Object.fromEntries(
                Object.entries(pathData).filter(([path]) => paths.has(path))
            )
        ])
    ) as TimeseriesData
}

function updateViewerStore() {
    viewerStore.selectedSpeciesTypes = selectedTracks.value as SpeciesType[]
}

async function loadResults() {
    results.value = await simulationService.fetchResultsList()
}

/**
 * Push already-available store data to the freshly-initialised chart.
 * Needed because dev-mode Pinia persistence restores scheduleStore before
 * chart.init() completes, so watchers fire against a not-yet-ready chart.
 */
function _hydrateFromPersistedState(): void {
    const segments = viewerStore.filteredSegments
    const metadata = scheduleStore.timeseriesMetadata
    if (segments.length > 0 && metadata) {
        console.debug(`[TrackViewer] Hydrating chart from persisted state: ${segments.length} segments`)
        chart.setScheduleData(segments, metadata)
    }
}


onMounted(async () => {
    loadResults()
    progressRaf = requestAnimationFrame(animateProgress)
    const themeAtStart = isDark.value
    await chart.init(containerRef, themeAtStart)
    chart.setVisibleTracks([])
    chart.setCountsLogScale(countsLogScale.value)
    stopThemeListener = onThemeChange((dark) => chart.applyTheme(dark))
    // Reconcile only if the theme actually changed during async init
    if (isDark.value !== themeAtStart) {
        chart.applyTheme(isDark.value)
    }

    chart.onTimepointChange((timepoint: number) => {
        viewerStore.setTimepoint(timepoint)
    })

    // Adaptive rendering: on zoom/pan, re-query the server pyramid at the new
    // window/resolution and swap the data in place (keeps the user's range).
    chart.onViewportChange((vp) => { refreshSimulationData(vp) })

    chart.onSelectionChange((selectedGenes: string[]) => {
        if (selectedGenes.length > 0) {
            // Save the full selection before narrowing (only on first narrowing)
            if (!previousGeneSelection.value) {
                previousGeneSelection.value = [...viewerStore.selectedGenes]
            }
            viewerStore.selectedGenes = [...selectedGenes]
        } else if (previousGeneSelection.value) {
            console.debug(`[TrackViewer] Restoring previous selection: [${previousGeneSelection.value}]`)
            viewerStore.selectedGenes = previousGeneSelection.value
            previousGeneSelection.value = null
        }
    })

    chart.onPhaseSpacePathSelect((path: string) => {
        viewerStore.selectExecutionPath(path)
    })

    chart.onPhaseSpaceHover((info) => {
        if (info) {
            viewerStore.setTimepoint(info.t)
            viewerStore.setHoveredRectModel(null, info.path)
            // Move the timeseries time cursor to match
            chart.setCursorTime(info.t)
        } else {
            viewerStore.setHoveredRectModel(null, null)
        }
    })

    // Timeseries panel path hover -> store (bidirectional sync)
    chart.onTimeseriesPathHover((path: string | null) => {
        viewerStore.setHoveredRectModel(null, path)
    })

    chart.onTimeseriesPathSelect((path: string) => {
        viewerStore.selectLineage(path)
    })

    // Timeseries panel gene hover -> store (bidirectional sync with network)
    chart.onTimeseriesGeneHover((gene: string | null) => {
        viewerStore.setHoveredGene(gene)
    })

    // Hydrate chart from persisted store state (dev-mode Pinia persistence).
    // Watchers fired before chart.init() completed, so push any available data now.
    _hydrateFromPersistedState()
    await nextTick()
    requestChartResize()
    window.setTimeout(requestChartResize, 50)
    window.setTimeout(requestChartResize, 250)
})

onBeforeUnmount(() => {
    stopLivePolling()
    stopThemeListener?.()
    stopThemeListener = null
    if (progressRaf !== null) cancelAnimationFrame(progressRaf)
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
    chart.dispose()
})

async function loadResult(event: SelectChangeEvent) {
    const selectedResultId = event.value
    // Cancel running simulation if switching results while paused
    if (simulationStore.isSimulationRunning) {
        simulationStore.cancelSimulation()
    }
    stopLivePolling()
    simulationStore.clearResult()
    chart.clearSimulationData()
    showPhaseSpace.value = false
    resultError.value = null

    await simulationStore.loadResult(selectedResultId)

    // If schedule was same spec, watchers won't fire -- explicitly fetch timeseries
    try {
        const genes = viewerStore.selectedGenes.slice(0, viewerStore.maxRenderedGenes)
        if (genes.length > 0 && simulationStore.isLoaded) {
            await simulationStore.fetchGeneTimeseries(genes)
        }
        const otherSpecies = viewerStore.selectedOtherSpecies
        if (otherSpecies.length > 0 && simulationStore.isLoaded) {
            await simulationStore.fetchOtherSpeciesTimeseries(otherSpecies)
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn('[TrackViewer] Failed to load timeseries for result:', msg)
        resultError.value = 'Corrupt or incompatible result — timeseries data could not be loaded'
        return
    }
    if (simulationStore.isLoaded) {
        // Apply the selection before installing the first simulation series.
        // On the initial load the menu state can settle while the chart still
        // has its schedule-only layout; the next user toggle would otherwise
        // be the first call that makes the trajectory panels visible.
        syncVisibleTracks()
        refreshSimulationData()
    }
}

function selectedLiveSpecies(): string[] {
    const genes = viewerStore.selectedGenes.slice(0, viewerStore.maxRenderedGenes)
    return [
        ...genes.flatMap(gene => scheduleStore.getSpeciesForGeneId(gene)),
        ...viewerStore.selectedOtherSpecies,
    ]
}

function stopLivePolling(): void {
    livePollGeneration++
    if (livePollTimer !== null) clearTimeout(livePollTimer)
    if (phasePollTimer !== null) clearTimeout(phasePollTimer)
    livePollTimer = null
    phasePollTimer = null
    isFinalizingSimulation.value = false
    chart.setZoomEnabled(true)
}

function pollPhaseSpace(resultId: string, generation: number): void {
    const poll = async () => {
        if (generation !== livePollGeneration || simulationStore.currentResultId !== resultId) return
        try {
            const ready = await simulationStore.loadPhaseSpaceWhenReady(resultId)
            if (ready) return
        } catch (error) {
            console.warn('[TrackViewer] Phase-space poll failed:', error)
        }
        phasePollTimer = setTimeout(poll, 1000)
    }
    void poll()
}

function startLivePolling(resultId: string): void {
    stopLivePolling()
    const generation = ++livePollGeneration
    liveBuffer.reset()
    chart.setZoomEnabled(false)

    let speciesKey = ''
    const poll = async () => {
        if (generation !== livePollGeneration || simulationStore.currentResultId !== resultId) return
        try {
            const species = selectedLiveSpecies()
            // A change to the monitored set adds/removes whole series; resync in
            // full so the buffer doesn't keep deltas against a stale selection.
            const key = [...species].sort().join('\n')
            if (key !== speciesKey) { liveBuffer.reset(); speciesKey = key }
            const delta = await simulationService.fetchLive(resultId, species, liveBuffer.cursor)
            if (generation !== livePollGeneration) return
            const snapshot = liveBuffer.ingest(delta)
            simulationStore.applyLiveSnapshot(snapshot)

            if (snapshot.status === 'running' || snapshot.status === 'paused'
                || snapshot.status === 'cancelling' || snapshot.status === 'finalizing') {
                chart.pushLiveSnapshot(snapshot)
                if (snapshot.current_time > 0) viewerStore.setTimepoint(snapshot.current_time)
                livePollTimer = setTimeout(poll, LIVE_POLL_INTERVAL_MS)
                return
            }

            chart.setZoomEnabled(true)
            chart.stopLiveStream()
            livePollTimer = null
            if (snapshot.status === 'completed' || snapshot.status === 'cancelled') {
                isFinalizingSimulation.value = true
                try {
                    void loadResults()
                    // Skip the sweep animation on the final full load: the data was
                    // just shown live, and a fresh animation whose axis range is
                    // yanked mid-flight by the fit/copy churn freezes partially
                    // drawn -- the artifact that only a real (animation-cancelling)
                    // zoom cleared.
                    await refreshSimulationData(undefined, true, false)
                } finally {
                    isFinalizingSimulation.value = false
                }
                pollPhaseSpace(resultId, generation)
            } else if (snapshot.error) {
                await loadResults()
                resultError.value = snapshot.error
            } else {
                await loadResults()
            }
        } catch (error) {
            if (generation !== livePollGeneration) return
            console.warn('[TrackViewer] Live poll failed:', error)
            livePollTimer = setTimeout(poll, 1000)
        }
    }

    void poll()
}

async function runSimulation() {
    chart.clearSimulationData()
    showPhaseSpace.value = false
    stopLivePolling()
    resultError.value = null
    try {
        const result = await simulationStore.runSimulation()
        await nextTick()
        syncVisibleTracks()
        await loadResults()
        startLivePolling(result.id)
    } catch (error) {
        resultError.value = error instanceof Error ? error.message : String(error)
    }
}

function pauseSimulation() {
    simulationStore.pauseSimulation()
}

// Watch for auto-run trigger from ScheduleEditor save
watch(() => simulationStore.pendingAutoRun, (pending) => {
    if (pending) {
        simulationStore.pendingAutoRun = false
        runSimulation()
    }
})

function resumeSimulation() {
    simulationStore.resumeSimulation()
}

function clearSimulation() {
    if (simulationStore.isSimulationRunning) {
        simulationStore.cancelSimulation()
    }
    stopLivePolling()
    chart.clearSimulationData()
    chart.hidePhaseSpace()
    showPhaseSpace.value = false
    simulationStore.clearResult()
    selectedTracks.value = []
}

// Path highlight sync: when hoveredExecutionPath changes (from any source),
// dim all panels to highlight just that path. null restores full opacity.
watch(
    () => viewerStore.hoveredExecutionPath,
    (path) => chart.highlightPath(path === null ? null : compatibleExecutionPaths(
        scheduleStore.segments.map(segment => segment.execution_path),
        path,
        scheduleStore.eachPrefixes,
    )),
)

// Gene highlight sync: when hoveredGeneId changes (from network hover),
// dim all panels to highlight just that gene. Composes with path highlight.
watch(
    () => viewerStore.hoveredGeneId,
    (gene) => chart.highlightGene(gene ?? null),
)

watch(
    () => viewerStore.hoveredTimeRange,
    (range) => chart.setScheduleBrush(range),
)

watch(
    () => selectedTracks.value,
    (newTracks) => {
        syncVisibleTracks()
        updateViewerStore()
    }
)

watch(countsLogScale, (enabled) => {
    chart.setCountsLogScale(enabled)
})

// Single watcher for all simulation data refresh triggers
// Fires when timeseries cache, gene selection, or path selection changes
// Skips during running simulation and during active fetch (avoids double render)
watch(
    () => ({ timeseries: simulationStore.timeseries, genes: viewerStore.selectedGenes, otherSpecies: viewerStore.selectedOtherSpecies, paths: viewerStore.selectedPaths, filteredPaths: viewerStore.filteredPaths }),
    ({ timeseries }) => {
        if (simulationStore.isSimulationRunning) return
        if (simulationStore.isFetchingTimeseries) return
        if (timeseries && scheduleStore.timeseriesMetadata) {
            refreshSimulationData()
        } else if (!timeseries) {
            chart.clearSimulationData()
        }
    },
    { deep: true }
)

// Sync time cursor with simulation progress (UI display only — not data streaming).
watch(
    () => simulationStore.currentResult,
    (result) => {
        if (!result || !simulationStore.isSimulationRunning) return

        // Sync time cursor with simulation progress
        if (result.current_time > 0) {
            viewerStore.setTimepoint(result.current_time)
        }
    },
    { deep: true }
)

defineExpose({
    exportSVG: () => chart.exportImage(),
    resize: requestChartResize,
    syncVisibleTracks,
})
</script>



<template>
    <div class="simulation-viewer">
        <div class="card-header">
            <div class="card-header-row">
                <div class="header-left">
                    <div class="results-control">
                        <Select
                            v-if="!simulationStore.isSimulationRunning || simulationStore.isPaused"
                            :model-value="simulationStore.currentResultId"
                            :options="results"
                            :disabled="isScheduleLoading"
                            option-value="id"
                            size="small"
                            placeholder="Load simulation result..."
                            @change="loadResult"
                            class="dropdown-small"
                            append-to="body"
                        >
                            <template #option="slotProps">
                                <div class="dropdown-option">{{ formatResultLabel(slotProps.option) }}</div>
                            </template>
                            <template #value="slotProps">
                                <div v-if="slotProps.value" class="dropdown-option">
                                    {{ formatResultLabel(results.find(r => r.id === slotProps.value)!) }}
                                </div>
                                <span v-else class="dropdown-option">Load simulation result...</span>
                            </template>
                            <template #empty>
                                <div class="dropdown-option">No available results</div>
                            </template>
                        </Select>

                        <InputText
                            v-if="simulationStore.isSimulationRunning && !simulationStore.isPaused"
                            :model-value="simulationStore.currentResultLabel"
                            disabled
                            size="small"
                            class="input-small"
                        />
                    </div>

                    <Button
                        v-if="!simulationStore.isSimulationRunning"
                        label="Run Simulation"
                        icon="pi pi-play-circle"
                        :disabled="isUiDisabled"
                        size="small"
                        severity="success"
                        @click="runSimulation"
                        class="run-simulation-btn"
                    />

                    <Button
                        v-if="!simulationStore.isSimulationRunning"
                        :icon="simulationStore.autoRunOnSave ? 'pi pi-bolt' : 'pi pi-bolt'"
                        :severity="simulationStore.autoRunOnSave ? 'primary' : 'secondary'"
                        :outlined="!simulationStore.autoRunOnSave"
                        size="small"
                        @click="simulationStore.autoRunOnSave = !simulationStore.autoRunOnSave"
                        v-grs-tooltip="simulationStore.autoRunOnSave ? 'Auto-run enabled: simulation will run on save' : 'Auto-run disabled: click to run simulation on save'"
                    />

                    <Button
                        v-if="simulationStore.isSimulationRunning && !simulationStore.isPaused"
                        icon="pi pi-pause"
                        size="small"
                        @click="pauseSimulation"
                        v-grs-tooltip="'Pause simulation'"
                    />
                    <Button
                        v-if="simulationStore.isSimulationRunning && simulationStore.isPaused"
                        icon="pi pi-play"
                        size="small"
                        severity="success"
                        @click="resumeSimulation"
                        v-grs-tooltip="'Resume simulation'"
                    />

                    <div v-if="simulationStore.isSimulationRunning" class="progress-wrapper">
                        <ProgressBar
                            :value="progressPercent"
                            :show-value="true"
                            style="height: 20px; width: 300px; font-size: 0.7rem"
                            class="progress-bar-red"
                        >
                            <!-- Bar width glides on the fine 0.1% value; keep the
                                 label a clean integer so it doesn't flicker. -->
                            <template #default>{{ progressLabel }}</template>
                        </ProgressBar>
                    </div>
                </div>

                <div v-if="hasSimulationContent" class="header-right">
                    <div class="filter-stack">
                        <div class="filter-row">
                            <Button
                                v-if="viewerStore.pathFilter !== ''"
                                icon="pi pi-times"
                                size="small"
                                text
                                severity="secondary"
                                @click="viewerStore.setPathFilter('')"
                                class="filter-clear-btn"
                                v-grs-tooltip="'Clear path filter'"
                            />
                        </div>
                    </div>

                    <div v-if="simulationStore.currentResultId" class="gene-selector-wrapper">
                        <MultiSelect
                            :model-value="combinedSelection"
                            @update:model-value="onCombinedSelectionChange"
                            :options="selectorOptionGroups"
                            option-label="label"
                            option-value="value"
                            option-group-label="group"
                            option-group-children="items"
                            :disabled="isScheduleLoading"
                            size="small"
                            placeholder="Filter genes/species..."
                            :max-selected-labels="3"
                            class="dropdown-small"
                            style="width: 620px; font-size: 0.75rem"
                            filter
                            :virtual-scroller-options="{ itemSize: 44 }"
                            :loading="simulationStore.isFetchingTimeseries"
                        >
                        <template #value="{ value }">
                            <div class="chip-container">
                                <span
                                    v-for="id in value"
                                    :key="id"
                                    class="custom-gene-chip"
                                    :style="selectorChipStyle(id)"
                                >
                                    {{ id }}
                                    <i 
                                        class="pi pi-times"
                                        @click.stop="removeCombinedSelection(id)"
                                        style="cursor: pointer; margin-left: 0.25rem; font-size: 0.6rem"
                                    />
                                </span>
                            </div>
                        </template>
                        <template #optiongroup="slotProps">
                            <div class="dropdown-option-group">{{ slotProps.option.group }}</div>
                        </template>
                        <template #option="slotProps">
                            <div style="font-size: 0.75rem; display: flex; align-items: center; gap: 0.5rem">
                                <span
                                    style="width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; border: 1px solid"
                                    :style="selectorSwatchStyle(slotProps.option.value)"
                                />
                                {{ slotProps.option.label }}
                            </div>
                        </template>
                    </MultiSelect>
                    </div>

                    <Button
                        v-if="simulationStore.currentResultId"
                        :icon="showPhaseSpace ? 'pi pi-chart-scatter' : 'pi pi-chart-scatter'"
                        :disabled="isScheduleLoading"
                        size="small"
                        text
                        :severity="showPhaseSpace ? 'secondary' : undefined"
                        @click="showPhaseSpace = !showPhaseSpace"
                        v-grs-tooltip="'Toggle phase space view'"
                    />

                    <Button
                        v-if="simulationStore.currentResultId"
                        icon="pi pi-sliders-v"
                        :disabled="isScheduleLoading"
                        size="small"
                        text
                        @click="(e) => trackSettingsPanel.toggle(e)"
                        v-grs-tooltip="'Track settings'"
                    />
                    <OverlayPanel ref="trackSettingsPanel" :show-close-button="false">
                        <div class="track-settings">
                            <h4>Display Tracks</h4>
                            <div class="track-checkbox-list">
                                <div v-for="option in trackOptions" :key="option.value" class="track-checkbox-item">
                                    <Checkbox
                                        :model-value="selectedTracks"
                                        :value="option.value"
                                        :disabled="selectedTracks.length === 1 && selectedTracks.includes(option.value)"
                                        @update:model-value="(val) => {
                                            if (val.length > 0) {
                                                selectedTracks = val
                                            }
                                        }"
                                    />
                                    <label style="margin-left: 0.5rem">{{ option.label }}</label>
                                </div>
                            </div>
                            <h4>Scale</h4>
                            <div class="track-checkbox-item">
                                <Checkbox v-model="countsLogScale" :binary="true" input-id="counts-log-scale" />
                                <label for="counts-log-scale" style="margin-left: 0.5rem">Log scale (counts)</label>
                            </div>
                        </div>
                    </OverlayPanel>

                    <Button
                        v-if="simulationStore.currentResultId"
                        icon="pi pi-times"
                        :disabled="isScheduleLoading"
                        size="small"
                        text
                        @click="clearSimulation"
                        v-grs-tooltip="'Clear loaded simulation'"
                    />

                </div>
            </div>
        </div>

        <div class="chart-wrapper">
            <div ref="containerRef" class="chart-container"></div>

            <ProgressSpinner
                v-if="simulationStore.isFetchingTimeseries || isFinalizingSimulation || isFinalizingResult"
                class="chart-fetch-spinner"
                style="width: 24px; height: 24px"
                stroke-width="4"
            />
            
            <PanelState
                v-if="!scheduleStore.isLoaded && !isScheduleLoading"
                kind="empty"
                variant="overlay"
                title="No schedule loaded"
                description="Load a schedule before running a simulation."
            />
            <PanelState
                v-else-if="resultError"
                kind="error"
                variant="overlay"
                title="Error loading result"
                :description="resultError"
            />
            <PanelState
                v-else-if="showSimulationEmptyState"
                kind="hint"
                variant="overlay"
                title="No simulation result loaded"
                description="Run this schedule or load a previous result to inspect trajectories."
            />
        </div>

        <!-- Single loading overlay - shows only the highest priority loading state -->
        <LoadingOverlay
            v-if="activeLoadingState"
            :label="activeLoadingState === 'schedule' ? 'Loading schedule...'
                : activeLoadingState === 'result' ? 'Loading result...'
                : 'Preparing simulation...'"
        />
    </div>
</template>

<style>
/* Global styles (not scoped) - for overlays appended to body */
.p-select-overlay,
.p-multiselect-overlay,
.p-overlaypanel,
.p-component-overlay,
[data-pc-section="root"][role="dialog"],
[data-pc-name="overlaypanel"] {
    z-index: 10000 !important;
}

</style>

<style scoped>
/* Component-specific layout */
.simulation-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: var(--p-surface-ground);
    overflow: hidden;
    position: relative;
}

.card-header-row {
    display: flex;
    gap: var(--spacing-sm);
    align-items: center;
    justify-content: space-between;
    min-height: 46px;
}

.card-header {
    background: var(--p-surface-ground);
    z-index: 100;
    position: relative;
    border-bottom: 1px solid color-mix(in srgb, var(--p-surface-border) 55%, transparent);
    padding: .42rem .75rem;
}

.header-left {
    display: flex;
    gap: var(--spacing-sm);
    align-items: center;
    min-width: 0;
}

.progress-wrapper {
    display: flex;
    align-items: center;
}

.progress-bar-red :deep(.p-progressbar-value) {
    background-color: v-bind('RED[400]');
    /* PrimeVue's theme animates the fill width with its own ~1s transition, which
       makes the bar visibly lag behind the (correct) numeric label even though both
       read the same `displayedProgress`. Kill it so the fill width *is* that value
       every frame -- the rAF tween already does the smoothing. */
    transition: none !important;
}

.header-right {
    display: flex;
    gap: var(--spacing-sm);
    align-items: center;
    min-width: 0;
}

.filter-stack {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.filter-row {
    display: flex;
    align-items: center;
    gap: 0;
}

.filter-autocomplete {
    font-size: 0.7rem;
}

:deep(.filter-autocomplete .p-autocomplete-input) {
    width: 150px;
    height: 1.5rem;
    font-size: 0.7rem;
    font-family: var(--font-family);
    padding: 0.15rem 0.4rem;
}

.filter-clear-btn {
    margin-left: -0.25rem;
    width: 1.25rem;
    height: 1.25rem;
}

.chart-wrapper {
    flex: 1;
    min-height: 0;
    width: 100%;
    position: relative;
    background:
        radial-gradient(circle at center, color-mix(in srgb, var(--p-primary-color) 3%, transparent), transparent 48%),
        var(--p-surface-ground);
}

.chart-container {
    flex: 1;
    min-width: 0;
    height: 100%;
}

.chart-fetch-spinner {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none;
    opacity: 0.6;
}

.results-control {
    display: flex;
    gap: var(--spacing-sm);
    align-items: center;
    flex: 1;
    margin-right: var(--spacing-xs);
    min-width: 220px;
}

/* Gene-specific chip styling (dynamic colors) */
.chip-container {
    display: flex;
    min-height: 26px;
    max-height: 26px;
    overflow-y: auto;
}

.custom-gene-chip {
    color: #3f3f46; /* GREY[700] */
    padding: var(--spacing-sm) var(--spacing-sm);
    border-radius: var(--border-radius-lg);
    font-size: var(--font-size-xs);
    border: 1px solid;
}

/* Smaller chips in track selector */
:deep(.dropdown-small.p-multiselect .p-chip) {
    padding: 0.25rem 0.5rem !important;
    margin: 0.25rem !important;
    font-size: 0.7rem !important;
}

/* Track settings panel styling */
.track-settings {
    min-width: 200px;
}

.track-settings h4 {
    margin: 0 0 0.75rem 0;
    font-size: 0.875rem;
    font-weight: normal;
}

.track-checkbox-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.track-checkbox-item {
    display: flex;
    align-items: center;
    font-size: 0.8rem;
}

:deep(.run-simulation-btn .p-button-label) {
    font-weight: 400 !important;
    font-family: inherit;
}


:deep(.run-simulation-btn) {
    background: v-bind('GREEN[500]');
    border-color: v-bind('GREEN[500]');
    color: #ffffff;
}
:deep(.run-simulation-btn:hover) {
    background: v-bind('GREEN[600]') !important;
    border-color: v-bind('GREEN[600]') !important;
}
:deep(.run-simulation-btn:active) {
    background: v-bind('GREEN[700]') !important;
    border-color: v-bind('GREEN[700]') !important;
}
</style>

<style>
/* Global styles for filter overlay (appended to body, outside scoped CSS). */
.filter-overlay .p-autocomplete-option {
    font-size: 0.7rem;
    font-family: monospace;
    padding: 0.25rem 0.5rem;
}

.filter-overlay .p-autocomplete-empty-message {
    font-size: 0.7rem;
    padding: 0.25rem 0.5rem;
    color: var(--p-text-muted-color);
}
</style>
