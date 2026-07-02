<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ModelActivation, ScheduleOperator, TimelineSegment } from '@/types/schedule'
import { getTimeExtent } from '@/types/schedule'
import { buildTrie, childrenAreParallel, type TrieNode } from '@/schedule/executionTrie'
import { collapsiblePaths, groupSegmentsByPath, layoutSchedule, SCHEDULE_ROW_HEIGHT } from '@/schedule/layout'
import { instantIcon } from '@/schedule/glyphs'
import { isPrefixPath, lineageChoicesForPaths, pathsShareLineage as shareLineage } from '@/schedule/paths'
import { operatorDetailLines, segmentDetailLines, textWidth } from '@/schedule/labels'
import { PURPLE, RED } from '@/config/theme'
import { useViewerStore } from '@/stores/viewerStore'

const props = defineProps<{
    segments: TimelineSegment[]
    modelActivations: ModelActivation[]
    eachPrefixes: string[]
    operators: ScheduleOperator[]
}>()
const viewerStore = useViewerStore()

const LEFT = 36
const RIGHT = 24
const TOP = 44
const AXIS_HEIGHT = 0
const MIN_VIEWPORT_WIDTH = 320
const MIN_DETAIL_WIDTH = 118
const MAX_DETAIL_WIDTH = 340
const FORK_LANE_WIDTH = 24
const PRE_FORK_SIGN_SPACING = 22
const MAX_VISIBLE_COINCIDENT_SIGNS = 3
const MAX_VISIBLE_BRANCHES = 3

const scrollRef = ref<HTMLDivElement>()
const viewportWidth = ref(760)
const viewportHeight = ref(320)
const viewportLeft = ref(0)
const viewportTop = ref(0)
const collapsed = ref(new Set<string>())
const expandedSignStacks = ref(new Set<string>())
const hoveredId = ref<number | null>(null)
const pinnedIds = ref(new Set<number>())
const hoveredPath = ref<string | null>(null)
const hoveredOperatorPath = ref<string | null>(null)
const dragging = ref(false)
let dragStartX = 0
let dragStartY = 0
let dragStartScrollLeft = 0
let dragStartScrollTop = 0

const extent = computed(() => getTimeExtent(props.segments))
const duration = computed(() => Math.max(1, extent.value.max - extent.value.min))
const width = computed(() => Math.max(MIN_VIEWPORT_WIDTH, viewportWidth.value))
const layout = computed(() => layoutSchedule(props.segments, collapsed.value, props.eachPrefixes))
const fullLayout = computed(() => layoutSchedule(props.segments, new Set(), props.eachPrefixes))
const height = computed(() => TOP + AXIS_HEIGHT + layout.value.rowCount * SCHEDULE_ROW_HEIGHT)
const forkByPath = computed(() => new Map(fullLayout.value.forks.map(fork => [fork.path, fork])))
const operatorByPath = computed(() => new Map(props.operators.map(operator => [operator.path, operator])))
const collapseControls = computed(() => {
    const controls: Array<{ key: string; path: string; paths: string[]; time: number; lane: number; operator?: ScheduleOperator }> = []
    for (const path of collapsiblePaths(props.segments, props.eachPrefixes)) {
        const fork = forkByPath.value.get(path)
        if (!fork) continue
        controls.push({ key: path, path, paths: [path], time: fork.time, lane: fork.lane, operator: operatorByPath.value.get(path) })
    }
    return controls
})

// Start large forks collapsed. The user can reveal any of them with the normal
// collapse control; three-way forks (such as ACDC) remain visible by default.
watch(() => props.segments.map(segment => segment.id).join(','), () => {
    const root = buildTrie(props.segments.map(segment => segment.execution_path), props.eachPrefixes)
    const next = new Set<string>()
    function visit(node: TrieNode): void {
        if (childrenAreParallel(node) && node.children.length > MAX_VISIBLE_BRANCHES) next.add(node.path)
        node.children.forEach(visit)
    }
    visit(root)
    collapsed.value = next
    expandedSignStacks.value = new Set()
}, { immediate: true })
const branchSpans = computed(() => [...groupSegmentsByPath(props.segments).entries()].flatMap(([path, segments]) => {
    const durations = segments.filter(segment => segment.from < segment.to)
    if (durations.length === 0) return []

    // A path can recur after another path has occupied the same rendered row.
    // Keep those runs separate so its invisible hit target does not cover the
    // intervening branch and report the wrong lineage.
    const spans: Array<{ path: string; from: number; to: number; firstId: number; interactive: true }> = []
    for (const segment of durations) {
        const previous = spans.at(-1)
        if (previous && segment.from <= previous.to + 1e-9) {
            previous.to = Math.max(previous.to, segment.to)
        } else {
            spans.push({
                path,
                from: segment.from,
                to: segment.to,
                firstId: segment.id,
                interactive: true,
            })
        }
    }
    return spans
}))
const hoveredBranch = computed(() => branchSpans.value.find(branch => branch.path === hoveredPath.value) ?? null)
const hoveredOperator = computed(() => hoveredOperatorPath.value === null
    ? null
    : operatorByPath.value.get(hoveredOperatorPath.value) ?? null)
const hoveredControl = computed(() => collapseControls.value.find(control => control.path === hoveredOperatorPath.value) ?? null)

// A lineage is the set of choices made at parallel trie nodes. Sequence/scope
// descendants retain the same choices, so differently named sequential paths
// still belong to one lineage while sibling branches are incompatible.
const lineageChoices = computed(() => {
    return lineageChoicesForPaths(props.segments.map(segment => segment.execution_path), props.eachPrefixes)
})

