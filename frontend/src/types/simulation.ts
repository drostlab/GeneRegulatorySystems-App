import { getGeneFromSpeciesName } from './schedule'

export type TimeseriesData = Record<string, Record<string, Array<[number, number]>>>

export interface TimeseriesMetadata {
    genes: string[]
    gene_colours: Record<string, string>
    time_extent: { min: number; max: number }
}

export type SimulationStatus = 'running' | 'paused' | 'completed' | 'error'

/**
 * Unified simulation result. Timeseries data is always loaded lazily
 * via the `/simulations/{id}/timeseries` endpoint.
 */
export interface SimulationResult {
    id: string
    created_at?: string
    schedule_name: string
    schedule_spec: string
    status: SimulationStatus
    frame_count: number
    current_time: number
    max_time: number
    total_progress: number | null
    error?: string
}

/** Progress as a fraction in [0, 1]. Prefers per-segment total_progress when available. */
export function getProgress(result: SimulationResult): number {
    if (result.total_progress !== null) return result.total_progress
    if (result.max_time <= 0) return 0
    return Math.min(result.current_time / result.max_time, 1)
}

export function getMaxTime(timeseries: TimeseriesData): number {
    let maxTime = 0
    for (const pathData of Object.values(timeseries)) {
        for (const series of Object.values(pathData)) {
            for (const [t] of series) {
                maxTime = Math.max(maxTime, t)
            }
        }
    }
    return maxTime
}

export function restructureTimeseriesByPathAndGene(
    timeseries: TimeseriesData,
    metadata: TimeseriesMetadata
): Record<string, Record<string, { colour: string; series: Array<[number, number]> }>> {
    const dataByPath = new Map<string, Map<string, { colour: string; series: Array<[number, number]> }>>()

    for (const [species, pathData] of Object.entries(timeseries)) {
        const geneId = getGeneFromSpeciesName(species)
        if (!geneId) continue

        const colour = metadata.gene_colours[geneId] ?? 'gray'

        for (const [path, series] of Object.entries(pathData)) {
            if (!dataByPath.has(path)) {
                dataByPath.set(path, new Map())
            }
            dataByPath.get(path)!.set(geneId, { colour, series })
        }
    }

    const result: Record<string, Record<string, { colour: string; series: Array<[number, number]> }>> = {}
    dataByPath.forEach((geneMap, path) => {
        result[path] = {}
        geneMap.forEach((data, geneId) => {
            result[path]![geneId] = data
        })
    })

    return result
}

export interface PhaseSpacePoint {
    x: number
    y: number
    path: string
    t: number
    colour: string
}

export interface PhaseSpaceResult {
    simulation_id: string
    method: string
    axis_labels: string[]
    axis_top_genes: string[]
    points: PhaseSpacePoint[]
    n_genes: number
    n_cells: number
}

export function formatResultLabel(result: SimulationResult | undefined | null): string {
    if (!result) return ''

    let date: Date
    if (result.created_at) {
        date = new Date(result.created_at)
    } else {
        date = new Date(result.id)
    }

    return `${date.toLocaleString()} - ${result.schedule_name || 'Unknown'}`
}
