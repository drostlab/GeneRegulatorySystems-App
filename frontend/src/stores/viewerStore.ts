/**
 * Viewer Synchronisation Store
 * 
 * Tracks current playback timepoint and computes expression values at that timepoint,
 * averaged across branches. Used to sync trajectory viewer with network diagram.
 */

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { type SpeciesType } from '@/types'
import { getPathsForSegmentIds, getModelPathAtTime, getGeneFromSpeciesName, getActivePathsAtTime, filterSegmentsByPrefix } from '@/types/schedule'
import { useScheduleStore } from './scheduleStore'
import { useSimulationStore } from './simulationStore'
import { buildTrie, childrenAreParallel, type TrieNode } from '@/schedule/executionTrie'

export const useViewerStore = defineStore('viewer', () => {
    const currentTimepoint = ref<number>(0)
    const selectedGenes = ref<string[]>([])
    const selectedSpeciesNodes = ref<string[]>([])
    const selectedOtherSpecies = ref<string[]>([])
    const selectedSpeciesTypes = ref<SpeciesType[]>([])
    const selectedSegmentIds = ref<Set<number> | null>(null)
    const selectedLineagePath = ref<string | null>(null)
    const selectedLineagePaths = ref<Set<string> | null>(null)
    /** Execution-path prefix filter (empty = show all). Mirrors inspect tool's items_prefix. */
    const pathFilter = ref<string>('')

    /** Maximum genes to fetch/render at once (selection can exceed this). */
    const maxRenderedGenes = ref<number>(10)
    /**
     * Whether gene nodes are dynamically resized by their simulation protein
     * counts. Disabled by default — when off, DynamicsSync skips its watcher
     * and the expensive proteinCountsAtTimepoint/maxProteinCounts computeds
     * are never evaluated.
     */
    const resizeByExpressionEnabled = ref<boolean>(false)

    /** Segments filtered by the path-prefix filter. */
    const filteredSegments = computed(() => {
        const scheduleStore = useScheduleStore()
        return filterSegmentsByPrefix(scheduleStore.segments, pathFilter.value)
    })

    /** Execution paths that survive the path filter. */
    const filteredPaths = computed((): Set<string> | null => {
        if (pathFilter.value === '') return null
        const paths = new Set<string>()
        for (const seg of filteredSegments.value) {
            paths.add(seg.execution_path)
        }
        return paths
    })

    /** Model path of the rectangle segment currently hovered (null when not hovering). */
    const hoveredRectModelPath = ref<string | null>(null)
    /** Execution path of the hovered rect branch (null when not hovering). */
    const hoveredExecutionPath = ref<string | null>(null)
    /** Model path of the instant annotation currently hovered (null when not hovering). */
    const hoveredInstantModelPath = ref<string | null>(null)
    const hoveredOperatorPath = ref<string | null>(null)
    const hoveredTimeRange = ref<{ from: number; to: number } | null>(null)
    /** Gene id currently hovered in the network diagram (null when not hovering). */
    const hoveredGeneId = ref<string | null>(null)

    /**
     * Active model path driving the network overlay.
     * Only rect hover changes this (not instants); falls back to cursor timepoint.
     */
    const activeModelPath = computed((): string | null => {
        if (hoveredRectModelPath.value) return hoveredRectModelPath.value
        const scheduleStore = useScheduleStore()
        const segments = scheduleStore.segments
        if (!segments.length) return null
        return getModelPathAtTime(segments, currentTimepoint.value)
    })

    const selectedPaths = computed((): Set<string> | null => {
        if (selectedLineagePaths.value) return selectedLineagePaths.value
        if (!selectedSegmentIds.value) return null
        const scheduleStore = useScheduleStore()
        const segments = scheduleStore.segments
        if (!segments.length) return null
        return getPathsForSegmentIds(segments, selectedSegmentIds.value)
    })

    /**
     * Protein count per gene at the current timepoint.
     * Priority: hovered execution path > selected segment paths > active paths at t.
     */
    const proteinCountsAtTimepoint = computed((): Record<string, number> => {
        const simulationStore = useSimulationStore()
        const ts = simulationStore.timeseries
        if (!ts) return {}

        const t = currentTimepoint.value
        const scheduleStore = useScheduleStore()

        // Priority 1: a rect branch is hovered — filter to exactly that execution path
        const filterPath = hoveredExecutionPath.value

        // Priority 2: a segment is selected — restrict to its execution paths
        // Priority 3: path filter — restrict to filtered execution paths
        const filterPaths: Set<string> | null = filterPath
            ? null
            : selectedPaths.value ?? filteredPaths.value ?? getActivePathsAtTime(scheduleStore.segments, t)

        const geneSums: Record<string, number> = {}
        const geneCounts: Record<string, number> = {}

        for (const [species, pathData] of Object.entries(ts)) {
            if (!species.endsWith('.proteins')) continue
            const gene = getGeneFromSpeciesName(species)
            if (!gene) continue

            for (const [path, series] of Object.entries(pathData)) {
                if (filterPath && path !== filterPath) continue
                if (filterPaths && !filterPaths.has(path)) continue
                const value = sampleAtTime(series, t)
                geneSums[gene] = (geneSums[gene] ?? 0) + value
                geneCounts[gene] = (geneCounts[gene] ?? 0) + 1
            }
        }

        const result: Record<string, number> = {}
        for (const gene of Object.keys(geneSums)) {
            result[gene] = geneSums[gene]! / (geneCounts[gene] ?? 1)
        }
        return result
    })

    /**
     * Max protein count per gene across the entire timeseries (for normalisation).
     */
    const maxProteinCounts = computed((): Record<string, number> => {
        const simulationStore = useSimulationStore()
        const ts = simulationStore.timeseries
        if (!ts) return {}

        const result: Record<string, number> = {}

        for (const [species, pathData] of Object.entries(ts)) {
            if (!species.endsWith('.proteins')) continue
            const gene = getGeneFromSpeciesName(species)
            if (!gene) continue

            for (const series of Object.values(pathData)) {
                for (const [, v] of series) {
                    result[gene] = Math.max(result[gene] ?? 0, v)
                }
            }
        }
        return result
    })

    function setTimepoint(t: number): void {
        currentTimepoint.value = t
    }

    function selectSegments(ids: Set<number> | null): void {
        selectedSegmentIds.value = ids
        selectedLineagePath.value = null
        selectedLineagePaths.value = null
    }

    /** Select all timeline segments belonging to a given execution path. */
    function selectExecutionPath(executionPath: string): void {
        const scheduleStore = useScheduleStore()
        const matchIds = new Set(
            scheduleStore.segments
                .filter(s => s.execution_path === executionPath)
                .map(s => s.id)
        )
        selectedSegmentIds.value = matchIds.size > 0 ? matchIds : null
        selectedLineagePath.value = selectedSegmentIds.value ? executionPath : null
        selectedLineagePaths.value = selectedSegmentIds.value ? new Set([executionPath]) : null
    }

    /** Toggle the complete lineage containing an execution path. */
    function selectLineage(executionPath: string): void {
        if (selectedLineagePath.value === executionPath) {
            selectedLineagePath.value = null
            selectedSegmentIds.value = null
            selectedLineagePaths.value = null
            return
        }
        const scheduleStore = useScheduleStore()
        const root = buildTrie(
            scheduleStore.segments.map(segment => segment.execution_path),
            scheduleStore.eachPrefixes,
        )
        const choices = new Map<string, ReadonlyMap<string, string>>()

        function visit(node: TrieNode, inherited: ReadonlyMap<string, string>): void {
            choices.set(node.path, inherited)
            const parallel = childrenAreParallel(node)
            for (const child of node.children) {
                const childChoices = new Map(inherited)
                if (parallel) childChoices.set(node.path, child.path)
                visit(child, childChoices)
            }
        }

        visit(root, new Map())
        const selectedChoices = choices.get(executionPath) ?? new Map<string, string>()
        const sharesLineage = (path: string): boolean => {
            const candidateChoices = choices.get(path) ?? new Map<string, string>()
            for (const [fork, child] of selectedChoices) {
                const candidateChild = candidateChoices.get(fork)
                if (candidateChild !== undefined && candidateChild !== child) return false
            }
            for (const [fork, child] of candidateChoices) {
                const selectedChild = selectedChoices.get(fork)
                if (selectedChild !== undefined && selectedChild !== child) return false
            }
            return true
        }

        const matchSegments = scheduleStore.segments
            .filter(segment => sharesLineage(segment.execution_path))
        const matchIds = new Set(matchSegments.map(segment => segment.id))
        selectedLineagePath.value = matchIds.size === 0 ? null : executionPath
        selectedSegmentIds.value = matchIds.size === 0 ? null : matchIds
        selectedLineagePaths.value = matchIds.size === 0
            ? null
            : new Set(matchSegments.map(segment => segment.execution_path))
    }

    function setHoveredRectModel(path: string | null, executionPath: string | null = null): void {
        hoveredRectModelPath.value = path
        hoveredExecutionPath.value = executionPath
    }

    function setHoveredInstantModel(path: string | null): void {
        hoveredInstantModelPath.value = path
    }

    function setHoveredOperator(path: string | null): void {
        hoveredOperatorPath.value = path
    }

    function setHoveredTimeRange(range: { from: number; to: number } | null): void {
        hoveredTimeRange.value = range
    }

    function setHoveredGene(gene: string | null): void {
        hoveredGeneId.value = gene
    }

    function setPathFilter(prefix: string): void {
        pathFilter.value = prefix
    }

    function reset(): void {
        currentTimepoint.value = 0
        selectedGenes.value = []
        selectedSpeciesNodes.value = []
        selectedOtherSpecies.value = []
        selectedSegmentIds.value = null
        selectedLineagePath.value = null
        selectedLineagePaths.value = null
        hoveredRectModelPath.value = null
        hoveredInstantModelPath.value = null
        hoveredOperatorPath.value = null
        hoveredTimeRange.value = null
        hoveredExecutionPath.value = null
        hoveredGeneId.value = null
        pathFilter.value = ''
    }

    return {
        currentTimepoint,
        selectedGenes,
        selectedSpeciesNodes,
        selectedOtherSpecies,
        selectedSpeciesTypes,
        selectedSegmentIds,
        selectedLineagePath,
        selectedLineagePaths,
        pathFilter,
        maxRenderedGenes,
        resizeByExpressionEnabled,
        filteredSegments,
        filteredPaths,
        hoveredExecutionPath,
        hoveredOperatorPath,
        hoveredGeneId,
        hoveredTimeRange,
        activeModelPath,
        selectedPaths,
        proteinCountsAtTimepoint,
        maxProteinCounts,
        setTimepoint,
        setHoveredRectModel,
        setHoveredInstantModel,
        setHoveredOperator,
        setHoveredTimeRange,
        setHoveredGene,
        setPathFilter,
        selectSegments,
        selectExecutionPath,
        selectLineage,
        reset
    }
})

/**
 * Binary search to sample a step-function timeseries at a given time.
 * Returns the value of the last point at or before t (zero-order hold).
 */
function sampleAtTime(series: Array<[number, number]>, t: number): number {
    if (series.length === 0) return 0
    if (t <= series[0]![0]) return series[0]![1]
    if (t >= series[series.length - 1]![0]) return series[series.length - 1]![1]

    let lo = 0
    let hi = series.length - 1
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1
        if (series[mid]![0] <= t) lo = mid
        else hi = mid
    }
    // Step-function: hold the value at lo (last point at or before t)
    return series[lo]![1]
}
