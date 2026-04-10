import type { StructureNode, TimelineSegment } from '@/types/schedule'

/** Default maximum concurrently visible execution-path rows in the timeline. */
export const DEFAULT_MAX_TIMELINE_PATHS = 20

export interface LayoutRectangle {
    segmentId: number
    executionPath: string
    modelPath: string
    label: string
    channel: string
    x1: number
    x2: number
    y1: number
    y2: number
    isInstant: boolean
}

export function layoutRectangles(
    _structure: StructureNode,
    segments: TimelineSegment[],
    yMin: number,
    yMax: number,
    maxPaths: number = DEFAULT_MAX_TIMELINE_PATHS
): LayoutRectangle[] {
    const segmentsByPath = groupSegmentsByPath(segments)
    const yRanges = computeYRanges(segmentsByPath, yMin, yMax, maxPaths)

    const rectangles: LayoutRectangle[] = []
    for (const [, segs] of segmentsByPath) {
        const range = yRanges.get(segs[0]!.execution_path)
        if (!range) continue  // path excluded by cap
        const { yMin: rectYMin, yMax: rectYMax } = range
        for (const seg of segs) {
            rectangles.push({
                segmentId: seg.id,
                executionPath: seg.execution_path,
                modelPath: seg.model_path,
                label: seg.label,
                channel: seg.channel,
                x1: seg.from,
                x2: seg.to,
                y1: rectYMin,
                y2: rectYMax,
                isInstant: seg.from === seg.to
            })
        }
    }
    return rectangles
}

function groupSegmentsByPath(segments: TimelineSegment[]): Map<string, TimelineSegment[]> {
    const map = new Map<string, TimelineSegment[]>()
    for (const seg of segments) {
        const list = map.get(seg.execution_path)
        if (list) {
            list.push(seg)
        } else {
            map.set(seg.execution_path, [seg])
        }
    }
    return map
}

/**
 * Compute y-ranges for all execution paths.
 *
 * Duration paths (at least one segment with from !== to):
 *   1. Greedy interval-graph colouring assigns a stable band index to each path.
 *   2. The time axis is split into epochs at every segment-boundary event.
 *   3. Within each epoch, only the active paths are present; their band indices
 *      are remapped onto [0, n) so the active group fills the full [yMin, yMax].
 *   4. Each path's final y-range is the union of its remapped ranges across epochs.
 *
 * This means a stem path that runs alone before branching fills full height, while
 * the N branches that follow each get 1/N of the height — regardless of how many
 * bands exist globally.
 *
 * Instant-only paths:
 *   Matched to the duration path(s) with the longest common path-string prefix,
 *   then given the union of those paths' y-ranges. This places a branch-local
 *   instant inside its branch's band, and a stem instant across the full height.
 */
function computeYRanges(
    segmentsByPath: Map<string, TimelineSegment[]>,
    yMin: number,
    yMax: number,
    maxPaths: number = DEFAULT_MAX_TIMELINE_PATHS
): Map<string, { yMin: number; yMax: number }> {
    // Separate duration from instant-only paths
    const durationPaths: string[] = []
    const instantPaths: Array<{ path: string; t: number }> = []
    const pathSpans = new Map<string, { from: number; to: number }>()

    for (const [path, segs] of segmentsByPath) {
        if (segs.every(s => s.from === s.to)) {
            instantPaths.push({ path, t: segs[0]!.from })
            continue
        }
        let from = Infinity
        let to = -Infinity
        for (const s of segs) {
            if (s.from < from) from = s.from
            if (s.to > to) to = s.to
        }
        pathSpans.set(path, { from, to })
        durationPaths.push(path)
    }

    // Stable ordering for greedy colouring: by earliest segment start, then path string
    durationPaths.sort((a, b) => {
        const sa = pathSpans.get(a)!
        const sb = pathSpans.get(b)!
        return sa.from - sb.from || a.localeCompare(b, undefined, { numeric: true })
    })

    // Cap to avoid overcrowded layout; excess paths are simply not rendered
    if (durationPaths.length > maxPaths) {
        console.debug(`[rectangleLayout] Capping ${durationPaths.length} paths to ${maxPaths}`)
        durationPaths.length = maxPaths
    }

    // Greedy interval-graph colouring using actual segment-level overlap
    const bandByPath = greedyBandAssign(durationPaths, segmentsByPath)

    // Epoch boundaries: every from/to value of every individual segment
    const eventSet = new Set<number>()
    for (const path of durationPaths) {
        for (const s of segmentsByPath.get(path)!) {
            eventSet.add(s.from)
            eventSet.add(s.to)
        }
    }
    const events = [...eventSet].sort((a, b) => a - b)

    // For each epoch, remap active bands onto [0, n) and union into each path's y-range
    const yRanges = new Map<string, { yMin: number; yMax: number }>()

    for (let i = 0; i < events.length - 1; i++) {
        const tFrom = events[i]!
        const tTo = events[i + 1]!

        // A path is active in this epoch only if one of its actual segments covers it
        const active = durationPaths.filter(p =>
            segmentsByPath.get(p)!.some(s => s.from <= tFrom && tTo <= s.to)
        )
        if (active.length === 0) continue

        const n = active.length
        const bandH = (yMax - yMin) / n
        // Sort active paths by their band index for a consistent top-to-bottom order
        const sorted = active.slice().sort((a, b) => bandByPath.get(a)! - bandByPath.get(b)!)

        sorted.forEach((path, pos) => {
            const epochYMax = yMax - pos * bandH
            const epochYMin = epochYMax - bandH
            const existing = yRanges.get(path)
            if (existing) {
                existing.yMin = Math.min(existing.yMin, epochYMin)
                existing.yMax = Math.max(existing.yMax, epochYMax)
            } else {
                yRanges.set(path, { yMin: epochYMin, yMax: epochYMax })
            }
        })
    }

    // Instant paths: match by longest common prefix among duration paths
    for (const { path } of instantPaths) {
        let bestLen = -1
        const bestPaths: string[] = []
        for (const durPath of durationPaths) {
            const len = commonPrefixLength(path, durPath)
            if (len > bestLen) {
                bestLen = len
                bestPaths.length = 0
                bestPaths.push(durPath)
            } else if (len === bestLen) {
                bestPaths.push(durPath)
            }
        }

        let minY = yMax
        let maxY = yMin
        for (const p of bestPaths) {
            const r = yRanges.get(p)
            if (r) {
                if (r.yMin < minY) minY = r.yMin
                if (r.yMax > maxY) maxY = r.yMax
            }
        }
        yRanges.set(path, minY < maxY ? { yMin: minY, yMax: maxY } : { yMin, yMax })
    }

    return yRanges
}