const hoveredLineageInfo = computed(() => {
    const path = hoveredPath.value
    if (path === null) return null
    const choices = props.operators.flatMap(operator => operator.child_paths.map((childPath, index) => ({
        operator,
        childPath,
        index,
    }))).filter(candidate => isPrefixPath(candidate.childPath, path))
        .sort((a, b) => a.childPath.length - b.childPath.length)
    const pathSegments = props.segments.filter(segment => segment.execution_path === path)
    const scopeLabel = pathSegments.find(segment => segment.scope_label)?.scope_label ?? ''
    const bindingLines = new Map<string, string>()
    for (const segment of pathSegments) {
        for (const [key, value] of Object.entries(segment.bindings ?? {})) {
            if (!value || bindingLines.has(key)) continue
            bindingLines.set(key, `${key}: ${value}`)
        }
    }
    const lines: string[] = []
    if (!scopeLabel) {
        const childLabel = choices.at(-1)?.operator.child_labels[choices.at(-1)!.index] ?? ''
        if (childLabel) lines.push(`label: ${childLabel}`)
    }
    for (const choice of choices) {
        const value = choice.operator.child_values[choice.index] ?? ''
        if (choice.operator.binding && value) {
            const line = `${choice.operator.binding.toLocaleLowerCase()}: ${value}`
            if (!lines.includes(line)) lines.push(line)
        }
    }
    if (scopeLabel) lines.unshift(`label: ${scopeLabel}`)
    lines.push(...bindingLines.values())
    lines.push(path)
    return { path, lines }
})

const collapsedSummaries = computed(() => {
    const summaries = new Map<string, { path: string; from: number; to: number; lane: number; time: number }>()
    for (const path of collapsed.value) {
        const descendants = props.segments.filter(segment => isPrefixPath(path, segment.execution_path))
        const summary = {
        path,
        from: descendants.length ? Math.min(...descendants.map(segment => segment.from)) : extent.value.min,
        to: descendants.length ? Math.max(...descendants.map(segment => segment.to)) : extent.value.max,
        lane: forkByPath.value.get(path)?.lane ?? 0,
        time: forkByPath.value.get(path)?.time ?? extent.value.min,
        }
        const row = layout.value.nodes.get(path)?.row ?? 0
        summaries.set(`${row}\u0000${summary.from}\u0000${summary.to}`, summary)
    }
    return [...summaries.values()]
})

interface StackedSign<T extends TimelineSegment = TimelineSegment> {
    segment: T
    index: number
    stackKey: string
    stackSize: number
}

function stacked<T extends TimelineSegment>(segments: T[]): StackedSign<T>[] {
    const counts = new Map<string, number>()
    const positioned = segments.map(segment => {
        const row = layout.value.nodes.get(segment.execution_path)?.row ?? segment.execution_path
        const stackKey = `${row}\u0000${segmentX(segment).toFixed(3)}`
        const index = counts.get(stackKey) ?? 0
        counts.set(stackKey, index + 1)
        return { segment, index, stackKey }
    })
    return positioned.map(sign => ({ ...sign, stackSize: counts.get(sign.stackKey) ?? 1 }))
}

// Instant models are execution events in the segment stream. Duration-model
// flags come from explicit backend activation records, which retain the scope
// where `do` became active even when the first timed work occurs below a fork.
const executionModels = computed(() => {
    const instants = props.segments.filter(segment => segment.from === segment.to)
    const durations = props.modelActivations.flatMap(activation => {
        const segment = props.segments.find(candidate => candidate.id === activation.segment_id)
        return segment ? [{
            ...segment,
            execution_path: activation.execution_path,
            from: activation.at,
        }] : []
    })
    return [...instants, ...durations].sort((a, b) => a.id - b.id)
})

const forkGroups = computed(() => [...fullLayout.value.forkLaneCounts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, lanes]) => {
        const forks = fullLayout.value.forks.filter(fork => fork.time === time)
        const firstDescendantId = Math.min(...forks.flatMap(fork => props.segments
            .filter(segment => isPrefixPath(fork.path, segment.execution_path))
            .map(segment => segment.id)))
        const preSigns = executionModels.value
            .filter(segment =>
                (segment.from === time && segment.to === time && segment.id < firstDescendantId) ||
                (segment.from < segment.to && forks.some(fork => fork.path === segment.execution_path)))
            .map(segment => ({ segment, index: 0 }))
        return { time, lanes, preSigns, preWidth: preSigns.length * PRE_FORK_SIGN_SPACING }
    }))
// Stack only signs that land on the same rendered pole. Structural fork gutters
// can separate events with the same simulation time, as in ACDC's bootstrap.
const allSigns = computed(() => stacked(executionModels.value))
const signs = computed(() => allSigns.value.filter(sign =>
    sign.index < MAX_VISIBLE_COINCIDENT_SIGNS || expandedSignStacks.value.has(sign.stackKey)))
const signStackSummaries = computed(() => {
    const summaries = new Map<string, StackedSign>()
    for (const sign of allSigns.value) {
        if (sign.stackSize <= MAX_VISIBLE_COINCIDENT_SIGNS || expandedSignStacks.value.has(sign.stackKey)) continue
        if (!summaries.has(sign.stackKey)) summaries.set(sign.stackKey, sign)
    }
    return [...summaries.values()].map(sign => ({
        ...sign,
        hiddenCount: sign.stackSize - MAX_VISIBLE_COINCIDENT_SIGNS,
        index: MAX_VISIBLE_COINCIDENT_SIGNS,
    }))
})
// SVG uses document order for layering. Paint duration poles first so an
// instant-model pole at the same position remains visibly in front.
const signsInPolePaintOrder = computed(() => [...signs.value].sort((a, b) =>
    Number(b.segment.from < b.segment.to) - Number(a.segment.from < a.segment.to)))
