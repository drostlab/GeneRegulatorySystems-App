import type { TimeseriesData } from "@/types"
import type { LiveSimulationSnapshot } from "@/types/simulation"

type Points = Array<[number, number]>

/**
 * Frontend reconstruction of the live window from incremental backend deltas.
 *
 * The backend keeps a bounded, lineage-aware, pruned window but most of it is
 * unchanged between polls. So each poll we send the cursor we last saw
 * (`since` + `lineage`) and the backend replies with only newer points -- or,
 * on a branch cut, the whole window with `reset = true`. This buffer
 * accumulates those deltas, prunes its left edge to `window_start`, and hands a
 * *full* window back so the chart and panels are oblivious to the wire format.
 */
export class LiveBuffer {
    // species -> path -> sorted [t, value][]
    private series = new Map<string, Map<string, Points>>()
    private lineage = ""
    private lastTime = 0

    /** Cursor to send on the next poll so the backend can reply incrementally. */
    get cursor(): { since: number; lineage: string } {
        return { since: this.lastTime, lineage: this.lineage }
    }

    reset(): void {
        this.series.clear()
        this.lineage = ""
        this.lastTime = 0
    }

    /** Merge one (delta or full) snapshot; return the reconstructed full window. */
    ingest(snapshot: LiveSimulationSnapshot): LiveSimulationSnapshot {
        if (snapshot.reset) this.series.clear()

        for (const [species, pathData] of Object.entries(snapshot.series)) {
            let paths = this.series.get(species)
            if (!paths) this.series.set(species, (paths = new Map()))
            for (const [path, points] of Object.entries(pathData)) {
                const existing = paths.get(path)
                if (existing && !snapshot.reset) existing.push(...points)
                else paths.set(path, points.slice())
            }
        }

        this.lineage = snapshot.active_lineage
        this.lastTime = snapshot.current_time
        this.prune(snapshot.window_start)

        return { ...snapshot, series: this.reconstruct(snapshot.active_path, snapshot.current_time) }
    }

    /** Drop points left of `windowStart`, holding one baseline at the edge so
     *  sparse series still draw a left segment (mirrors the backend prune). */
    private prune(windowStart: number): void {
        for (const paths of this.series.values()) {
            for (const [path, pts] of paths) {
                if (pts.length === 0) continue
                let i = 0
                while (i < pts.length && pts[i]![0] < windowStart) i++
                if (i === pts.length) {
                    paths.set(path, [[windowStart, pts[pts.length - 1]![1]]])
                } else if (i > 0) {
                    const baseline = pts[i - 1]![1]
                    pts.splice(0, i)
                    if (pts[0]![0] > windowStart) pts.unshift([windowStart, baseline])
                }
            }
        }
    }

    /** Build the full window, extending the active path to `currentTime` (a
     *  zero-order hold so the live line reaches the leading edge). */
    private reconstruct(activePath: string, currentTime: number): TimeseriesData {
        const out: TimeseriesData = {}
        for (const [species, paths] of this.series) {
            const pathData: Record<string, Points> = {}
            for (const [path, pts] of paths) {
                const last = pts[pts.length - 1]
                pathData[path] = path === activePath && last && last[0] < currentTime
                    ? [...pts, [currentTime, last[1]]]
                    : pts
            }
            out[species] = pathData
        }
        return out
    }
}
