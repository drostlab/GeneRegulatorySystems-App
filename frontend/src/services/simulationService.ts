/**
 * Simulation Service -- API integration for simulation operations
 *
 * Responsibilities:
 * - Fetch stored simulation results (without timeseries)
 * - Load a single simulation result by ID
 * - Start a simulation run (async, returns immediately; progress via WS)
 * - Fetch timeseries data for specific species (lazy per-gene loading)
 *
 * Used by: simulationStore
 */

import { apiFetch, apiFetchJson } from '@/utils/api'
import type { PhaseSpaceResult, SimulationResult, TimeseriesData } from '@/types'

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
 * Progress and timeseries arrive via WebSocket.
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