const preludeLines = computed(() => forkGroups.value.flatMap(group => {
    if (group.preSigns.length === 0) return []
    const first = group.preSigns[0]!.segment
    return [{
        key: `prelude-${group.time}`,
        path: first.execution_path,
        x1: segmentX(first),
        x2: forkX(group.time, 0),
        y: segmentY(first),
    }]
}))
const displayedSigns = computed(() => {
    const ids = new Set(pinnedIds.value)
    if (hoveredId.value !== null) ids.add(hoveredId.value)
    return signs.value.filter(({ segment }) => ids.has(segment.id))
})
const displayedModelExtents = computed(() => displayedSigns.value
    .filter(({ segment }) => segment.from < segment.to)
    .map(({ segment }) => ({ owner: segment.id, segments: modelExtent(segment) })))
const displayedModelPreludes = computed(() => displayedSigns.value.flatMap(({ segment }) => {
    if (segment.from >= segment.to) return []
    const group = forkGroups.value.find(candidate =>
        candidate.preSigns.some(sign => sign.segment.id === segment.id))
    return group ? [{
        owner: segment.id,
        x1: segmentX(segment),
        x2: forkX(group.time, 0),
        y: segmentY(segment),
    }] : []
}))
const displayedModelForks = computed(() => displayedModelExtents.value.flatMap(extent => fullLayout.value.forks.flatMap(fork =>
    fork.childPaths.flatMap((childPath, index) => {
        const activation = props.modelActivations.find(candidate => candidate.segment_id === extent.owner)
        const enters = extent.segments.some(segment =>
            Math.abs(segment.from - fork.time) < 1e-9 && pathsShareLineage(segment.execution_path, childPath))
        const leaves = extent.segments.some(segment =>
            Math.abs(segment.to - fork.time) < 1e-9 && pathsShareLineage(segment.execution_path, fork.path))
        const startsWithinActivationScope = activation !== undefined &&
            Math.abs(activation.at - fork.time) < 1e-9 &&
            isPrefixPath(activation.execution_path, fork.path)
        return enters && (leaves || startsWithinActivationScope)
            ? [{ owner: extent.owner, fork, childPath, childY: fork.childYs[index]! }]
            : []
    })
)))
const detailPlacements = computed(() => {
    return displayedSigns.value.map(({ segment, index }) => {
        const tooltipWidth = detailWidth(segment)
        const tooltipHeight = detailHeight(segment, tooltipWidth)
        // Anchor every detail directly to its sign instead of moving it around
        // to avoid other open details. The mast becomes its left edge and the
        // lineage track its stable vertical reference.
        return {
            segment,
            stackIndex: index,
            x: segmentX(segment),
            y: segmentY(segment) + 12,
            width: tooltipWidth,
            height: tooltipHeight,
        }
    })
})

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
    resizeObserver = new ResizeObserver(entries => {
        const measured = entries[0]?.contentRect.width
        if (measured) viewportWidth.value = Math.max(MIN_VIEWPORT_WIDTH, measured)
        const measuredHeight = entries[0]?.contentRect.height
        if (measuredHeight) viewportHeight.value = measuredHeight
    })
    if (scrollRef.value) resizeObserver.observe(scrollRef.value)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
watch(() => props.segments, () => {
    collapsed.value = new Set()
    pinnedIds.value = new Set()
    hoveredId.value = null
    hoveredPath.value = null
    hoveredOperatorPath.value = null
    if (scrollRef.value) scrollRef.value.scrollLeft = 0
})

// SciChart and the schedule publish hover through the same store. Reflect an
// externally hovered trajectory back onto the lineage geometry and tooltip.
watch(() => viewerStore.hoveredExecutionPath, path => {
    hoveredPath.value = path
    if (path === null) hoveredOperatorPath.value = null
})

function x(time: number): number {
    const physicalWidth = Math.max(1, width.value - LEFT - RIGHT - totalStructuralWidth())
    const elapsed = ((time - extent.value.min) / duration.value) * physicalWidth
    const structural = forkGroups.value
        .filter(group => group.time <= time)
        .reduce((sum, group) => sum + group.preWidth + group.lanes * FORK_LANE_WIDTH, 0)
    return LEFT + elapsed + structural
}

function totalStructuralWidth(): number {
    return forkGroups.value.reduce((sum, group) => sum + group.preWidth + group.lanes * FORK_LANE_WIDTH, 0)
}

function eventStartX(time: number): number {
    const physicalWidth = Math.max(1, width.value - LEFT - RIGHT - totalStructuralWidth())
    const elapsed = ((time - extent.value.min) / duration.value) * physicalWidth
    const preceding = forkGroups.value
        .filter(group => group.time < time)
        .reduce((sum, group) => sum + group.preWidth + group.lanes * FORK_LANE_WIDTH, 0)
    return LEFT + elapsed + preceding
}

function forkX(time: number, lane: number): number {
    const group = forkGroups.value.find(candidate => candidate.time === time)
    return eventStartX(time) + (group?.preWidth ?? 0) + lane * FORK_LANE_WIDTH
}

