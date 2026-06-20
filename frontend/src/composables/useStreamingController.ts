/**
 * Streaming Controller Composable
 *
 * Owns the entire streaming lifecycle: buffer accumulation, RAF-based data
 * flushing, and smooth axis animation via StreamingAnimator.
 *
 * Decouples data ingestion (as fast as WS delivers) from visual presentation
 * (smooth lerped axes). On simulation completion, discards any remaining
 * buffer -- the full data is fetched via HTTP and applied through setSimulationData.
 *
 * Internally watches simulationStore.streamingDelta (WS data)
 * and isSimulationRunning (completion). xMax is derived from actual data
 * timestamps (not progress messages) for correct per-branch tracking.
 * Animation speed adapts to match WS batch arrival rate.
 * All watchers are created on start() and torn down on stop().
 *
 * Usage in TrackViewer:
 *   const streaming = useStreamingController(chart)
 *   streaming.start()   // on simulation start
 *   streaming.stop()    // on cancel / clear
 *   streaming.dispose() // on unmount
 */

import { watch, type WatchStopHandle } from 'vue'
import type { MainChart } from '@/charts/MainChart'
import type { TimeseriesData } from '@/types/simulation'
import { StreamingAnimator, type RangeUpdate } from '@/charts/StreamingAnimator'
import { useSimulationStore } from '@/stores/simulationStore'
import { useScheduleStore } from '@/stores/scheduleStore'

type StreamingBuffer = Record<string, Record<string, Array<[number, number]>>>

