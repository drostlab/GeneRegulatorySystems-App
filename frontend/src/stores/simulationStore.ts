import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useScheduleStore } from './scheduleStore'
import { useViewerStore } from './viewerStore'
import type { SimulationResult, TimeseriesData, PhaseSpaceResult } from '@/types/simulation'
import { formatResultLabel, getProgress } from '@/types/simulation'
import { getTimeExtent } from '@/types/schedule'
import * as simulationService from '@/services/simulationService'
import { getSimulationStream } from '@/composables/useSimulationStream'

const DEFAULT_STREAM_GENE_COUNT = 5

/**
 * Simulation Store -- manages simulation results with lazy per-gene timeseries loading
 * and live WebSocket streaming during runs.
 *
 * Architecture:
 * - `loadResult(id)` loads metadata only (no timeseries)
 * - `fetchGeneTimeseries(genes)` fetches species for those genes via HTTP
 * - `runSimulation()` starts async simulation, receives progress + timeseries via WS
 * - `pauseSimulation()` / `resumeSimulation()` control running simulation
 * - `progress` computed gives 0-1 fraction from current_time / max_time
 */
export const useSimulationStore = defineStore(
    'simulation',
    () => {
        // =====================================================================
        // STATE
        // =====================================================================

        const currentResult = ref<SimulationResult | null>(null)
        const isSimulationRunning = ref(false)
        const isPaused = ref(false)
        const isLoadingResult = ref(false)

        /** When true, saving a schedule automatically triggers a simulation run. */
        const autoRunOnSave = ref(false)

        /** Set by ScheduleEditor after save; consumed by TrackViewer to trigger run with chart cleanup. */
        const pendingAutoRun = ref(false)

        /** True between clicking Run and receiving the first streaming frame. */
        const isPreparingSimulation = ref(false)

        /** Accumulated timeseries data, merged across per-gene fetches and streaming. */
        const timeseriesCache = ref<TimeseriesData>({})

        /** Set of genes already fetched (avoids duplicate HTTP requests). */
        const fetchedGenes = ref<Set<string>>(new Set())

        /** Set of other species already fetched (avoids duplicate HTTP requests). */
        const fetchedOtherSpecies = ref<Set<string>>(new Set())

        /** Currently in-flight gene fetch (prevents concurrent fetches). */
        const isFetchingTimeseries = ref(false)

        /** Latest streaming delta from WS (consumed by TrackViewer for appendStreamingData). */
        const streamingDelta = ref<TimeseriesData | null>(null)

        /** Phase-space embedding result, available once server has finished computing it. */
        const phaseSpaceResult = ref<PhaseSpaceResult | null>(null)

        /** True while the server is computing the phase-space embedding post-simulation. */
        const isPhaseSpacePending = ref(false)

        // =====================================================================
        // COMPUTED
        // =====================================================================

        const currentResultId = computed(() => currentResult.value?.id ?? null)

        const currentResultLabel = computed(() => formatResultLabel(currentResult.value))

        const isLoaded = computed(() => currentResult.value !== null)

        const isPhaseSpaceAvailable = computed(() => phaseSpaceResult.value !== null)

        const progress = computed((): number => {
            if (!currentResult.value) return 0
            return getProgress(currentResult.value)
        })

        const timeseries = computed((): TimeseriesData | null => {
            if (!currentResult.value) return null
            return Object.keys(timeseriesCache.value).length > 0 ? timeseriesCache.value : null
        })

        // =====================================================================
        // FETCHING
        // =====================================================================

        async function fetchGeneTimeseries(genes: string[]): Promise<void> {
            const resultId = currentResultId.value
            if (!resultId) return

            const scheduleStore = useScheduleStore()
            const newGenes = genes.filter(g => !fetchedGenes.value.has(g))
            if (newGenes.length === 0) {
                return
            }

            const species = newGenes.flatMap(gene => scheduleStore.getSpeciesForGeneId(gene))
            if (species.length === 0) {
                newGenes.forEach(g => fetchedGenes.value.add(g))
                return
            }

            // Mark genes as fetched immediately to prevent duplicate concurrent requests
            newGenes.forEach(g => fetchedGenes.value.add(g))

            isFetchingTimeseries.value = true
            try {
                const data = await simulationService.fetchTimeseriesForSpecies(resultId, species)
                _mergeTimeseries(data)
            } catch (e) {
                // Rollback: remove genes from fetched set so they can be retried
                newGenes.forEach(g => fetchedGenes.value.delete(g))
                throw e
            } finally {
                isFetchingTimeseries.value = false
            }
        }

        /** Fetch timeseries for non-gene species (e.g. dimer products) by direct name. */
        async function fetchOtherSpeciesTimeseries(speciesNames: string[]): Promise<void> {
            const resultId = currentResultId.value
            if (!resultId) return

            const newSpecies = speciesNames.filter(s => !fetchedOtherSpecies.value.has(s))
            if (newSpecies.length === 0) return

            newSpecies.forEach(s => fetchedOtherSpecies.value.add(s))

            isFetchingTimeseries.value = true
            try {
                const data = await simulationService.fetchTimeseriesForSpecies(resultId, newSpecies)
                _mergeTimeseries(data)
            } catch (e) {
                newSpecies.forEach(s => fetchedOtherSpecies.value.delete(s))
                throw e
            } finally {
                isFetchingTimeseries.value = false
            }
        }

        /**
         * Get timeseries filtered by genes (+ optional other species) and paths.
         * Returns data from cache only -- call fetchGeneTimeseries / fetchOtherSpeciesTimeseries first.
         */
        function getTimeseries(genes?: string[] | null, paths?: string[] | null, otherSpecies?: string[] | null) {
            if (!timeseries.value) return null

            const scheduleStore = useScheduleStore()

            if (genes !== null && genes !== undefined && genes.length === 0
                && (otherSpecies === null || otherSpecies === undefined || otherSpecies.length === 0)) return {}
            if (paths !== null && paths !== undefined && paths.length === 0) return {}

            const speciesIds = new Set(
                genes === null || genes === undefined
                    ? Object.keys(timeseries.value)
                    : genes.flatMap(gene => scheduleStore.getSpeciesForGeneId(gene))
            )

            // Include other species (direct names) in the filter set
            if (otherSpecies) {
                for (const s of otherSpecies) speciesIds.add(s)
            }

            const pathSet = paths === null || paths === undefined
                ? null
                : new Set(paths)

            return Object.fromEntries(
                Object.entries(timeseries.value)
                    .filter(([species]) => speciesIds.has(species))
                    .map(([species, pathData]) => [
                        species,
                        Object.fromEntries(
                            Object.entries(pathData)
                                .filter(([path]) => pathSet === null || pathSet.has(path))
                        )
                    ])
            ) as TimeseriesData
        }

        /**
         * Fetch screen-resolution data for a finished result via the server pyramid.
         * View-scoped (not merged into the cache): returns ≲2·width_px points per
         * (species, path) for the window [t0, t1]. Resolves species from gene ids +
         * direct other-species names.
         */
        async function fetchViewport(
            genes: string[],
            otherSpecies: string[],
            paths: string[] | null,
            t0: number,
            t1: number,
            widthPx: number,
        ): Promise<TimeseriesData | null> {
            const resultId = currentResultId.value
            if (!resultId) return null
            const scheduleStore = useScheduleStore()
            const species = [
                ...genes.flatMap(g => scheduleStore.getSpeciesForGeneId(g)),
                ...otherSpecies,
            ]
            if (species.length === 0) return {}
            return simulationService.fetchViewport(resultId, {
                species, paths, t0, t1, width_px: widthPx,
            })
        }

        // =====================================================================
        // STREAMING (WS)
        // =====================================================================

        function _onProgress(currentTime: number, frameCount: number, totalProgress: number | null): void {
            if (!currentResult.value) {
                console.warn('[SimulationStore] _onProgress called but no currentResult')
                return
            }
            isPreparingSimulation.value = false
            currentResult.value = {
                ...currentResult.value,
                current_time: currentTime,
                frame_count: frameCount,
                total_progress: totalProgress,
            }
        }

        function _onTimeseries(data: TimeseriesData): void {
            // During streaming, skip merging into timeseriesCache — the cache is
            // cleared on completion and re-fetched via HTTP. Only forward the
            // delta so TrackViewer can push it to SciChart.
            streamingDelta.value = data
        }

        function _onStatus(status: string, error?: string): void {
            console.debug(`[SimulationStore] _onStatus: status=${status} error=${error ?? 'none'} hasResult=${!!currentResult.value}`)
            if (!currentResult.value) return
            isPreparingSimulation.value = false
            currentResult.value = {
                ...currentResult.value,
                status: status as SimulationResult['status'],
                ...(error ? { error } : {}),
            }
            if (status === 'completed' || status === 'error') {
                isSimulationRunning.value = false
                isPaused.value = false

                // Register phase-space callback BEFORE untrack() so the WS connection is still open
                if (status === 'completed') {
                    const simId = currentResult.value.id
                    isPhaseSpacePending.value = true
                    getSimulationStream().trackPhaseSpace(simId, (id) => { _onPhaseSpaceReady(id) })
                }

                getSimulationStream().untrack()

                // Refetch definitive timeseries from server (replaces streaming cache)
                if (status === 'completed') {
                    clearTimeseriesCache()
                    const scheduleStore = useScheduleStore()
                    const viewerStore = useViewerStore()
                    const genes = viewerStore.selectedGenes.length > 0
                        ? viewerStore.selectedGenes
                        : (scheduleStore.allGenes ?? []).slice(0, DEFAULT_STREAM_GENE_COUNT)
                    if (genes.length > 0) {
                        fetchGeneTimeseries(genes)
                    }
                    const otherSpecies = viewerStore.selectedOtherSpecies
                    if (otherSpecies.length > 0) {
                        fetchOtherSpeciesTimeseries(otherSpecies)
                    }
                }
            }
            if (status === 'paused') {
                isPaused.value = true
            }
            if (status === 'running') {
                isPaused.value = false
            }
        }

        async function _onPhaseSpaceReady(simId: string): Promise<void> {
            const data = await simulationService.fetchPhaseSpace(simId)
            phaseSpaceResult.value = data
            isPhaseSpacePending.value = false
            getSimulationStream().clearPhaseSpaceTracking()
            console.debug(`[SimulationStore] Phase space loaded: ${data?.n_cells ?? 0} cells, method=${data?.method ?? 'n/a'}`)
        }

        /** Update the set of species streamed via WS based on selected genes + other species. */
        function updateStreamSubscription(genes: string[], otherSpecies: string[] = []): void {
            if (!isSimulationRunning.value) return
            const scheduleStore = useScheduleStore()
            const species = [
                ...genes.flatMap(gene => scheduleStore.getSpeciesForGeneId(gene)),
                ...otherSpecies,
            ]
            getSimulationStream().subscribe(species)
        }

        // =====================================================================
        // ACTIONS
        // =====================================================================

        async function loadResult(resultId: string): Promise<void> {
            isLoadingResult.value = true
            try {
                clearTimeseriesCache()
                phaseSpaceResult.value = null
                isPhaseSpacePending.value = false
                const result = await simulationService.loadResult(resultId)
                currentResult.value = result

                const scheduleStore = useScheduleStore()
                await scheduleStore.loadScheduleBySpec(result.schedule_spec, result.schedule_name)

                // When the schedule was already loaded (same spec), allGenes doesn't change
                // so the selectedGenes watcher never fires and fetchGeneTimeseries is never called.
                // Trigger it unconditionally here; fetchGeneTimeseries deduplicates by fetchedGenes set.
                const genes = scheduleStore.allGenes ?? []
                if (genes.length > 0) {
                    try {
                        await fetchGeneTimeseries(genes.slice(0, DEFAULT_STREAM_GENE_COUNT))
                    } catch (e) {
                        console.warn('[SimulationStore] Failed to load timeseries for result:', e)
                        throw e
                    }
                }

                // Try to load a pre-computed phase-space embedding (best-effort).
                simulationService.fetchPhaseSpace(resultId).then(ps => {
                    phaseSpaceResult.value = ps
                    console.debug(`[SimulationStore] Phase space for loaded result: ${ps ? ps.n_cells + ' cells' : 'not available'}`)
                }).catch(e => {
                    console.warn('[SimulationStore] fetchPhaseSpace failed:', e)
                })
            } finally {
                isLoadingResult.value = false
            }
        }

        async function runSimulation(): Promise<SimulationResult> {
            const scheduleStore = useScheduleStore()
            if (!scheduleStore.schedule) throw new Error('No running schedule selected')
            if (isSimulationRunning.value) throw new Error('Simulation already running')

            clearTimeseriesCache()
            currentResult.value = null
            isSimulationRunning.value = true
            isPreparingSimulation.value = true
            isPaused.value = false

            // Connect WS before starting (await ensures backend has ws_client)
            const stream = getSimulationStream()
            await stream.connect()

            // Compute initial species to subscribe server-side so streaming starts
            // with the first episode -- uses current selection to preserve user choices.
            const viewerStore = useViewerStore()
            const selectedGenes = viewerStore.selectedGenes.length > 0
                ? viewerStore.selectedGenes.slice(0, DEFAULT_STREAM_GENE_COUNT)
                : (scheduleStore.allGenes ?? []).slice(0, DEFAULT_STREAM_GENE_COUNT)
            const selectedOther = viewerStore.selectedOtherSpecies
            const initialSpecies = [
                ...selectedGenes.flatMap(g => scheduleStore.getSpeciesForGeneId(g)),
                ...selectedOther,
            ]

            const result = await simulationService.runSimulation(
                scheduleStore.schedule.name,
                scheduleStore.schedule.spec,
                getTimeExtent(scheduleStore.segments).max,
                initialSpecies,
            )
            currentResult.value = result
            console.debug(`[SimulationStore] runSimulation: got result id=${result.id} status=${result.status}`)

            // Track this simulation via WS
            stream.track(result.id, {
                onProgress: _onProgress,
                onTimeseries: _onTimeseries,
                onStatus: _onStatus,
            })

            // Subscribe selected genes for live streaming (WS subscription complements
            // the server-side initial subscription from the run request)
            if (selectedGenes.length > 0) {
                updateStreamSubscription(selectedGenes, selectedOther)
            }

            // Catch fast-simulation race: if the simulation completed before track() was
            // called, all WS messages were dropped. Poll once to get the current state.
            const polledResult = await simulationService.loadResult(result.id)
            currentResult.value = polledResult
            if (polledResult.status === 'completed' || polledResult.status === 'error') {
                console.debug(`[SimulationStore] Fast-simulation detected: already ${polledResult.status} before track()`)
                _onStatus(polledResult.status, polledResult.error ?? undefined)
            } else {
                isPreparingSimulation.value = false
            }

            return polledResult
        }

        function pauseSimulation(): void {
            getSimulationStream().pause()
            isPaused.value = true
        }

        function resumeSimulation(): void {
            getSimulationStream().resume()
            isPaused.value = false
        }

        /** Cancel a running/paused simulation: pause it server-side and clean up. */
        function cancelSimulation(): void {
            if (isSimulationRunning.value) {
                getSimulationStream().pause()
                getSimulationStream().untrack()
            }
            isSimulationRunning.value = false
            isPaused.value = false
            isPreparingSimulation.value = false
            clearTimeseriesCache()
            currentResult.value = null
        }

        function clearTimeseriesCache(): void {
            timeseriesCache.value = {}
            fetchedGenes.value = new Set()
            fetchedOtherSpecies.value = new Set()
            streamingDelta.value = null
        }

        function clearResult(): void {
            currentResult.value = null
            isSimulationRunning.value = false
            isPaused.value = false
            isPreparingSimulation.value = false
            phaseSpaceResult.value = null
            isPhaseSpacePending.value = false
            clearTimeseriesCache()
        }

        // =====================================================================
        // HELPERS
        // =====================================================================

        function _mergeTimeseries(data: TimeseriesData): void {
            const cache = timeseriesCache.value
            for (const [speciesName, pathData] of Object.entries(data)) {
                if (!cache[speciesName]) {
                    cache[speciesName] = pathData
                } else {
                    const existing = cache[speciesName]!
                    for (const [path, points] of Object.entries(pathData)) {
                        if (!existing[path]) {
                            existing[path] = points
                        } else {
                            existing[path]!.push(...points)
                        }
                    }
                }
            }
            // Trigger reactivity with shallow replace
            timeseriesCache.value = { ...cache }
        }

        return {
            currentResult,
            isSimulationRunning,
            isPaused,
            isLoadingResult,
            isFetchingTimeseries,
            isPreparingSimulation,
            phaseSpaceResult,
            isPhaseSpacePending,
            isPhaseSpaceAvailable,
            currentResultId,
            currentResultLabel,
            isLoaded,
            progress,
            timeseries,
            streamingDelta,
            fetchedGenes,
            getTimeseries,
            fetchViewport,
            fetchGeneTimeseries,
            fetchOtherSpeciesTimeseries,
            autoRunOnSave,
            pendingAutoRun,
            runSimulation,
            loadResult,
            pauseSimulation,
            resumeSimulation,
            cancelSimulation,
            updateStreamSubscription,
            clearResult,
        }
    }
)