function segmentX(segment: TimelineSegment): number {
    const group = forkGroups.value.find(candidate => candidate.time === segment.from)
    const index = group?.preSigns.findIndex(sign => sign.segment.id === segment.id) ?? -1
    return index >= 0 ? eventStartX(segment.from) + 7 + index * PRE_FORK_SIGN_SPACING : x(segment.from)
}

function branchStartX(branch: typeof branchSpans.value[number]): number {
    const first = props.segments.find(segment => segment.id === branch.firstId)
    return Math.max(first ? segmentX(first) : x(branch.from), incomingSplineX(branch.path) ?? -Infinity)
}

function branchEndX(branch: typeof branchSpans.value[number]): number {
    const outgoingFork = fullLayout.value.forks
        .filter(fork =>
            Math.abs(fork.time - branch.to) < 1e-9 &&
            Math.abs(TOP + AXIS_HEIGHT + fork.fromY - nodeY(branch.path)) < 1e-9 &&
            pathsShareLineage(branch.path, fork.path)
        )
        .sort((a, b) => a.lane - b.lane)[0]
    const end = outgoingFork ? forkX(outgoingFork.time, outgoingFork.lane) : x(branch.to)
    return Math.max(branchStartX(branch) + 2, end)
}

function segmentEndX(segment: TimelineSegment): number {
    const outgoingFork = fullLayout.value.forks
        .filter(fork =>
            Math.abs(fork.time - segment.to) < 1e-9 &&
            Math.abs(TOP + AXIS_HEIGHT + fork.fromY - segmentY(segment)) < 1e-9 &&
            pathsShareLineage(segment.execution_path, fork.path)
        )
        .sort((a, b) => a.lane - b.lane)[0]
    return outgoingFork ? forkX(outgoingFork.time, outgoingFork.lane) : x(segment.to)
}

function onScroll(): void {
    if (!scrollRef.value) return
    viewportLeft.value = scrollRef.value.scrollLeft
    viewportTop.value = scrollRef.value.scrollTop
}

function clampTooltipX(preferred: number, tooltipWidth: number): number {
    const min = viewportLeft.value + 4
    const max = Math.max(min, Math.min(width.value - tooltipWidth - 4, viewportLeft.value + viewportWidth.value - tooltipWidth - 4))
    return Math.max(min, Math.min(max, preferred))
}

function clampTooltipY(preferred: number, tooltipHeight: number): number {
    const min = viewportTop.value + 4
    const max = Math.max(min, Math.min(height.value - tooltipHeight - 4, viewportTop.value + viewportHeight.value - tooltipHeight - 4))
    return Math.max(min, Math.min(max, preferred))
}

function onWheel(event: WheelEvent): void {
    const scroller = scrollRef.value
    if (!scroller) return
    // A wheel always moves through schedule rows. In particular, Shift must not
    // silently turn the gesture into horizontal scrolling.
    scroller.scrollTop += event.deltaY || event.deltaX
}

function onPointerDown(event: PointerEvent): void {
    const target = event.target as Element | null
    if (event.button !== 0 || target?.closest('.primitive-sign, .collapse-control, .detail-flag, .lineage-branch, .lineage-hit, .collapsed-summary, .fork path')) return
    const scroller = scrollRef.value
    if (!scroller) return
    const canPan = scroller.scrollWidth > scroller.clientWidth || scroller.scrollHeight > scroller.clientHeight
    if (!canPan) return
    dragging.value = true
    dragStartX = event.clientX
    dragStartY = event.clientY
    dragStartScrollLeft = scroller.scrollLeft
    dragStartScrollTop = scroller.scrollTop
    scroller.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
    if (!dragging.value || !scrollRef.value) return
    scrollRef.value.scrollLeft = dragStartScrollLeft - (event.clientX - dragStartX)
    scrollRef.value.scrollTop = dragStartScrollTop - (event.clientY - dragStartY)
}

function stopDragging(event: PointerEvent): void {
    if (!dragging.value) return
    dragging.value = false
    scrollRef.value?.releasePointerCapture(event.pointerId)
}

function groupCollapsed(paths: string[]): boolean {
    return paths.every(path => collapsed.value.has(path))
}

function toggleCollapseGroup(paths: string[]): void {
    const next = new Set(collapsed.value)
    if (groupCollapsed(paths)) paths.forEach(path => next.delete(path))
    else paths.forEach(path => next.add(path))
    collapsed.value = next
}

