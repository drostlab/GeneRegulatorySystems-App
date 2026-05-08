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
    structure: StructureNode,
    segments: TimelineSegment[],
    yMin: number,
    yMax: number,
    _maxPaths: number = DEFAULT_MAX_TIMELINE_PATHS
): LayoutRectangle[] {
    const yRanges = computeYRangesFromStructure(structure, segments, yMin, yMax)

    const rectangles: LayoutRectangle[] = []
    for (const seg of segments) {
        const range = resolveYRange(seg.execution_path, yRanges)
        if (!range) continue
        rectangles.push({
            segmentId: seg.id,
            executionPath: seg.execution_path,
            modelPath: seg.model_path,
            label: seg.label,
            channel: seg.channel,
            x1: seg.from,
            x2: seg.to,
            y1: range.yMin,
            y2: range.yMax,
            isInstant: seg.from === seg.to,
        })
    }
    return rectangles
}

/**
 * Walk the structure tree and assign a y-range to every node.
 *
 * The structure tree's `:branch` / `:sequence` types are unreliable: a sequence
 * containing branch descendants gets relabelled as :branch by the backend
 * (`schedule_structure.jl`'s `_subtree_has_branch` taint). We instead derive
 * the parent-child relationship from the temporal layout of the children:
 *
 * - children with disjoint time ranges → sequence (share parent's y-range,
 *   parent rows = max of children).
 * - children with overlapping time ranges → branch (split parent's y-range,
 *   parent rows = sum of children).
 *
 * Instant children (from === to) have no time range and don't constrain the
 * relationship; they're laid out using the same rule as their siblings.
 */
function computeYRangesFromStructure(
    structure: StructureNode,
    segments: TimelineSegment[],
    yMin: number,
    yMax: number,
): Map<string, { yMin: number; yMax: number }> {
    const segmentsByPath = new Map<string, TimelineSegment[]>()
    for (const seg of segments) {
        const list = segmentsByPath.get(seg.execution_path)
        if (list) list.push(seg)
        else segmentsByPath.set(seg.execution_path, [seg])
    }

    const ranges = new Map<string, { yMin: number; yMax: number }>()
    const rowCache = new Map<StructureNode, number>()
    const rangeCache = new Map<StructureNode, { from: number; to: number } | null>()
    const parallelCache = new Map<StructureNode, boolean>()

    const nodeTimeRange = (node: StructureNode): { from: number; to: number } | null => {
        if (rangeCache.has(node)) return rangeCache.get(node)!
        let from = Infinity
        let to = -Infinity
        let has = false
        const segs = segmentsByPath.get(node.execution_path)
        if (segs) {
            for (const s of segs) {
                if (s.from < s.to) {
                    if (s.from < from) from = s.from
                    if (s.to > to) to = s.to
                    has = true
                }
            }
        }
        for (const c of node.children) {
            const r = nodeTimeRange(c)
            if (r) {
                if (r.from < from) from = r.from
                if (r.to > to) to = r.to
                has = true
            }
        }
        const result = has ? { from, to } : null
        rangeCache.set(node, result)
        return result
    }

    const childrenAreParallel = (node: StructureNode): boolean => {
        if (node.children.length < 2) return false
        const cached = parallelCache.get(node)
        if (cached !== undefined) return cached
        const childRanges: Array<{ from: number; to: number }> = []
        for (const c of node.children) {
            const r = nodeTimeRange(c)
            if (r) childRanges.push(r)
        }
        let parallel = false
        outer: for (let i = 0; i < childRanges.length; i++) {
            for (let j = i + 1; j < childRanges.length; j++) {
                const a = childRanges[i]!
                const b = childRanges[j]!
                if (a.from < b.to && b.from < a.to) {
                    parallel = true
                    break outer
                }
            }
        }
        parallelCache.set(node, parallel)
        return parallel
    }

    /** A node is "instant" if its entire subtree contains no durational segment. */
    const isInstant = (node: StructureNode): boolean => nodeTimeRange(node) === null

    const rowsNeeded = (node: StructureNode): number => {
        if (rowCache.has(node)) return rowCache.get(node)!
        let n: number
        if (node.type === 'leaf' || node.children.length === 0) {
            n = isInstant(node) ? 0 : 1
        } else if (childrenAreParallel(node)) {
            n = node.children.reduce((acc, c) => acc + rowsNeeded(c), 0)
        } else {
            n = node.children.reduce((acc, c) => Math.max(acc, rowsNeeded(c)), 0)
        }
        rowCache.set(node, n)
        return n
    }

    const assign = (node: StructureNode, lo: number, hi: number) => {
        ranges.set(node.execution_path, { yMin: lo, yMax: hi })
        if (node.type === 'leaf' || node.children.length === 0) return

        if (childrenAreParallel(node)) {
            // Allocate rows only to non-instant children. Instants borrow the
            // y-range of the nearest non-instant sibling (next preferred).
            const nonInstantTotal = node.children.reduce((acc, c) => acc + rowsNeeded(c), 0) || 1
            const rowH = (hi - lo) / nonInstantTotal
            const allocated = new Map<StructureNode, { lo: number; hi: number }>()
            let top = hi
            for (const child of node.children) {
                const childRows = rowsNeeded(child)
                if (childRows === 0) continue
                const childH = childRows * rowH
                allocated.set(child, { lo: top - childH, hi: top })
                top -= childH
            }
            for (let i = 0; i < node.children.length; i++) {
                const child = node.children[i]!
                const own = allocated.get(child)
                if (own) {
                    assign(child, own.lo, own.hi)
                    continue
                }
                // Instant child: borrow from next non-instant, then previous, then parent.
                let borrow: { lo: number; hi: number } | undefined
                for (let j = i + 1; j < node.children.length && !borrow; j++) {
                    borrow = allocated.get(node.children[j]!)
                }
                for (let j = i - 1; j >= 0 && !borrow; j--) {
                    borrow = allocated.get(node.children[j]!)
                }
                if (!borrow) borrow = { lo, hi }
                assign(child, borrow.lo, borrow.hi)
            }
        } else {
            for (const child of node.children) {
                assign(child, lo, hi)
            }
        }
    }

    assign(structure, yMin, yMax)
    return ranges
}

/**
 * Resolve a segment's execution_path to a y-range. Tries exact match first;
 * falls back to longest-prefix in the registered ranges (handles cases where
 * the segment path extends past a structure node).
 */
function resolveYRange(
    execPath: string,
    ranges: Map<string, { yMin: number; yMax: number }>,
): { yMin: number; yMax: number } | undefined {
    const exact = ranges.get(execPath)
    if (exact) return exact
    let best: { yMin: number; yMax: number } | undefined
    let bestLen = -1
    for (const [path, range] of ranges) {
        if (execPath.startsWith(path) && path.length > bestLen) {
            bestLen = path.length
            best = range
        }
    }
    return best
}

/**
 * Returns the y-range for every execution path in the structure tree.
 * Used by callers (e.g. axis labels) that need positions independent of segments.
 */
export function collectPathYRanges(
    structure: StructureNode,
    yMin: number = 0,
    yMax: number = 1,
    segments?: TimelineSegment[],
    _maxPaths: number = DEFAULT_MAX_TIMELINE_PATHS,
): Map<string, { yMin: number; yMax: number }> {
    return computeYRangesFromStructure(structure, segments ?? [], yMin, yMax)
}
