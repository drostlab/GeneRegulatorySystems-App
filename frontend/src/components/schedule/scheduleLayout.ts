import { buildTrie, childrenAreParallel, type TrieNode } from '@/charts/layout/executionTrie'
import type { TimelineSegment } from '@/types/schedule'

export interface PositionedNode {
    path: string
    y: number
    row: number
    rowSpan: number
    collapsed: boolean
}

export interface ScheduleFork {
    path: string
    time: number
    lane: number
    fromY: number
    childYs: number[]
    childPaths: string[]
}

export interface ScheduleLayout {
    nodes: Map<string, PositionedNode>
    forks: ScheduleFork[]
    rowCount: number
    forkLaneCounts: Map<number, number>
}

/** Room for the track and a short stack of instant-event signs above it. */
export const SCHEDULE_ROW_HEIGHT = 82

function visibleChildren(node: TrieNode, collapsed: ReadonlySet<string>): TrieNode[] {
    return collapsed.has(node.path) ? [] : node.children
}

function rowsNeeded(node: TrieNode, collapsed: ReadonlySet<string>): number {
    const children = visibleChildren(node, collapsed)
    if (children.length === 0) return 1
    const rows = children.map(child => rowsNeeded(child, collapsed))
    return childrenAreParallel(node) ? rows.reduce((sum, count) => sum + count, 0) : Math.max(...rows)
}

function earliestTime(node: TrieNode, segmentsByPath: ReadonlyMap<string, TimelineSegment[]>): number {
    let earliest = Infinity
    for (const segment of segmentsByPath.get(node.path) ?? []) earliest = Math.min(earliest, segment.from)
    for (const child of node.children) earliest = Math.min(earliest, earliestTime(child, segmentsByPath))
    return earliest
}

export function groupSegmentsByPath(segments: readonly TimelineSegment[]): Map<string, TimelineSegment[]> {
    const grouped = new Map<string, TimelineSegment[]>()
    for (const segment of segments) {
        const group = grouped.get(segment.execution_path)
        if (group) group.push(segment)
        else grouped.set(segment.execution_path, [segment])
    }
    for (const group of grouped.values()) group.sort((a, b) => a.from - b.from || a.to - b.to)
    return grouped
}

export function layoutSchedule(
    segments: readonly TimelineSegment[],
    collapsed: ReadonlySet<string> = new Set(),
    eachPrefixes: readonly string[] = [],
): ScheduleLayout {
    const root = buildTrie(segments.map(segment => segment.execution_path), eachPrefixes)
    const segmentsByPath = groupSegmentsByPath(segments)
    const nodes = new Map<string, PositionedNode>()
    const forks: ScheduleFork[] = []

    function assign(node: TrieNode, firstRow: number, span: number): void {
        const children = visibleChildren(node, collapsed)
        const parallel = childrenAreParallel(node)
        // Keep the shared trunk on the top row. Parallel descendants consume
        // rows below it, so a lineage tree never forks upwards.
        const row = firstRow
        nodes.set(node.path, {
            path: node.path,
            row,
            y: (row + 1) * SCHEDULE_ROW_HEIGHT - 18,
            rowSpan: span,
            collapsed: collapsed.has(node.path) && node.children.length > 0,
        })

        if (children.length === 0) return
        if (parallel) {
            let childRow = firstRow
            for (const child of children) {
                const childSpan = rowsNeeded(child, collapsed)
                assign(child, childRow, childSpan)
                childRow += childSpan
            }
            const childYs = children.map(child => nodes.get(child.path)!.y)
            forks.push({
                path: node.path,
                time: Math.min(...children.map(child => earliestTime(child, segmentsByPath))),
                lane: 0,
                fromY: nodes.get(node.path)!.y,
                childYs,
                childPaths: children.map(child => child.path),
            })
        } else {
            for (const child of children) assign(child, firstRow, span)
        }
    }

    const rowCount = Math.max(1, rowsNeeded(root, collapsed))
    assign(root, 0, rowCount)

    const forkLaneCounts = new Map<number, number>()
    for (const fork of forks) {
        fork.lane = forks.filter(candidate =>
            candidate !== fork &&
            candidate.time === fork.time &&
            candidate.path.length < fork.path.length &&
            isPathPrefix(candidate.path, fork.path)
        ).length
        forkLaneCounts.set(fork.time, Math.max(forkLaneCounts.get(fork.time) ?? 0, fork.lane + 1))
    }
    return { nodes, forks, rowCount, forkLaneCounts }
}

function isPathPrefix(prefix: string, path: string): boolean {
    if (prefix === '' || prefix === path) return true
    if (!path.startsWith(prefix)) return false
    return ['/', '+', '-', '.'].includes(path[prefix.length] ?? '')
}

export function collapsiblePaths(segments: readonly TimelineSegment[], eachPrefixes: readonly string[] = []): string[] {
    const root = buildTrie(segments.map(segment => segment.execution_path), eachPrefixes)
    const result: string[] = []
    function visit(node: TrieNode): void {
        if (childrenAreParallel(node) && node.children.length > 1) result.push(node.path)
        node.children.forEach(visit)
    }
    visit(root)
    return result
}