function togglePinned(id: number): void {
    const next = new Set(pinnedIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    pinnedIds.value = next
}

function expandSignStack(stackKey: string): void {
    expandedSignStacks.value = new Set(expandedSignStacks.value).add(stackKey)
}

function hoverLineage(path: string, operatorPath: string | null = null): void {
    hoveredPath.value = path
    hoveredOperatorPath.value = operatorPath
    viewerStore.setHoveredRectModel(null, path)
    viewerStore.setHoveredOperator(operatorPath)
}

function hoverSpline(path: string): void {
    hoveredPath.value = path
    hoveredOperatorPath.value = null
    viewerStore.setHoveredRectModel(null, path)
    viewerStore.setHoveredOperator(null)
}

function clearLineageHover(): void {
    hoveredPath.value = null
    hoveredOperatorPath.value = null
    viewerStore.setHoveredRectModel(null, null)
    viewerStore.setHoveredOperator(null)
}

function hoverModel(segment: TimelineSegment): void {
    hoveredId.value = segment.id
    viewerStore.setHoveredRectModel(segment.from < segment.to ? segment.model_path : null, segment.execution_path)
    viewerStore.setHoveredInstantModel(segment.from === segment.to ? segment.model_path : null)
    viewerStore.setHoveredOperator(null)
}

function clearModelHover(): void {
    hoveredId.value = null
    viewerStore.setHoveredRectModel(null, null)
    viewerStore.setHoveredInstantModel(null)
}

function nodeY(path: string): number {
    return TOP + AXIS_HEIGHT + (layout.value.nodes.get(path)?.y ?? 0)
}

function segmentY(segment: TimelineSegment): number {
    return nodeY(segment.execution_path)
}

function pathVisible(path: string): boolean {
    for (const collapsedPath of collapsed.value) {
        if (path !== collapsedPath && isPrefixPath(collapsedPath, path)) return false
    }
    return true
}

function pathRelated(a: string, b: string): boolean {
    return pathsShareLineage(a, b)
}

function pathsShareLineage(a: string, b: string): boolean {
    return shareLineage(a, b, lineageChoices.value)
}

function pathClass(path: string): Record<string, boolean> {
    const selected = viewerStore.selectedLineagePath !== null
        && pathsShareLineage(viewerStore.selectedLineagePath, path)
    const hasHover = hoveredPath.value !== null
    return {
        highlighted: hasHover && pathRelated(hoveredPath.value!, path),
        selected,
        dimmed: hasHover
            ? !pathRelated(hoveredPath.value!, path)
            : viewerStore.selectedLineagePath !== null && !selected,
    }
}

function modelExtent(seed: TimelineSegment): TimelineSegment[] {
    const candidates = props.segments.filter(segment =>
        segment.from < segment.to && segment.model_path === seed.model_path)
    const activation = props.modelActivations.find(candidate => candidate.segment_id === seed.id)
    const roots = activation
        ? candidates.filter(candidate =>
            Math.abs(candidate.from - activation.at) < 1e-9 &&
            isPrefixPath(activation.execution_path, candidate.execution_path))
        : candidates.filter(candidate => candidate.id === seed.id)
    const connected = new Set<number>(roots.map(candidate => candidate.id))
    let changed = true
    while (changed) {
        changed = false
        for (const candidate of candidates) {
            if (connected.has(candidate.id)) continue
            const touches = candidates.some(member => connected.has(member.id) &&
                pathsShareLineage(member.execution_path, candidate.execution_path) &&
                Math.max(member.from, candidate.from) <= Math.min(member.to, candidate.to) + 1e-9)
            if (touches) {
                connected.add(candidate.id)
                changed = true
            }
        }
    }
    return candidates.filter(segment => connected.has(segment.id))
}

function detailLines(segment: TimelineSegment): string[] {
    return segmentDetailLines(segment)
}

function operatorLines(operator: ScheduleOperator): string[] {
    return operatorDetailLines(operator)
}

function detail(segment: TimelineSegment): string {
    return detailLines(segment).join('\n')
}

function detailWidth(segment: TimelineSegment): number {
    const longest = Math.max(...detailLines(segment).flatMap(line => line.split('\n')).map(line => line.length), 1)
    return Math.max(MIN_DETAIL_WIDTH, Math.min(MAX_DETAIL_WIDTH, longest * 8.2 + 28))
}

function detailHeight(segment: TimelineSegment, tooltipWidth: number): number {
    const charactersPerLine = Math.max(12, Math.floor((tooltipWidth - 24) / 8.2))
    const visualLines = detail(segment).split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charactersPerLine)), 0)
    return Math.min(Math.max(54, visualLines * 16 + 12), Math.max(54, viewportHeight.value - 8))
}

function overlayStyle(x: number, y: number, width: number, maxHeight?: number): Record<string, string> {
    return {
        left: `${x - viewportLeft.value}px`,
        top: `${y - viewportTop.value}px`,
        width: `${width}px`,
        ...(maxHeight ? { maxHeight: `${maxHeight}px` } : {}),
    }
}

function signY(segment: TimelineSegment, index: number): number {
    return segmentY(segment) - 18 - index * 18
}

function forkExitX(fork: typeof layout.value.forks[number], childPath: string): number {
    // Collapse changes visibility, never geometry: parent splines must continue
    // to land on the hidden fork's stable origin where its summary begins.
    const nextFork = fullLayout.value.forks
        .filter(candidate => candidate.time === fork.time && isPrefixPath(childPath, candidate.path))
        .sort((a, b) => a.path.length - b.path.length)[0]
    return nextFork ? forkX(nextFork.time, nextFork.lane) : x(fork.time)
}

function incomingSplineX(path: string): number | null {
    const incoming = fullLayout.value.forks.flatMap(fork => fork.childPaths
        .filter(childPath => isPrefixPath(childPath, path))
        .map(childPath => ({ fork, childPath })))
        .sort((a, b) => b.childPath.length - a.childPath.length)[0]
    return incoming ? forkExitX(incoming.fork, incoming.childPath) : null
}

function forkPath(fork: typeof layout.value.forks[number], childY: number, childPath: string): string {
    const x1 = forkX(fork.time, fork.lane)
    const x2 = forkExitX(fork, childPath)
    const y1 = TOP + AXIS_HEIGHT + fork.fromY
    const y2 = TOP + AXIS_HEIGHT + childY
    const bend = Math.max(6, (x2 - x1) * .52)
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}
</script>

