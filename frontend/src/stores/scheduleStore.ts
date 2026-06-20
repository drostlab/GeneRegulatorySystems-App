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
            unionNetwork.value = null
            pendingNetworkFetch = null
            const viewerStore = useViewerStore()
            viewerStore.selectSegments(null)
        }

        let pendingNetworkFetch: Promise<UnionNetwork | null> | null = null

        async function fetchUnionNetwork(): Promise<UnionNetwork | null> {
            if (!schedule.value.data) return null
            if (unionNetwork.value) return unionNetwork.value
            if (pendingNetworkFetch) return pendingNetworkFetch

            pendingNetworkFetch = _doFetchUnionNetwork()
            try {
                return await pendingNetworkFetch
            } finally {
                pendingNetworkFetch = null
            }
        }

        async function _doFetchUnionNetwork(): Promise<UnionNetwork | null> {
            isNetworkLoading.value = true
            try {
                const segs = schedule.value.data!.segments
                const result = await scheduleService.fetchUnionNetwork(schedule.value.spec, segs)
                unionNetwork.value = result

                console.debug(`[ScheduleStore] Union network loaded: ${result.nodes.length} nodes, ${result.links.length} links, ${Object.keys(result.model_exclusions).length} models`)
                return result
            } finally {
                isNetworkLoading.value = false
            }
        }

        async function loadScheduleByKey(key: string): Promise<Schedule> {
            const { source, name } = parseScheduleKey(key)

            // Set editor state immediately (name/source visible before fetch)
            schedule.value.name = name
            schedule.value.source = source as any
            schedule.value.validationMessages = []

            isLoading.value = true
            try {
                // Fetch spec text first (fast file read) so editor shows JSON early
                const specText = await scheduleService.getScheduleSpec(key)
                const isSameSpec = schedule.value.data !== null && schedule.value.spec === specText
                schedule.value.spec = specText

                // Skip full reload if data already loaded for same spec
                if (isSameSpec) {
                    console.debug(`[ScheduleStore] Same spec already loaded, skipping data reload: ${key}`)
                    // Still fetch validation messages
                    const res = await scheduleService.loadScheduleFromKey(key)
                    schedule.value.validationMessages = res.validationMessages ?? []
                    return schedule.value
                }

                // Full load (validation + data generation)
                // Don't clear data/network yet -- keep old content visible during validation
                const res = await scheduleService.loadScheduleFromKey(key)

                // Now that we have new data, clear old state and replace
                clearNetwork()
                schedule.value = res
                console.debug(`[ScheduleStore] Loaded schedule: ${key}`)
                return schedule.value
            } finally {
                isLoading.value = false
            }
        }

        async function loadScheduleBySpec(spec: string, name: string, source: ScheduleSource = 'snapshot'): Promise<Schedule> {
            // Skip full reload if data already loaded for same spec
            const isSameSpec = schedule.value.data !== null && schedule.value.spec === spec

            // Set editor state immediately
            schedule.value.name = name
            schedule.value.source = source
            schedule.value.spec = spec
            schedule.value.validationMessages = []

            if (isSameSpec) {
                console.debug(`[ScheduleStore] Same spec already loaded, skipping data reload: ${name}`)
                return schedule.value
            }

            isLoading.value = true

            try {
                // Don't clear data/network yet -- keep old content visible during validation
                const res = await scheduleService.loadScheduleFromSpec(spec, name, source)

                // Now that we have new data, clear old state and replace
                clearNetwork()
                schedule.value = res
                console.debug(`[ScheduleStore] Loaded schedule from spec: ${name}`)
                return schedule.value
            } finally {
                isLoading.value = false
            }
        }

        /** Directly set a pre-loaded schedule (e.g. from upload response), avoiding a redundant server fetch. */
        function setSchedule(loaded: Schedule): void {
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
