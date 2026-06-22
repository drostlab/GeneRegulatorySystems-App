import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Schedule, ScheduleSource } from '@/types/schedule'
import type { UnionNetwork } from '@/types/network'
import * as scheduleService from '@/services/scheduleService'
import {
    computeScheduleKey, extractAllGeneIds, getSpeciesForGene,
    getSpeciesForType, getTimeExtent, parseScheduleKey, GENE_SPECIES_TYPES
} from '@/types/schedule'
import type { SpeciesType } from '@/types/schedule'
import type { TimeseriesMetadata } from '@/types/simulation'
import { useViewerStore } from './viewerStore'
import { saveFile } from '@/utils/saveFile'
import { isAbortError } from '@/utils/api'

export const useScheduleStore = defineStore(
    'schedule',
    () => {
        const scheduleKey = computed(() => computeScheduleKey(schedule.value.name, schedule.value.source))
        const schedule = ref<Schedule>({
            name: '',
            source: 'user',
            spec: '',
            data: null,
            validationMessages: []
        })

        const scheduleMessages = computed(() => schedule.value.validationMessages ?? [])
        const isLoading = ref<boolean>(false)

        const allGenes = computed(() => schedule.value.data ? extractAllGeneIds(schedule.value.data) : null)
        const geneColours = computed(() => schedule.value.data?.gene_colours ?? null)
        const segments = computed(() => schedule.value.data?.segments || [])
        const modelActivations = computed(() => schedule.value.data?.model_activations || [])
        const eachPrefixes = computed(() => schedule.value.data?.each_prefixes || [])
        const scheduleOperators = computed(() => schedule.value.data?.operators || [])
        const isLoaded = computed(() => schedule.value.data !== null)

        const timeseriesMetadata = computed((): TimeseriesMetadata | null => {
            if (!schedule.value.data) return null
            const segPaths: Record<string, string> = {}
            for (const seg of schedule.value.data.segments) {
                segPaths[String(seg.id)] = seg.execution_path
            }
            return {
                genes: schedule.value.data.genes,
                gene_colours: geneColours.value || {},
                time_extent: getTimeExtent(schedule.value.data.segments),
                segment_paths: segPaths,
            }
        })

        const unionNetwork = ref<UnionNetwork | null>(null)
        const isNetworkLoading = ref<boolean>(false)
        let scheduleGeneration = 0
        let activeScheduleRequest: AbortController | null = null
        let networkGeneration = 0
        let activeNetworkRequest: AbortController | null = null
        let pendingNetworkFetch: Promise<UnionNetwork | null> | null = null

        /** All model paths available in the union network. */
        const modelPaths = computed((): string[] => {
            if (!unionNetwork.value) return []
            return Object.keys(unionNetwork.value.model_exclusions)
        })

        /** Species names not belonging to any gene (e.g. dimer products from reactions). */
        const allOtherSpecies = computed((): string[] => {
            if (!unionNetwork.value) return []
            const geneTypes = new Set<string>(GENE_SPECIES_TYPES)
            return unionNetwork.value.nodes
                .filter(n => n.kind === 'species' && !geneTypes.has(n.properties?.species_type ?? ''))
                .map(n => String(n.name))
        })

        function clearNetwork(): void {
            networkGeneration++
            activeNetworkRequest?.abort()
            activeNetworkRequest = null
            unionNetwork.value = null
            pendingNetworkFetch = null
            isNetworkLoading.value = false
            const viewerStore = useViewerStore()
            viewerStore.selectSegments(null)
        }

        async function fetchUnionNetwork(): Promise<UnionNetwork | null> {
            if (!schedule.value.data) return null
            if (unionNetwork.value) return unionNetwork.value
            if (pendingNetworkFetch) return pendingNetworkFetch

            const capturedSpec = schedule.value.spec
            const capturedSegments = schedule.value.data.segments
            const generation = ++networkGeneration
            const controller = new AbortController()
            activeNetworkRequest = controller
            isNetworkLoading.value = true
            let request!: Promise<UnionNetwork | null>
            request = (async (): Promise<UnionNetwork | null> => {
                try {
                    const result = await scheduleService.fetchUnionNetwork(capturedSpec, capturedSegments, { signal: controller.signal })
                    if (generation !== networkGeneration || activeNetworkRequest !== controller || schedule.value.spec !== capturedSpec) return null
                    unionNetwork.value = result
                    console.debug(`[ScheduleStore] Union network loaded: ${result.nodes.length} nodes, ${result.links.length} links, ${Object.keys(result.model_exclusions).length} models`)
                    return result
                } catch (error) {
                    if (isAbortError(error, controller.signal) || generation !== networkGeneration) return null
                    throw error
                } finally {
                    if (generation === networkGeneration && activeNetworkRequest === controller) {
                        activeNetworkRequest = null
                        isNetworkLoading.value = false
                    }
                    if (pendingNetworkFetch === request) pendingNetworkFetch = null
                }
            })()
            pendingNetworkFetch = request
            return request
        }

        async function runScheduleLoad(load: (signal: AbortSignal) => Promise<Schedule>): Promise<Schedule | null> {
            activeScheduleRequest?.abort()
            const generation = ++scheduleGeneration
            const controller = new AbortController()
            activeScheduleRequest = controller
            isLoading.value = true
            try {
                const loaded = await load(controller.signal)
                if (generation !== scheduleGeneration || activeScheduleRequest !== controller) return null
                clearNetwork()
                schedule.value = loaded
                return loaded
            } catch (error) {
                if (isAbortError(error, controller.signal) || generation !== scheduleGeneration) return null
                throw error
            } finally {
                if (generation === scheduleGeneration && activeScheduleRequest === controller) {
                    activeScheduleRequest = null
                    isLoading.value = false
                }
            }
        }

        async function loadScheduleByKey(key: string): Promise<Schedule | null> {
            const { source, name } = parseScheduleKey(key)
            return runScheduleLoad(signal => scheduleService.loadScheduleFromKey(
                `${source}/${name}`, { signal },
            ))
        }

        async function loadScheduleBySpec(spec: string, name: string, source: ScheduleSource = 'snapshot'): Promise<Schedule | null> {
            return runScheduleLoad(signal => scheduleService.loadScheduleFromSpec(spec, name, source, { signal }))
        }

        /** Directly set a pre-loaded schedule (e.g. from upload response), avoiding a redundant server fetch. */
        function setSchedule(loaded: Schedule): void {
            scheduleGeneration++
            activeScheduleRequest?.abort()
            activeScheduleRequest = null
            isLoading.value = false
            clearNetwork()
            schedule.value = loaded
            console.debug(`[ScheduleStore] Set schedule directly: ${loaded.source}/${loaded.name}`)
        }

        function getSpeciesForGeneId(gene: string): string[] {
            if (!schedule.value.data) return []
            return getSpeciesForGene(schedule.value.data, gene)
        }

        function getSpeciesForSpeciesType(speciesType: SpeciesType): string[] {
            if (speciesType === 'other') return allOtherSpecies.value
            if (!schedule.value.data) return []
            return getSpeciesForType(schedule.value.data, speciesType)
        }

        function downloadSchedule(): void {
            const spec = schedule.value.spec
            const name = schedule.value.name || 'schedule'
            if (!spec) return
            const blob = new Blob([spec], { type: 'application/json' })
            saveFile(blob, {
                filename: `${name}.schedule.json`,
                mimeType: 'application/json',
                filterName: 'JSON',
                extensions: ['json'],
            })
        }

        return {
            schedule,
            scheduleKey,
            scheduleMessages,
            isLoading,
            isNetworkLoading,
            allGenes,
            geneColours,
            segments,
            modelActivations,
            eachPrefixes,
            scheduleOperators,
            isLoaded,
            timeseriesMetadata,
            unionNetwork,
            modelPaths,
            allOtherSpecies,
            loadScheduleByKey,
            loadScheduleBySpec,
            setSchedule,
            fetchUnionNetwork,
            getSpeciesForGeneId,
            getSpeciesForSpeciesType,
            downloadSchedule
        }
    }
)