<template>
    <section
        class="schedule-view"
        :style="{
            '--schedule-purple': PURPLE[400],
            '--schedule-red': RED[400],
        }"
    >
        <div
            ref="scrollRef"
            class="schedule-scroll"
            :class="{ dragging }"
            @scroll="onScroll"
            @wheel.prevent="onWheel"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="stopDragging"
            @pointercancel="stopDragging"
        >
            <svg
                v-if="segments.length"
                :viewBox="`0 0 ${width} ${height}`"
                :width="width"
                :height="height"
                role="img"
                aria-label="Schedule lineage"
            >
                <line
                    v-for="prelude in preludeLines"
                    :key="prelude.key"
                    class="lineage-branch prelude-line"
                    :class="pathClass(prelude.path)"
                    :x1="prelude.x1" :x2="prelude.x2"
                    :y1="prelude.y" :y2="prelude.y"
                    @mouseenter="hoverLineage(prelude.path)"
                    @mouseleave="clearLineageHover"
                    @click.stop="viewerStore.selectLineage(prelude.path)"
                />
                <g v-for="fork in layout.forks" :key="fork.path" class="fork">
                    <template v-if="Number.isFinite(fork.time)">
                        <path
                            v-for="(childY, index) in fork.childYs"
                            :key="fork.childPaths[index]"
                            :class="pathClass(fork.childPaths[index]!)"
                            :d="forkPath(fork, childY, fork.childPaths[index]!)"
                            @mouseenter="hoverSpline(fork.childPaths[index]!)"
                            @mouseleave="clearLineageHover"
                            @click.stop="viewerStore.selectLineage(fork.childPaths[index]!)"
                        />
                    </template>
                </g>

                <g
                    v-for="branch in branchSpans"
                    v-show="pathVisible(branch.path)"
                    :key="`${branch.path}-${branch.from}-${branch.to}`"
                    :class="pathClass(branch.path)"
                    @mouseenter="branch.interactive && hoverLineage(branch.path)"
                    @mouseleave="clearLineageHover"
                    @click.stop="viewerStore.selectLineage(branch.path)"
                >
                    <line
                        class="lineage-branch"
                        :x1="branchStartX(branch)" :x2="branchEndX(branch)"
                        :y1="nodeY(branch.path)" :y2="nodeY(branch.path)"
                    />
                    <line
                        class="lineage-hit"
                        :x1="branchStartX(branch)" :x2="branchEndX(branch)"
                        :y1="nodeY(branch.path)" :y2="nodeY(branch.path)"
                    />
                </g>

                <g v-if="hoveredBranch && hoveredId === null" class="lineage-detail">
                    <line
                        class="segment-hover-highlight"
                        :x1="branchStartX(hoveredBranch)" :x2="branchEndX(hoveredBranch)"
                        :y1="nodeY(hoveredBranch.path)" :y2="nodeY(hoveredBranch.path)"
                    />
                    <line class="lineage-leader" :x1="branchStartX(hoveredBranch)" :y1="nodeY(hoveredBranch.path)" :x2="branchStartX(hoveredBranch)" :y2="nodeY(hoveredBranch.path) + 16" />
                </g>

                <g
                    v-for="summary in collapsedSummaries"
                    :key="`summary-${summary.path}`"
                    :class="pathClass(summary.path)"
                    @mouseenter="hoverLineage(summary.path)"
                    @mouseleave="clearLineageHover"
                    @click.stop="viewerStore.selectLineage(summary.path)"
                >
                    <line
                        class="collapsed-summary"
                        :x1="forkX(summary.time, summary.lane)"
                        :x2="Math.max(forkX(summary.time, summary.lane) + 2, x(summary.to))"
                        :y1="nodeY(summary.path)"
                        :y2="nodeY(summary.path)"
                    />
                    <line
                        class="lineage-hit"
                        :x1="forkX(summary.time, summary.lane)"
                        :x2="Math.max(forkX(summary.time, summary.lane) + 2, x(summary.to))"
                        :y1="nodeY(summary.path)"
                        :y2="nodeY(summary.path)"
                    />
                </g>

                <g v-for="extent in displayedModelExtents" :key="`extent-${extent.owner}`" class="duration-highlight">
                    <line
                        v-for="segment in extent.segments"
                        v-show="pathVisible(segment.execution_path)"
                        :key="`extent-${extent.owner}-${segment.id}`"
                        :x1="x(segment.from)" :x2="segmentEndX(segment)"
                        :y1="segmentY(segment)" :y2="segmentY(segment)"
                    />
                </g>
                <g class="duration-highlight model-prelude-highlight">
                    <line
                        v-for="prelude in displayedModelPreludes"
                        :key="`extent-prelude-${prelude.owner}`"
                        :x1="prelude.x1" :x2="prelude.x2"
                        :y1="prelude.y" :y2="prelude.y"
                    />
                </g>
                <g class="duration-highlight model-fork-highlight">
                    <path
                        v-for="connection in displayedModelForks"
                        :key="`extent-fork-${connection.owner}-${connection.childPath}`"
                        :d="forkPath(connection.fork, connection.childY, connection.childPath)"
                    />
                </g>

                <!-- Poles are one shared back layer so stacked signs always mask them. -->
                <g class="sign-poles">
                    <g
                        v-for="{ segment, index } in signsInPolePaintOrder"
                        v-show="pathVisible(segment.execution_path)"
                        :key="`pole-${segment.id}`"
                        class="sign-pole-group"
                        :class="[segment.from < segment.to ? 'duration-sign' : 'instant-sign', pathClass(segment.execution_path), { active: hoveredId === segment.id || pinnedIds.has(segment.id) }]"
                    >
                        <line class="sign-pole" :x1="segmentX(segment)" :x2="segmentX(segment)" :y1="segment.from < segment.to ? signY(segment, index) - 7 : signY(segment, index) + 7" :y2="segmentY(segment)" />
                    </g>
                </g>

                <g
                    v-for="{ segment, index } in signs"
                    v-show="pathVisible(segment.execution_path)"
                    :key="segment.id"
                    class="primitive-sign"
                    :class="[segment.from < segment.to ? 'duration-sign' : 'instant-sign', pathClass(segment.execution_path), { active: hoveredId === segment.id || pinnedIds.has(segment.id), pinned: pinnedIds.has(segment.id) }]"
                    @mouseenter="hoverModel(segment)"
                    @mouseleave="clearModelHover"
                    @click.stop="togglePinned(segment.id)"
                >
                    <template v-if="segment.from < segment.to">
                        <path class="play-flag" :d="`M ${segmentX(segment)} ${signY(segment, index) - 7} L ${segmentX(segment) + 10} ${signY(segment, index) - 1} L ${segmentX(segment)} ${signY(segment, index) + 5} Z`" />
                    </template>
                    <template v-else>
                        <circle :cx="segmentX(segment)" :cy="signY(segment, index)" r="7" />
                        <template v-if="segment.model_type === 'Adjust'">
                            <line class="plus" :x1="segmentX(segment) - 3" :x2="segmentX(segment) + 3" :y1="signY(segment, index)" :y2="signY(segment, index)" />
                            <line class="plus" :x1="segmentX(segment)" :x2="segmentX(segment)" :y1="signY(segment, index) - 3" :y2="signY(segment, index) + 3" />
                        </template>
                        <foreignObject v-else :x="segmentX(segment) - 5" :y="signY(segment, index) - 5" width="10" height="10">
                            <div class="instant-icon"><i :class="instantIcon(segment.model_type)" /></div>
                        </foreignObject>
                    </template>
                </g>

                <g
                    v-for="summary in signStackSummaries"
                    v-show="pathVisible(summary.segment.execution_path)"
                    :key="`sign-summary-${summary.stackKey}`"
                    class="sign-stack-summary"
                    :transform="`translate(${segmentX(summary.segment)} ${signY(summary.segment, summary.index)})`"
                    @click.stop="expandSignStack(summary.stackKey)"
                >
                    <circle r="8" />
                    <text text-anchor="middle" dominant-baseline="central">+{{ summary.hiddenCount }}</text>
                    <title>{{ summary.hiddenCount }} more signs — click to show</title>
                </g>

                <g
                    v-for="control in collapseControls"
                    :key="`collapse-${control.path}`"
                    v-show="pathVisible(control.path)"
                    class="collapse-control"
                    :transform="`translate(${forkX(control.time, control.lane)} ${TOP + AXIS_HEIGHT + (layout.nodes.get(control.path)?.y ?? fullLayout.nodes.get(control.path)?.y ?? 0)})`"
                    @mouseenter="hoverLineage(control.path, control.operator ? control.path : null)"
                    @mouseleave="clearLineageHover"
                    @click.stop="toggleCollapseGroup(control.paths)"
                >
                    <circle class="collapse-icon" cx="0" cy="0" r="7" />
                    <path
                        class="collapse-chevron"
                        :d="groupCollapsed(control.paths)
                            ? 'M -2.5 -3.5 L 1.5 0 L -2.5 3.5'
                            : 'M -3.5 -2.5 L 0 1.5 L 3.5 -2.5'"
                    />
                </g>

                <g v-for="placement in detailPlacements" v-show="pathVisible(placement.segment.execution_path)" :key="`detail-${placement.segment.id}`" class="detail-flag" :class="placement.segment.from < placement.segment.to ? 'duration-detail' : 'instant-detail'">
                    <line class="flag-leader" :x1="segmentX(placement.segment)" :y1="signY(placement.segment, placement.stackIndex) + (placement.segment.from < placement.segment.to ? 5 : 7)" :x2="placement.x" :y2="placement.y + 4" />
                </g>
            </svg>
            <div v-else class="schedule-empty">No schedule segments</div>
        </div>
        <div class="schedule-overlays">
            <div
                v-if="hoveredBranch && hoveredLineageInfo && hoveredId === null"
                class="grs-tooltip schedule-tooltip lineage-tooltip overlay-tooltip"
                :style="overlayStyle(
                    branchStartX(hoveredBranch),
                    nodeY(hoveredBranch.path) + 12,
                    textWidth(hoveredLineageInfo.lines),
                )"
            >
                <div v-for="line in hoveredLineageInfo.lines" :key="line">{{ line }}</div>
            </div>
            <div
                v-if="hoveredOperator && hoveredControl"
                class="grs-tooltip schedule-tooltip operator-tooltip overlay-tooltip"
                :style="overlayStyle(
                    clampTooltipX(forkX(hoveredControl.time, hoveredControl.lane) + 10, textWidth(operatorLines(hoveredOperator))),
                    clampTooltipY(nodeY(hoveredControl.path) - 54, 48),
                    textWidth(operatorLines(hoveredOperator)),
                )"
            >
                <div
                    v-for="(line, index) in operatorLines(hoveredOperator)"
                    :key="line"
                    :class="{ 'tooltip-detail-line': index > 0 && index < operatorLines(hoveredOperator).length - 1 }"
                >{{ line }}</div>
            </div>
            <div
                v-for="placement in detailPlacements"
                v-show="pathVisible(placement.segment.execution_path)"
                :key="`overlay-detail-${placement.segment.id}`"
                class="detail-overlay"
                :class="placement.segment.from < placement.segment.to ? 'duration-detail' : 'instant-detail'"
                :style="overlayStyle(placement.x, placement.y, placement.width, placement.height)"
            >
                <div class="grs-tooltip schedule-tooltip overlay-tooltip model-tooltip">
                    <div
                        v-for="(line, index) in detailLines(placement.segment)"
                        :key="`${placement.segment.id}-${index}`"
                        :class="{ 'tooltip-detail-line': index > 0 && index < detailLines(placement.segment).length - 1 }"
                    >{{ line }}</div>
                </div>
            </div>
        </div>
    </section>
