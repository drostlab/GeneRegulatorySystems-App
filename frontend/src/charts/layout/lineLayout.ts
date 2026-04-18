import type { StructureNode, TimelineSegment } from '@/types/schedule'
import logging from '@/utils/logging'

const log = logging.getLogger('lineLayout')

/** Default maximum concurrently visible execution-path lines in the timeline. */
export const DEFAULT_MAX_TIMELINE_PATHS = 20

// ── Output types ────────────────────────────────────────────────────────

/** A horizontal line segment representing a duration model on an execution path. */
export interface LayoutLine {
    segmentId: number
    executionPath: string
    modelPath: string
    label: string
    channel: string
    x1: number
    x2: number
    /** Y centre of this path's band. */
    y: number
}

/** A marker (dot/tick) representing an instant model on an execution path. */
export interface LayoutInstant {
    segmentId: number
    executionPath: string
    modelPath: string
    label: string
    channel: string
    x: number
    /** Y centre of this path's band. */
    y: number
    /** Full band height (for vertical tick sizing). */
    bandHeight: number
}

/** A vertical connector at a branch point. */
export interface LayoutBranchConnector {
    /** Time at which the branch occurs. */
    x: number
    /** Y centre of the parent (or top child). */
    yMin: number
    /** Y centre of the bottom child. */
    yMax: number
    /** Execution paths of the children emanating from this branch. */
    childPaths: string[]
    /** Number of total children (may exceed rendered paths). */
    totalChildren: number
}

export interface LineLayoutResult {
    lines: LayoutLine[]
    instants: LayoutInstant[]
    connectors: LayoutBranchConnector[]
    /** Y-centre per execution path (for PromoterPanel sync). */
    pathYCentres: Map<string, number>
    /** Full band y-ranges per execution path (for compatibility). */
    pathYRanges: Map<string, { yMin: number; yMax: number }>
}

// ── Main layout function ────────────────────────────────────────────────

export function layoutLines(
    structure: StructureNode,
    segments: TimelineSegment[],
    yMin: number,
    yMax: number,
    maxPaths: number = DEFAULT_MAX_TIMELINE_PATHS
): LineLayoutResult {
    const pathYRanges = computeYRanges(segments, yMin, yMax, maxPaths)
    const pathYCentres = new Map<string, number>()
    for (const [path, range] of pathYRanges) {
        pathYCentres.set(path, (range.yMin + range.yMax) / 2)
    }

    const lines: LayoutLine[] = []
    const instants: LayoutInstant[] = []

    for (const seg of segments) {
        const centre = pathYCentres.get(seg.execution_path)
        if (centre === undefined) continue  // path excluded by cap
        const range = pathYRanges.get(seg.execution_path)!

        if (seg.from === seg.to) {
            instants.push({
                segmentId: seg.id,
                executionPath: seg.execution_path,
                modelPath: seg.model_path,
                label: seg.label,
                channel: seg.channel,
                x: seg.from,
                y: centre,
                bandHeight: range.yMax - range.yMin,
            })
        } else {
            lines.push({
                segmentId: seg.id,
                executionPath: seg.execution_path,
                modelPath: seg.model_path,
                label: seg.label,
                channel: seg.channel,
                x1: seg.from,
                x2: seg.to,
                y: centre,
            })
        }
    }

    const connectors = findBranchConnectors(structure, segments, pathYCentres)
    log.debug(`Layout: ${lines.length} lines, ${instants.length} instants, ${connectors.length} connectors`)

    return { lines, instants, connectors, pathYCentres, pathYRanges }
}

// ── Branch connector detection ──────────────────────────────────────────

/**
 * Walk the StructureNode tree to find branch points and create vertical connectors.
 * A branch connector is placed at the time where children diverge.
 */
function findBranchConnectors(
    structure: StructureNode,
    segments: TimelineSegment[],
    pathYCentres: Map<string, number>
): LayoutBranchConnector[] {
    const connectors: LayoutBranchConnector[] = []
    const segByPath = new Map<string, TimelineSegment[]>()
    for (const seg of segments) {
        const list = segByPath.get(seg.execution_path)
        if (list) list.push(seg)
        else segByPath.set(seg.execution_path, [seg])
    }

    walkStructure(structure, segByPath, pathYCentres, connectors)
    return connectors
}