/** Returns true if any segment from segsA actually overlaps any segment from segsB. */
function segmentsOverlap(segsA: TimelineSegment[], segsB: TimelineSegment[]): boolean {
    for (const a of segsA) {
        for (const b of segsB) {
            if (a.from < b.to && b.from < a.to) return true
        }
    }
    return false
}

/**
 * Greedy interval-graph colouring using actual segment overlap.
 * Two paths are in conflict only if at least one segment from each genuinely overlaps.
 */
function greedyBandAssign(
    orderedPaths: string[],
    segsByPath: Map<string, TimelineSegment[]>
): Map<string, number> {
    // bandMembers[b] = list of paths already assigned to band b
    const bandMembers: string[][] = []
    const bandByPath = new Map<string, number>()
    for (const path of orderedPaths) {
        const segs = segsByPath.get(path)!
        let assigned = -1
        for (let b = 0; b < bandMembers.length; b++) {
            const conflicts = bandMembers[b]!.some(other =>
                segmentsOverlap(segs, segsByPath.get(other)!)
            )
            if (!conflicts) {
                assigned = b
                break
            }
        }
        if (assigned === -1) {
            assigned = bandMembers.length
            bandMembers.push([path])
        } else {
            bandMembers[assigned]!.push(path)
        }
        bandByPath.set(path, assigned)
    }
    return bandByPath
}

function commonPrefixLength(a: string, b: string): number {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
}

/**
 * Returns the y-range for every execution path, using the same interval-colouring
 * logic as layoutRectangles when segments are available. Falls back to a uniform
 * split over all leaf paths in the structure tree when no segments are provided.
 */
export function collectPathYRanges(
    structure: StructureNode,
    yMin: number = 0,
    yMax: number = 1,
    segments?: TimelineSegment[],
    maxPaths: number = DEFAULT_MAX_TIMELINE_PATHS
): Map<string, { yMin: number; yMax: number }> {
    if (segments && segments.length > 0) {
        return computeYRanges(groupSegmentsByPath(segments), yMin, yMax, maxPaths)
    }

    // No segments yet — fall back to one equal band per leaf, top-to-bottom
    const leafPaths = collectLeafPaths(structure)
    const n = leafPaths.length
    const bandHeight = n > 0 ? (yMax - yMin) / n : yMax - yMin
    const ranges = new Map<string, { yMin: number; yMax: number }>()
    leafPaths.forEach((path, i) => {
        const rectYMax = yMax - i * bandHeight
        ranges.set(path, { yMin: rectYMax - bandHeight, yMax: rectYMax })
    })
    return ranges
}

function collectLeafPaths(node: StructureNode): string[] {
    if (node.type === 'leaf') return [node.execution_path]
    return node.children.flatMap(collectLeafPaths)
}