</template>

<style scoped>
.schedule-view { position: relative; display: flex; flex-direction: column; color: var(--p-text-color); background: transparent; border: 1px solid var(--p-surface-border); border-radius: 10px; overflow: hidden; }
.schedule-scroll { flex: 1; min-height: 0; min-width: 0; overflow: scroll; scrollbar-gutter: stable; background: transparent; cursor: grab; }.schedule-scroll.dragging { cursor: grabbing; }
.schedule-scroll::-webkit-scrollbar { width: 11px; height: 11px; }.schedule-scroll::-webkit-scrollbar-track { background: var(--p-surface-100); }.schedule-scroll::-webkit-scrollbar-thumb { background: var(--p-surface-400); border: 2px solid var(--p-surface-100); border-radius: 8px; }
svg { display: block; font-family: Montserrat, sans-serif; }
.fork path, .lineage-branch { stroke: var(--p-surface-400); fill: none; transition: opacity .12s, stroke .12s, stroke-width .12s; }.fork path { stroke-width: 2.2; stroke-linecap: round; }.lineage-branch { stroke-width: 2.2; stroke-linecap: round; pointer-events: stroke; }
.fork path.highlighted, .fork path.selected, .lineage-branch.highlighted, .lineage-branch.selected, g.highlighted .lineage-branch, g.highlighted .collapsed-summary, g.selected .lineage-branch, g.selected .collapsed-summary { stroke: var(--p-surface-700); stroke-width: 4.5; }.fork path.dimmed, .lineage-branch.dimmed, g.dimmed .lineage-branch, g.dimmed .collapsed-summary, .primitive-sign.dimmed, .sign-pole-group.dimmed { opacity: .3; }
.lineage-hit { stroke: transparent; stroke-width: 14; pointer-events: stroke; }
.collapsed-summary { stroke: var(--p-surface-400); stroke-width: 2; stroke-linecap: round; }
.primitive-sign { cursor: pointer; transition: opacity .12s; }.sign-pole-group { transition: opacity .12s; }.sign-pole-group .sign-pole { stroke-width: 2.2; stroke-linecap: round; }.primitive-sign circle { stroke-width: 1.4; transition: .1s; }
.duration-sign > line { stroke: var(--schedule-purple); }.duration-sign .play-flag { fill: var(--schedule-purple); stroke: none; }
.duration-sign.active .play-flag { fill: var(--schedule-purple); stroke-width: 2; }
.instant-sign .sign-pole { stroke: var(--schedule-red); }.instant-sign circle { fill: color-mix(in srgb, var(--schedule-red) 82%, white); stroke: none; }.instant-sign .plus { stroke: white; stroke-width: 1.7; }
.instant-sign.active circle { fill: var(--schedule-red); }
.instant-icon { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: white; font-size: 6px; pointer-events: none; }
.sign-stack-summary { cursor: pointer; }.sign-stack-summary circle { fill: var(--p-surface-200); stroke: var(--p-surface-400); stroke-width: 1; }.sign-stack-summary text { fill: var(--p-text-muted-color); font-size: 7px; font-weight: 600; pointer-events: none; }
.duration-highlight line, .duration-highlight path { stroke: var(--schedule-purple); stroke-width: 5; opacity: 1; stroke-linecap: butt; fill: none; pointer-events: none; }
.detail-flag { pointer-events: none; }.flag-leader { stroke-width: 2.2; stroke-linecap: round; }.duration-detail .flag-leader { stroke: var(--schedule-purple); }.instant-detail .flag-leader { stroke: var(--schedule-red); }.schedule-tooltip { display: block; width: 100%; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.35; box-shadow: 0 3px 7px rgba(0,0,0,.22); }.duration-detail .schedule-tooltip { background: var(--schedule-purple); color: white; }.instant-detail .schedule-tooltip { background: var(--schedule-red); color: white; }
.tooltip-detail-line { padding-left: .65rem; }
.schedule-overlays { position: absolute; inset: 0 11px 11px 0; overflow: hidden; pointer-events: none; z-index: 4; }.schedule-overlays > .overlay-tooltip, .detail-overlay { position: absolute; }.detail-overlay { overflow: visible; }.detail-overlay .overlay-tooltip { position: static; max-height: inherit; overflow: auto; }
.lineage-detail { pointer-events: none; }.segment-hover-highlight { stroke: var(--p-surface-400); stroke-width: 4.2; opacity: .4; stroke-linecap: round;}.lineage-leader { stroke: var(--p-surface-500); stroke-width: 2.2; stroke-linecap: round; }.lineage-tooltip { background: var(--grs-tooltip-bg); color: var(--grs-tooltip-fg); }
.operator-tooltip { background: var(--grs-tooltip-bg); color: var(--grs-tooltip-fg); }
.collapse-control { cursor: pointer; opacity: .65; }.collapse-control:hover { opacity: 1; }.collapse-icon { fill: var(--p-content-background); stroke: var(--p-surface-300); stroke-width: 1; }.collapse-chevron { fill: none; stroke: var(--p-text-muted-color); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.schedule-empty { padding: 2rem; color: var(--p-text-muted-color); text-align: center; font-size: .8rem; }
</style>
