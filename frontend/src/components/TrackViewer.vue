<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useSimulationStore } from '@/stores/simulationStore'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useViewerStore } from '@/stores/viewerStore'
import type { SimulationResult } from '@/types/simulation'
import { formatResultLabel } from '@/types/simulation'
import { speciesTypeLabels, DEFAULT_VISIBLE_SPECIES_TYPES, GENE_SPECIES_TYPES } from '@/types/schedule'
import type { SpeciesType } from '@/types/schedule'
import Button from 'primevue/button'
import Select, { type SelectChangeEvent } from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import InputText from 'primevue/inputtext'
import AutoComplete, { type AutoCompleteCompleteEvent } from 'primevue/autocomplete'
import ProgressSpinner from 'primevue/progressspinner'
import ProgressBar from 'primevue/progressbar'
import OverlayPanel from 'primevue/overlaypanel'
import Checkbox from 'primevue/checkbox'
import * as simulationService from '@/services/simulationService'
import { MainChart } from '@/charts/MainChart'
import { useStreamingController } from '@/composables/useStreamingController'
import { useTheme } from '@/composables/useTheme'
import { buildClientPhaseSpace, recolourPhaseSpace } from '@/charts/phaseSpaceBuilder'
import { GREEN, RED } from '@/config/theme'
import { contrastTextColour } from '@/utils/colorUtils'
import type { TimeseriesData } from '@/types/simulation'
import { extractPaths, extractChannels, matchesPathPrefix } from '@/types/schedule'

const simulationStore = useSimulationStore()
const scheduleStore = useScheduleStore()
const viewerStore = useViewerStore()
const { isDark, onThemeChange } = useTheme()

const DEFAULT_SELECTED_GENES_COUNT = 5

const containerRef = ref<HTMLDivElement>()
const results = ref<SimulationResult[]>([])
const isFullscreen = ref<boolean>(false)
const selectedTracks = ref<string[]>([])
/** Stashed track selection preserved across simulation reload blips. */
let previousTrackSelection: string[] | null = null
const trackSettingsPanel = ref()
const previousGeneSelection = ref<string[] | null>(null)
const showPhaseSpace = ref(false)
const pathSuggestions = ref<string[]>([])
const channelSuggestions = ref<string[]>([])

const chart = new MainChart()
const streaming = useStreamingController(chart)

const OTHER_SPECIES_COLOUR = '#9e9e9e'

const isScheduleLoading = computed(() => scheduleStore.isLoading)
const isSimulationBusy = computed(() => simulationStore.isSimulationRunning || simulationStore.isLoadingResult)
const isUiDisabled = computed(() => isScheduleLoading.value || isSimulationBusy.value)

/** Progress percentage for the progress bar (0-100). */
const progressPercent = computed(() => Math.round(simulationStore.progress * 100))

/** True when timeseries has never been loaded (first fetch needs a full overlay). */
const isFirstTimeseriesFetch = computed(() =>
    simulationStore.isFetchingTimeseries && simulationStore.fetchedGenes.size === 0
)

/** Error message shown as overlay when a result fails to load. */
const resultError = ref<string | null>(null)

