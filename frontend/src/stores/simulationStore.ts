import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useScheduleStore } from './scheduleStore'
import type { SimulationResult, TimeseriesData, PhaseSpaceResult } from '@/types/simulation'
import { formatResultLabel, getProgress } from '@/types/simulation'
import { getTimeExtent } from '@/types/schedule'
import type { TimeseriesSummary } from '@/types/displayModes'
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

        /** True between clicking Run and receiving the first streaming frame. */
        const isPreparingSimulation = ref(false)

        /** Accumulated timeseries data, merged across per-gene fetches and streaming. */
        const timeseriesCache = ref<TimeseriesData>({})

        /** Set of genes already fetched (avoids duplicate HTTP requests). */
        const fetchedGenes = ref<Set<string>>(new Set())

        /** Currently in-flight gene fetch (prevents concurrent fetches). */
        const isFetchingTimeseries = ref(false)

        /** Latest streaming delta from WS (consumed by TrackViewer for appendStreamingData). */
        const streamingDelta = ref<TimeseriesData | null>(null)

        /** Cached mean+SE summary data (fetched separately from timeseries). */
        const summaryCache = ref<TimeseriesSummary | null>(null)

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

        const summary = computed((): TimeseriesSummary | null => summaryCache.value)

        // =====================================================================
        // TIMESERIES (LAZY HTTP)
        // =====================================================================

        /**
         * Lazily fetch timeseries for the given genes.
         * Only fetches genes not already in cache. Merges results into timeseriesCache.
         * Marks genes as pending immediately to prevent duplicate concurrent fetches.
         */
        async function fetchGeneTimeseries(genes: string[]): Promise<void> {
            const resultId = currentResultId.value
            if (!resultId) return

            const scheduleStore = useScheduleStore()
            const newGenes = genes.filter(g => !fetchedGenes.value.has(g))
            if (newGenes.length === 0) {
                console.debug(`[SimulationStore] All ${genes.length} genes already fetched, skipping`)
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
                console.debug(`[SimulationStore] Fetching timeseries for genes: [${newGenes.join(', ')}] (${species.length} species)`)
                const data = await simulationService.fetchTimeseriesForSpecies(resultId, species)
                _mergeTimeseries(data)
                console.debug(`[SimulationStore] Cache now has ${Object.keys(timeseriesCache.value).length} species`)
            } catch (e) {
                // Rollback: remove genes from fetched set so they can be retried
                newGenes.forEach(g => fetchedGenes.value.delete(g))
                throw e
            } finally {
                isFetchingTimeseries.value = false
            }
        }

        /**
         * Fetch mean+SE summary for the given genes.
         * Replaces any previously cached summary.
         */
        async function fetchSummary(genes: string[]): Promise<void> {
            const resultId = currentResult.value?.id
            if (!resultId || genes.length === 0) return

            const scheduleStore = useScheduleStore()
            const species = genes.flatMap(g => scheduleStore.getSpeciesForGeneId(g))
            if (species.length === 0) return

            console.debug(`[SimulationStore] Fetching summary for ${genes.length} genes (${species.length} species)`)
            const data = await simulationService.fetchTimeseriesSummary(resultId, species)
            summaryCache.value = data
            console.debug(`[SimulationStore] Summary cached: ${Object.keys(data).length} species`)
        }

        /**
         * Get timeseries filtered by genes and paths.
         * Returns data from cache only -- call fetchGeneTimeseries first.
         */
        function getTimeseries(genes?: string[] | null, paths?: string[] | null) {
            if (!timeseries.value) return null

            const scheduleStore = useScheduleStore()

            if (genes !== null && genes !== undefined && genes.length === 0) return {}
            if (paths !== null && paths !== undefined && paths.length === 0) return {}

            const speciesIds = new Set(
                genes === null || genes === undefined
                    ? Object.keys(timeseries.value)
                    : genes.flatMap(gene => scheduleStore.getSpeciesForGeneId(gene))
            )

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

        // =====================================================================
        // STREAMING (WS)
        // =====================================================================

        function _onProgress(currentTime: number, frameCount: number, totalProgress: number | null): void {
            if (!currentResult.value) {
                console.warn('[SimulationStore] _onProgress called but no currentResult')
                return
            }
            console.debug(`[SimulationStore] _onProgress: time=${currentTime} frames=${frameCount} totalProgress=${totalProgress} wasPreparing=${isPreparingSimulation.value}`)
            isPreparingSimulation.value = false
            currentResult.value = {
                ...currentResult.value,
                current_time: currentTime,
                frame_count: frameCount,
                total_progress: totalProgress,
            }
        }

        function _onTimeseries(data: TimeseriesData): void {
            console.debug(`[SimulationStore] _onTimeseries: ${Object.keys(data).length} species`)
            _mergeTimeseries(data)
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
                    const genes = scheduleStore.allGenes ?? []
                    if (genes.length > 0) {
                        fetchGeneTimeseries(genes.slice(0, DEFAULT_STREAM_GENE_COUNT))
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
            console.debug(`[SimulationStore] _onPhaseSpaceReady: simId=${simId}`)
            const data = await simulationService.fetchPhaseSpace(simId)
            phaseSpaceResult.value = data
            isPhaseSpacePending.value = false
            getSimulationStream().clearPhaseSpaceTracking()
            console.debug(`[SimulationStore] Phase space loaded: ${data?.n_cells ?? 0} cells, method=${data?.method ?? 'n/a'}`)
        }

        /** Update the set of species streamed via WS based on selected genes. */
        function updateStreamSubscription(genes: string[]): void {
            if (!isSimulationRunning.value) return
            const scheduleStore = useScheduleStore()
            const species = genes.flatMap(gene => scheduleStore.getSpeciesForGeneId(gene))
            getSimulationStream().subscribe(species)
            console.debug(`[SimulationStore] Updated stream subscription: ${species.length} species`)
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
                    await fetchGeneTimeseries(genes.slice(0, DEFAULT_STREAM_GENE_COUNT))
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

            // Connect WS before starting
            const stream = getSimulationStream()
            stream.connect()

            // Compute initial species to subscribe server-side so streaming starts
            // with the first episode — avoids the late-subscribe race.
            const allGenes = scheduleStore.allGenes ?? []
            const initialGenes = allGenes.slice(0, DEFAULT_STREAM_GENE_COUNT)
            const initialSpecies = initialGenes.flatMap(g => scheduleStore.getSpeciesForGeneId(g))

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

            // Subscribe default genes for live streaming (WS subscription complements
            // the server-side initial subscription from the run request)
            if (initialGenes.length > 0) {
                updateStreamSubscription(initialGenes)
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
            streamingDelta.value = null
        }

        function clearResult(): void {
            currentResult.value = null
            isSimulationRunning.value = false
            isPaused.value = false
            isPreparingSimulation.value = false
            phaseSpaceResult.value = null
            isPhaseSpacePending.value = false
            summaryCache.value = null
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
            summary,
            streamingDelta,
            fetchedGenes,
            getTimeseries,
            fetchGeneTimeseries,
            fetchSummary,
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