export function useStreamingController(chart: MainChart) {
    const simulationStore = useSimulationStore()
    const scheduleStore = useScheduleStore()

    let buffer: StreamingBuffer = {}
    let rafId: number | null = null
    let active = false
    let watchers: WatchStopHandle[] = []

    /**
     * Execution path currently being streamed. Branches run sequentially in
     * wall-clock, so only one is live at a time; when it changes (a branch
     * switch), we clear the live series and start fresh for the new active path.
     * The finished branch is already on disk and reachable via the viewport query.
     */
    let activePath: string | null = null

    // ---- Adaptive speed tracking ----

    /** EMA smoothing factor for inter-batch interval. */
    const EMA_ALPHA = 0.3
    /** -ln(0.05): 95% convergence in one batch interval. */
    const LN_005 = 2.996
    let lastBatchTime: number | null = null
    let batchIntervalEma: number | null = null

    /** Update the animator speed from the inter-batch interval. */
    function _updateAdaptiveSpeed(now: number): void {
        if (lastBatchTime !== null) {
            const interval = (now - lastBatchTime) / 1000
            if (interval > 0.01) {
                batchIntervalEma = batchIntervalEma === null
                    ? interval
                    : EMA_ALPHA * interval + (1 - EMA_ALPHA) * batchIntervalEma
                animator.setSpeed(LN_005 / batchIntervalEma)
            }
        }
        lastBatchTime = now
    }

    // ---- Animator ----

    const animator = new StreamingAnimator((update: RangeUpdate) => {
        chart.setStreamingRanges(update.xMin, update.xMax, update.yRanges)
    })

    // ---- Active-branch tracking ----

    /** The execution path carrying the latest data in a delta (the live branch). */
    function _dominantPath(delta: TimeseriesData): string | null {
        let best: string | null = null
        let bestTime = -Infinity
        for (const species in delta) {
            for (const path in delta[species]!) {
                for (const pt of delta[species]![path]!) {
                    if (pt[1] !== -1 && pt[0] > bestTime) {
                        bestTime = pt[0]
                        best = path
                    }
                }
            }
        }
        return best
    }

    /** Keep only the active path's series, so the live view shows a single branch. */
    function _filterToActivePath(delta: TimeseriesData): TimeseriesData {
        if (activePath === null) return delta
        const out: StreamingBuffer = {}
        for (const species in delta) {
            const points = delta[species]![activePath]
            if (points) out[species] = { [activePath]: points }
        }
        return out
    }

    // ---- Buffer management ----

    /** Merge a WS timeseries delta into the accumulated buffer. Returns the max time seen. */
    function _mergeIntoBuffer(delta: TimeseriesData): number {
        performance.mark('merge-buf-start')
        let maxTime = -Infinity
        for (const species in delta) {
            const pathData = delta[species]!
            let speciesBuf = buffer[species]
            if (!speciesBuf) {
                speciesBuf = {}
                buffer[species] = speciesBuf
            }
            for (const path in pathData) {
                const points = pathData[path]!
                const existing = speciesBuf[path]
                if (existing) {
                    existing.push(...points)
                } else {
                    speciesBuf[path] = points
                }
                // Track max time from actual data (skip gap markers where value === -1)
                for (const pt of points) {
                    if (pt[1] !== -1 && pt[0] > maxTime) {
                        maxTime = pt[0]
                    }
                }
            }
        }
        performance.measure('grs:merge-into-buffer', 'merge-buf-start')
        return maxTime
    }

    // ---- RAF flush loop ----

    function _scheduleFlush(): void {
        if (rafId !== null) return
        rafId = requestAnimationFrame(() => {
            rafId = null
            if (!active) return

            const hasData = Object.keys(buffer).length > 0
            if (hasData && scheduleStore.timeseriesMetadata) {
                performance.mark('raf-flush-start')
                const yRanges = chart.appendStreamingDataOnly(buffer)
                performance.measure('grs:raf-flush', 'raf-flush-start')
                buffer = {}

                // Feed y-range targets to the animator
                for (const [panelId, range] of yRanges) {
                    animator.setTargetY(panelId, range.min, range.max)
                }
            }
        })
    }

    // ---- Public API ----

    /** Start streaming: sets up watchers and begins the animation loop. */
    function start(): void {
        if (active) return
        active = true
        buffer = {}
        activePath = null
        lastBatchTime = null
        batchIntervalEma = null

        // Lock the viewport while streaming — the animator owns the range, and
        // user zoom/pan would fight it. Re-enabled on stop().
        chart.setZoomEnabled(false)

        animator.start()

        // Watch WS deltas -- derive xMax from actual data, adapt animation speed
        const stopDelta = watch(
            () => simulationStore.streamingDelta,
            (delta) => {
                if (!delta) return
                _updateAdaptiveSpeed(performance.now())

                // Detect a branch switch: the active path changed. Clear the live
                // series so only the new active branch is shown (no multi-branch
                // pollution); the previous branch is already flushed to Arrow.
                const incoming = _dominantPath(delta)
                if (incoming !== null && incoming !== activePath) {
                    if (activePath !== null) {
                        chart.resetLiveSeries()
                        buffer = {}
                    }
                    activePath = incoming
                }

                const branchDelta = _filterToActivePath(delta)
                const maxTime = _mergeIntoBuffer(branchDelta)
                if (maxTime > -Infinity) {
                    animator.setTargetX(maxTime)
                }
                _scheduleFlush()
            }
        )

        // Watch for simulation completion -- stop streaming, discard buffer
        const stopRunning = watch(
            () => simulationStore.isSimulationRunning,
            (running, wasRunning) => {
                if (!running && wasRunning) {
                    stop()
                    // Final zoom to fit all data after the HTTP-fetched data is loaded
                    // (handled by the timeseries cache watcher in TrackViewer)
                    chart.zoomExtentsAll()
                }
            }
        )

        watchers = [stopDelta, stopRunning]
        console.debug('[StreamingController] started')
    }

    /** Stop streaming: cancel RAF, discard buffer, stop animator, tear down watchers. */
    function stop(): void {
        if (!active) return
        active = false

        // Cancel pending RAF
        if (rafId !== null) {
            cancelAnimationFrame(rafId)
            rafId = null
        }

        // Discard buffer — full data will be loaded via HTTP
        buffer = {}
        activePath = null

        animator.stop()

        // Restore user zoom/pan now that the run is finished.
        chart.setZoomEnabled(true)

        // Tear down watchers
        watchers.forEach(w => w())
        watchers = []

        console.debug('[StreamingController] stopped')
    }

    /** Clean up everything (call from onBeforeUnmount). */
    function dispose(): void {
        stop()
    }

    return { start, stop, dispose }
}