function walkStructure(
    node: StructureNode,
    segByPath: Map<string, TimelineSegment[]>,
    pathYCentres: Map<string, number>,
    connectors: LayoutBranchConnector[]
): void {
    if (node.type === 'branch' && node.children.length > 1) {
        // Find the branch time: earliest segment start among all children's leaf paths
        const childLeafPaths = node.children.map(child => collectLeafPaths(child))
        const allChildPaths = childLeafPaths.flat()

        // Branch time = the earliest start time of any child's segments
        let branchTime = Infinity
        for (const path of allChildPaths) {
            const segs = segByPath.get(path)
            if (segs) {
                for (const seg of segs) {
                    if (seg.from < branchTime) branchTime = seg.from
                }
            }
        }

        if (branchTime < Infinity) {
            // Find y-range of all rendered children
            const renderedYs: number[] = []
            const renderedChildPaths: string[] = []
            for (const path of allChildPaths) {
                const y = pathYCentres.get(path)
                if (y !== undefined) {
                    renderedYs.push(y)
                    renderedChildPaths.push(path)
                }
            }

            if (renderedYs.length > 1) {
                connectors.push({
                    x: branchTime,
                    yMin: Math.min(...renderedYs),
                    yMax: Math.max(...renderedYs),
                    childPaths: renderedChildPaths,
                    totalChildren: allChildPaths.length,
                })
            }
        }
    }

    for (const child of node.children) {
        walkStructure(child, segByPath, pathYCentres, connectors)
    }
}

function collectLeafPaths(node: StructureNode): string[] {
    if (node.type === 'leaf') return [node.execution_path]
    return node.children.flatMap(collectLeafPaths)
}

// ── Y-range computation (reused from rectangleLayout) ───────────────────

function computeYRanges(
    segments: TimelineSegment[],
    yMin: number,
    yMax: number,
    maxPaths: number
): Map<string, { yMin: number; yMax: number }> {
    const segmentsByPath = new Map<string, TimelineSegment[]>()
    for (const seg of segments) {
        const list = segmentsByPath.get(seg.execution_path)
        if (list) list.push(seg)
        else segmentsByPath.set(seg.execution_path, [seg])
    }

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

    // Stable sort by earliest segment start
    durationPaths.sort((a, b) => {
        const sa = pathSpans.get(a)!
        const sb = pathSpans.get(b)!
        return sa.from - sb.from || a.localeCompare(b, undefined, { numeric: true })
    })

    if (durationPaths.length > maxPaths) {
        durationPaths.length = maxPaths
    }

    // Greedy interval-graph colouring
    const bandByPath = greedyBandAssign(durationPaths, segmentsByPath)

    // Epoch boundaries
    const eventSet = new Set<number>()
    for (const path of durationPaths) {
        for (const s of segmentsByPath.get(path)!) {
            eventSet.add(s.from)
            eventSet.add(s.to)
        }
    }
    const events = [...eventSet].sort((a, b) => a - b)

    const yRanges = new Map<string, { yMin: number; yMax: number }>()

    for (let i = 0; i < events.length - 1; i++) {
        const tFrom = events[i]!
        const tTo = events[i + 1]!
        const active = durationPaths.filter(p =>
            segmentsByPath.get(p)!.some(s => s.from <= tFrom && tTo <= s.to)
        )
        if (active.length === 0) continue

        const n = active.length
        const bandH = (yMax - yMin) / n
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

    // Instant paths: match by longest common prefix
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

function segmentsOverlap(segsA: TimelineSegment[], segsB: TimelineSegment[]): boolean {
    for (const a of segsA) {
        for (const b of segsB) {
            if (a.from < b.to && b.from < a.to) return true
        }
    }
    return false
}

function greedyBandAssign(
    orderedPaths: string[],
    segsByPath: Map<string, TimelineSegment[]>
): Map<string, number> {
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
 * Compatibility wrapper: returns pathYRanges from line layout.
 * Used by PromoterPanel and other consumers that need per-path y-ranges.
 */
export function collectPathYRanges(
    structure: StructureNode,
    yMin: number = 0,
    yMax: number = 1,
    segments?: TimelineSegment[],
    maxPaths: number = DEFAULT_MAX_TIMELINE_PATHS
): Map<string, { yMin: number; yMax: number }> {
    if (segments && segments.length > 0) {
        return computeYRanges(segments, yMin, yMax, maxPaths)
    }

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