/** Determine which loading overlay to show with priority (only one shown at a time). */
const activeLoadingState = computed(() => {
    // Priority order: schedule > timeseries > result > preparing
    if (isScheduleLoading.value) return 'schedule'
    if (isFirstTimeseriesFetch.value) return 'timeseries'
    if (simulationStore.isLoadingResult) return 'result'
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
    
    // Only include schedule if loaded
    if (scheduleStore.isLoaded) {
        options.push({ label: 'Schedule Timeline', value: 'schedule' })
    }
    
    // Only include species types if simulation loaded
    if (simulationStore.isLoaded) {
        GENE_SPECIES_TYPES.forEach(type => {
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
        
        if (state.scheduleLoaded) {
            validTracks.push('schedule')
        }
        
        if (state.simulationLoaded) {
            GENE_SPECIES_TYPES.forEach(type => validTracks.push(type))
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
                if (restored.some(t => t !== 'schedule')) {
                    selectedTracks.value = restored
                    return
                }
            }
            const hasSimulationTracks = selectedTracks.value.some(t => t !== 'schedule')
            if (!hasSimulationTracks) {
                const defaults: string[] = []
                if (state.scheduleLoaded) {
                    defaults.push('schedule')
                }
                defaults.push(...DEFAULT_VISIBLE_SPECIES_TYPES)
                selectedTracks.value = defaults
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

watch(
    () => activePhaseSpaceResult.value !== null,
    (available) => {
        if (available) showPhaseSpace.value = true
    }
)

// When showPhaseSpace toggles (button or auto-set), show/hide in MainChart
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
    () => ({ structure: scheduleStore.schedule.data?.structure, segments: viewerStore.filteredSegments, metadata: scheduleStore.timeseriesMetadata, maxPaths: viewerStore.maxTimelinePaths }),
    async ({ structure, segments, metadata, maxPaths }) => {
        if (structure && segments && segments.length > 0 && metadata) {
            // Stale-closure guard: ignore if schedule changed mid-flight
            const specAtStart = scheduleStore.schedule.spec
            console.debug(`[TrackViewer] Schedule data ready: ${segments.length} segments (filter="${viewerStore.pathFilter}")`)
            chart.setScheduleData(structure, segments, metadata, maxPaths)

            // Fire network fetch without blocking (chart already rendered)
            scheduleStore.fetchUnionNetwork().catch(e => {
                console.error('[TrackViewer] Failed to fetch union network:', e)
            })

            // Only refresh if schedule hasn't changed during the above
            if (scheduleStore.schedule.spec === specAtStart) {
                refreshSimulationData()
            }
        }
    }
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

        // During streaming, only update WS subscription (HTTP fetch deferred to completion)
        if (simulationStore.isSimulationRunning) {
            simulationStore.updateStreamSubscription(capped, viewerStore.selectedOtherSpecies)
            return
        }

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

        if (simulationStore.isSimulationRunning) {
            const capped = viewerStore.selectedGenes.slice(0, viewerStore.maxRenderedGenes)
            simulationStore.updateStreamSubscription(capped, species)
            return
        }

        await simulationStore.fetchOtherSpeciesTimeseries(species)
        refreshSimulationData()
    },
    { deep: true }
)

/** Push current simulation data to chart, filtered by selected genes/paths. */
function refreshSimulationData(): void {
    if (!simulationStore.isLoaded || simulationStore.isSimulationRunning) return
    const genes = viewerStore.selectedGenes.slice(0, viewerStore.maxRenderedGenes)
    if (genes.length === 0 && viewerStore.selectedOtherSpecies.length === 0) return
    const paths = viewerStore.selectedPaths ?? viewerStore.filteredPaths
    const pathArray = paths ? [...paths] : null
    const visibleData = simulationStore.getTimeseries(genes, pathArray, viewerStore.selectedOtherSpecies)
    if (visibleData) {
        chart.setSimulationData(visibleData)
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

/** Compute autocomplete suggestions for the path filter input. */
function searchPathSuggestions(event: AutoCompleteCompleteEvent): void {
    const query = event.query
    const allPaths = extractPaths(scheduleStore.segments)
    // Show paths that the query is a prefix of (the query matches the path)
    // plus the root "" which always matches
    pathSuggestions.value = allPaths.filter(p => matchesPathPrefix(p, query) || p === query)
}

/** Compute autocomplete suggestions for the channel filter input. */
function searchChannelSuggestions(event: AutoCompleteCompleteEvent): void {
    const query = event.query.toLowerCase()
    const allChannels = extractChannels(scheduleStore.segments)
    channelSuggestions.value = allChannels.filter(c => c.toLowerCase().includes(query))
}

function updateViewerStore() {
    viewerStore.selectedSpeciesTypes = selectedTracks.value.filter(t => t !== 'schedule') as SpeciesType[]
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
    const structure = scheduleStore.schedule.data?.structure
    const segments = viewerStore.filteredSegments
    const metadata = scheduleStore.timeseriesMetadata
    if (structure && segments.length > 0 && metadata) {
        console.debug(`[TrackViewer] Hydrating chart from persisted state: ${segments.length} segments`)
        chart.setScheduleData(structure, segments, metadata, viewerStore.maxTimelinePaths)
        scheduleStore.fetchUnionNetwork().catch(e => {
            console.error('[TrackViewer] Failed to fetch union network:', e)
        })
    }
}


onMounted(async () => {
    loadResults()
    const themeAtStart = isDark.value
    await chart.init(containerRef, themeAtStart)
    chart.setVisibleTracks(['schedule'])
    onThemeChange((dark) => chart.applyTheme(dark))
    // Reconcile only if the theme actually changed during async init
    if (isDark.value !== themeAtStart) {
        chart.applyTheme(isDark.value)
    }

    chart.onTimepointChange((timepoint: number) => {
        viewerStore.setTimepoint(timepoint)
    })

    chart.onSelectionChange((selectedGenes: string[]) => {
        // Skip deselect when this fires in the same event as a segment click
        if (skipSegmentDeselect) {
            skipSegmentDeselect = false
        } else if (viewerStore.selectedSegmentIds) {
            chart.deselectSegment()
            viewerStore.selectSegments(null)
        }
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

    /**
     * Flag to prevent onSelectionChange from immediately deselecting a segment
     * that was just selected in onSegmentClick (both fire in the same event tick).
     */
    let skipSegmentDeselect = false

    chart.onSegmentClick(async (segmentId: number, _modelPath: string) => {
        if (segmentId < 0) {
            // Deselect: segmentId = -1 signals deselection from TimelinePanel
            console.debug('[TrackViewer] Segment deselected')
            viewerStore.selectSegments(null)
            return
        }
        skipSegmentDeselect = true
        console.debug(`[TrackViewer] Segment click: id=${segmentId}`)
        viewerStore.selectSegments(new Set([segmentId]))
    })

    chart.onHoverChange((modelPath: string | null, executionPath: string | null) => {
        viewerStore.setHoveredRectModel(modelPath, executionPath)
    })

    chart.onInstantHoverChange((modelPath: string | null) => {
        viewerStore.setHoveredInstantModel(modelPath)
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

    // Timeseries panel gene hover -> store (bidirectional sync with network)
    chart.onTimeseriesGeneHover((gene: string | null) => {
        viewerStore.setHoveredGene(gene)
    })

    // Double-click on timeline rectangle -> drill into that execution path
    chart.onDrillIn((executionPath: string) => {
        console.debug(`[TrackViewer] Drill-in: path="${executionPath}"`)
        viewerStore.setPathFilter(executionPath)
    })

    window.addEventListener('keydown', handleEscapeKey)

    // Hydrate chart from persisted store state (dev-mode Pinia persistence).
    // Watchers fired before chart.init() completed, so push any available data now.
    _hydrateFromPersistedState()
})

onBeforeUnmount(() => {
    streaming.dispose()
    chart.dispose()
    window.removeEventListener('keydown', handleEscapeKey)
})

async function loadResult(event: SelectChangeEvent) {
    const selectedResultId = event.value
    // Cancel running simulation if switching results while paused
    if (simulationStore.isSimulationRunning) {
        simulationStore.cancelSimulation()
    }
    streaming.stop()
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
        refreshSimulationData()
    }
}

async function runSimulation() {
    chart.clearSimulationData()
    showPhaseSpace.value = false
    streaming.stop()
    streaming.start()
    // runSimulation returns immediately (async server-side), then WS streams data
    simulationStore.runSimulation().then(() => loadResults())
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
    streaming.stop()
    chart.clearSimulationData()
    chart.hidePhaseSpace()
    showPhaseSpace.value = false
    simulationStore.clearResult()
    selectedTracks.value = scheduleStore.isLoaded ? ['schedule'] : []
}

function toggleFullscreen() {
    isFullscreen.value = !isFullscreen.value
}

function handleEscapeKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
        // Deselect segment selection first (also zooms back to full extent)
        if (viewerStore.selectedSegmentIds) {
            chart.deselectSegment()
            viewerStore.selectSegments(null)
            return
        }
        if (previousGeneSelection.value) {
            viewerStore.selectedGenes = previousGeneSelection.value
            previousGeneSelection.value = null
            return
        }
        if (isFullscreen.value) {
            isFullscreen.value = false
        }
    }
}

// Path highlight sync: when hoveredExecutionPath changes (from any source),
// dim all panels to highlight just that path. null restores full opacity.
watch(
    () => viewerStore.hoveredExecutionPath,
    (path) => chart.highlightPath(path ?? null),
)

// Gene highlight sync: when hoveredGeneId changes (from network hover),
// dim all panels to highlight just that gene. Composes with path highlight.
watch(
    () => viewerStore.hoveredGeneId,
    (gene) => chart.highlightGene(gene ?? null),
)

watch(
    () => selectedTracks.value,
    (newTracks) => {
        chart.setVisibleTracks(newTracks)
        updateViewerStore()
    }
)

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
})
</script>



<template>
    <Teleport to="#app" :disabled="!isFullscreen">
        <div class="simulation-viewer" :class="{ 'fullscreen-mode': isFullscreen }">
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
                        />
                    </div>
                </div>

                <div class="header-right">
                    <div class="filter-stack">
                        <div class="filter-row">
                            <AutoComplete
                                :model-value="viewerStore.pathFilter"
                                @update:model-value="(v: string | undefined) => viewerStore.setPathFilter(v ?? '')"
                                :suggestions="pathSuggestions"
                                @complete="searchPathSuggestions"
                                :complete-on-focus="true"
                                size="small"
                                placeholder="Path filter..."
                                class="filter-autocomplete"
                                input-class="filter-input"
                                append-to="body"
                                empty-search-message="Type to filter paths"
                                panel-class="filter-overlay"
                            />
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
                        <div class="filter-row">
                            <AutoComplete
                                :model-value="viewerStore.channelFilter"
                                @update:model-value="(v: string | undefined) => viewerStore.setChannelFilter(v ?? '')"
                                :suggestions="channelSuggestions"
                                @complete="searchChannelSuggestions"
                                :complete-on-focus="true"
                                size="small"
                                placeholder="Channel filter..."
                                class="filter-autocomplete"
                                input-class="filter-input"
                                append-to="body"
                                empty-search-message="No channels in schedule"
                                panel-class="filter-overlay"
                            />
                            <Button
                                v-if="viewerStore.channelFilter !== ''"
                                icon="pi pi-times"
                                size="small"
                                text
                                severity="secondary"
                                @click="viewerStore.setChannelFilter('')"
                                class="filter-clear-btn"
                                v-grs-tooltip="'Clear channel filter'"
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

                    <Button
                        :icon="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
                        v-grs-tooltip="isFullscreen ? 'Exit fullscreen (ESC)' : 'Enter fullscreen'"
                        size="small"
                        text
                        @click="toggleFullscreen"
                    />
                </div>
            </div>
        </div>

        <div class="chart-wrapper">
            <div ref="containerRef" class="chart-container"></div>

            <ProgressSpinner
                v-if="simulationStore.isFetchingTimeseries && !isFirstTimeseriesFetch"
                class="chart-fetch-spinner"
                style="width: 24px; height: 24px"
                stroke-width="4"
            />
            
            <div 
                v-if="!scheduleStore.isLoaded && !isScheduleLoading"
                class="chart-overlay"
            >
                <div class="overlay-text">No schedule is loaded</div>
            </div>
            <div v-if="resultError" class="chart-overlay">
                <div class="overlay-text">Error loading result</div>
            </div>
        </div>

        <!-- Single loading overlay - shows only the highest priority loading state -->
        <div v-if="activeLoadingState" class="loading-overlay">
            <div class="loading-card">
                <ProgressSpinner style="width: 50px; height: 50px" stroke-width="3" />
                <div class="loading-text">
                    <span v-if="activeLoadingState === 'schedule'">Loading schedule...</span>
                    <span v-else-if="activeLoadingState === 'timeseries'">Loading timeseries...</span>
                    <span v-else-if="activeLoadingState === 'result'">Loading result...</span>
                    <span v-else-if="activeLoadingState === 'preparing'">Preparing simulation...</span>
                </div>
            </div>
        </div>
        </div>
    </Teleport>
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

/* Fullscreen header colours: CSS vars don't resolve after teleport, use Aura palette values */
.simulation-viewer.fullscreen-mode .card-header {
    background: #f8fafc; /* Aura slate.50 = surface-ground light */
}
.app-dark .simulation-viewer.fullscreen-mode .card-header {
    background: #09090b; /* Aura zinc.950 = surface-ground dark */
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
    gap: var(--spacing-md);
    align-items: center;
    justify-content: space-between;
}

.card-header {
    background: var(--p-surface-ground);
    z-index: 100;
    position: relative;
}

.header-left {
    display: flex;
    gap: var(--spacing-md);
    align-items: center;
}

.progress-wrapper {
    display: flex;
    align-items: center;
}

.progress-bar-red :deep(.p-progressbar-value) {
    background-color: v-bind('RED[400]');
}

.header-right {
    display: flex;
    gap: var(--spacing-md);
    align-items: center;
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
    gap: var(--spacing-md);
    align-items: center;
    flex: 1;
    margin-right: var(--spacing-1xl);
}

/* Domain-specific overlay */
.chart-overlay {
    position: absolute;
    inset: 0;
    background: var(--p-overlay-ground);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
}

.overlay-text {
    font-size: var(--font-size-xl);
    color: var(--p-text-color-secondary);
}

/* Fullscreen mode */
.simulation-viewer.fullscreen-mode {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: 9999;
    border-radius: 0;
    background: var(--p-surface-ground);
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
