/**
 * Simulation Stream Composable
 *
 * Manages the WebSocket connection for live simulation streaming.
 * Handles: progress updates, incremental timeseries, pause/resume, status changes.
 *
 * Usage: instantiate once in the app. The simulationStore calls methods here
 * to subscribe genes and control the simulation.
 */

import { ref, computed } from 'vue'
import { config } from '@/config/api'
import type { TimeseriesData } from '@/types/simulation'

export type ProgressCallback = (currentTime: number, frameCount: number, totalProgress: number | null) => void
export type TimeseriesCallback = (data: TimeseriesData) => void
export type StatusCallback = (status: string, error?: string) => void
export type PhaseSpaceReadyCallback = (simulationId: string) => void

/** WebSocket message types from server */
interface WsProgressMessage {
    type: 'progress'
    simulation_id: string
    current_time: number
    frame_count: number
    total_progress?: number
}

interface WsTimeseriesMessage {
    type: 'timeseries'
    simulation_id: string
    data: TimeseriesData
}

interface WsStatusMessage {
    type: 'status'
    simulation_id: string
    status: string
    error?: string
}

interface WsPhaseSpaceReadyMessage {
    type: 'phasespace_ready'
    simulation_id: string
}

type WsMessage = WsProgressMessage | WsTimeseriesMessage | WsStatusMessage | WsPhaseSpaceReadyMessage

/**
 * Composable for managing the simulation WebSocket stream.
 * Singleton pattern -- call once, share via provide/inject or direct import.
 */
export function useSimulationStream() {
    const isConnected = ref(false)
    const simulationId = ref<string | null>(null)

    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let onProgress: ProgressCallback | null = null
    let onTimeseries: TimeseriesCallback | null = null
    let onStatus: StatusCallback | null = null
    // Phase-space tracking survives untrack() -- cleared explicitly via clearPhaseSpaceTracking()
    let phaseSpaceSimId: string | null = null
    let onPhaseSpaceReady: PhaseSpaceReadyCallback | null = null

    const wsUrl = computed(() => config.getWebSocketUrl())

    function connect(): void {
        if (ws && ws.readyState <= WebSocket.OPEN) return

        console.debug('[SimStream] Connecting to', wsUrl.value)
        ws = new WebSocket(wsUrl.value)

        ws.onopen = () => {
            isConnected.value = true
            console.debug('[SimStream] Connected')
            if (reconnectTimer) {
                clearTimeout(reconnectTimer)
                reconnectTimer = null
            }
        }

        ws.onclose = () => {
            isConnected.value = false
            console.debug('[SimStream] Disconnected')
            _scheduleReconnect()
        }

        ws.onerror = (event) => {
            console.warn('[SimStream] WebSocket error', event)
        }

        ws.onmessage = (event) => {
            _handleMessage(event.data as string)
        }
    }

    function disconnect(): void {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
        }
        if (ws) {
            ws.onclose = null  // Prevent reconnect
            ws.close()
            ws = null
        }
        isConnected.value = false
    }

    function _scheduleReconnect(): void {
        if (reconnectTimer) return
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            console.debug('[SimStream] Attempting reconnect...')
            connect()
        }, 2000)
    }

    function _handleMessage(raw: string): void {
        const msg: WsMessage = JSON.parse(raw)
        console.debug(`[SimStream] Received: type=${msg.type} sim_id=${msg.simulation_id} tracking=${simulationId.value}`)

        // Ignore messages for other simulations
        if (simulationId.value && msg.simulation_id !== simulationId.value) {
            console.debug(`[SimStream] Ignoring message for different simulation: ${msg.simulation_id} (tracking ${simulationId.value})`)
            return
        }

        switch (msg.type) {
            case 'progress':
                console.debug(`[SimStream] Progress: time=${msg.current_time} frames=${msg.frame_count} hasCallback=${!!onProgress}`)
                onProgress?.(msg.current_time, msg.frame_count, msg.total_progress ?? null)
                break
            case 'timeseries': {
                const speciesCount = Object.keys(msg.data).length
                console.debug(`[SimStream] Timeseries: ${speciesCount} species hasCallback=${!!onTimeseries}`)
                onTimeseries?.(msg.data)
                break
            }
            case 'status':
                console.debug(`[SimStream] Status: ${msg.status} hasCallback=${!!onStatus}`, msg.error ?? '')
                onStatus?.(msg.status, msg.error)
                break
            case 'phasespace_ready':
                console.debug(`[SimStream] PhaseSpaceReady: simId=${msg.simulation_id} expecting=${phaseSpaceSimId}`)
                if (msg.simulation_id === phaseSpaceSimId) {
                    onPhaseSpaceReady?.(msg.simulation_id)
                }
                break
            default:
                console.warn('[SimStream] Unknown message type', (msg as Record<string, unknown>).type)
        }
    }

    function _send(data: Record<string, unknown>): void {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('[SimStream] Cannot send, not connected')
            return
        }
        ws.send(JSON.stringify(data))
    }

    /** Subscribe to species timeseries for the running simulation. */
    function subscribe(species: string[]): void {
        _send({ type: 'subscribe', species })
        console.debug(`[SimStream] Subscribed to ${species.length} species`)
    }

    /** Pause the running simulation. */
    function pause(): void {
        _send({ type: 'pause', simulation_id: simulationId.value })
    }

    /** Resume a paused simulation. */
    function resume(): void {
        _send({ type: 'resume', simulation_id: simulationId.value })
    }

    /** Track a simulation by ID. Sets up callbacks. */
    function track(
        id: string,
        callbacks: {
            onProgress?: ProgressCallback
            onTimeseries?: TimeseriesCallback
            onStatus?: StatusCallback
        }
    ): void {
        console.debug(`[SimStream] Tracking simulation: ${id} connected=${isConnected.value}`)
        simulationId.value = id
        onProgress = callbacks.onProgress ?? null
        onTimeseries = callbacks.onTimeseries ?? null
        onStatus = callbacks.onStatus ?? null
    }

    /** Stop tracking the current simulation (does NOT clear phaseSpace tracking). */
    function untrack(): void {
        simulationId.value = null
        onProgress = null
        onTimeseries = null
        onStatus = null
    }

    /** Register a callback for when phasespace_ready arrives for a specific simulation. */
    function trackPhaseSpace(simId: string, cb: PhaseSpaceReadyCallback): void {
        phaseSpaceSimId = simId
        onPhaseSpaceReady = cb
    }

    /** Clear phase-space tracking (call after phasespace_ready is handled). */
    function clearPhaseSpaceTracking(): void {
        phaseSpaceSimId = null
        onPhaseSpaceReady = null
    }

    return {
        isConnected,
        simulationId,
        connect,
        disconnect,
        subscribe,
        pause,
        resume,
        track,
        untrack,
        trackPhaseSpace,
        clearPhaseSpaceTracking,
    }
}

/** Singleton instance for the app. */
let _instance: ReturnType<typeof useSimulationStream> | null = null

export function getSimulationStream(): ReturnType<typeof useSimulationStream> {
    if (!_instance) {
        _instance = useSimulationStream()
    }
    return _instance
}
