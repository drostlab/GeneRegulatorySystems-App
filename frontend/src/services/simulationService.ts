/**
 * Simulation Service -- API integration for simulation operations
 *
 * Responsibilities:
 * - Fetch stored simulation results (without timeseries)
 * - Load a single simulation result by ID
 * - Start a simulation run and poll its bounded in-process live tail
 * - Fetch timeseries data for specific species (lazy per-gene loading)
 *
 * Used by: simulationStore
 */

import { apiFetch, apiFetchJson } from '@/utils/api'
import type { LiveSimulationSnapshot, PhaseSpaceResult, SimulationResult, TimeseriesData } from '@/types'

/** Normalise a result from HTTP (which may lack total_progress). */
function normaliseResult(r: SimulationResult): SimulationResult {
    return { ...r, total_progress: r.total_progress ?? null }
}

/**
 * Fetch all stored simulation results (no timeseries data).
 */
export async function fetchResultsList(): Promise<SimulationResult[]> {
    const data = await apiFetchJson<SimulationResult[]>('/simulations')

    if (!Array.isArray(data)) {
        console.warn('[simulationService] No results found or invalid format')
        return []
    }

    return data.map(normaliseResult)
}

/**
 * Load a single simulation result by ID.
 */
export async function loadResult(resultId: string): Promise<SimulationResult> {
    const r = await apiFetchJson<SimulationResult>(`/simulations/${resultId}`)
    return normaliseResult(r)
}

/**
 * Start a simulation run.
 * The server spawns the simulation async and returns immediately with status=running.
 * Progress and live timeseries are read through `fetchLive`.
 */
export async function runSimulation(scheduleName: string, scheduleJson: string, maxTime: number, subscribedSpecies: string[] = []): Promise<SimulationResult> {
    const result = await apiFetchJson<SimulationResult>('/simulations/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            schedule_name: scheduleName,
            schedule_spec: scheduleJson,
            max_time: maxTime,
            subscribed_species: subscribedSpecies,
        }),
    })

    if (!result.id) {
        throw new Error('Server did not return result')
    }

    return normaliseResult(result)
}

/** Reconcile the desired live species and fetch one consistent live snapshot. */
export async function fetchLive(resultId: string, species: string[]): Promise<LiveSimulationSnapshot> {
    return apiFetchJson<LiveSimulationSnapshot>(`/simulations/${resultId}/live`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ species }),
    })
}

async function postControl(resultId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    await apiFetch(`/simulations/${resultId}/${action}`, { method: 'POST' })
}

export const pauseSimulation = (resultId: string) => postControl(resultId, 'pause')
export const resumeSimulation = (resultId: string) => postControl(resultId, 'resume')
export const cancelSimulation = (resultId: string) => postControl(resultId, 'cancel')

/**
 * Fetch phase-space embedding for a simulation result.
 * Returns null when the embedding is not yet available (still computing).
 */
export async function fetchPhaseSpace(resultId: string): Promise<PhaseSpaceResult | null> {
    const response = await apiFetch(`/simulations/${resultId}/phasespace`)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`API Error: HTTP ${response.status}`)
    return response.json() as Promise<PhaseSpaceResult>
}

/**
 * Fetch timeseries data for specific species from a simulation result.
 * Used for lazy per-gene loading.
 */
export async function fetchTimeseriesForSpecies(
    resultId: string,
    species: string[],
): Promise<TimeseriesData> {
    const response = await apiFetchJson<{ timeseries: TimeseriesData }>(
        `/simulations/${resultId}/timeseries`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ species }),
        },
    )
    return response.timeseries
}

export interface ViewportQuery {
    species: string[]
    /** Execution paths to include; null = all paths of each species. */
    paths?: string[] | null
    t0: number
    t1: number
    /** Target horizontal resolution; the server returns ≲2·width_px points per series. */
    width_px: number
}

/**
 * Adaptive viewport query against a finished result's multi-resolution pyramid.
 * Returns ≲2·width_px decimated OHLC-step points per (species, path) for [t0, t1].
 */
export async function fetchViewport(
    resultId: string,
    query: ViewportQuery,
): Promise<TimeseriesData> {
    const response = await apiFetchJson<{ timeseries: TimeseriesData }>(
        `/simulations/${resultId}/timeseries/viewport`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(query),
        },
    )
    return response.timeseries
}
