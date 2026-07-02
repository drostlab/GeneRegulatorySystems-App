import type { ScheduleOperator, TimelineSegment } from '@/types/schedule'

export function segmentDetailLines(segment: TimelineSegment): string[] {
    const label = segment.label.trim()
    const labelLines = label.split('\n').map(line => line.trim()).filter(Boolean)
    const semanticKind = segment.model_kind || segment.model_type
    const repeatsType = label.toLocaleLowerCase().startsWith(semanticKind.toLocaleLowerCase())
    return [
        ...(labelLines.length ? labelLines : [semanticKind]),
        repeatsType ? '' : semanticKind,
        segment.from < segment.to ? `genes: ${segment.gene_count}` : '',
        segment.execution_path,
    ].filter(Boolean)
}

export function operatorDetailLines(operator: ScheduleOperator): string[] {
    const title = operator.kind === 'each' ? 'Each' : 'List'
    const count = `${operator.child_paths.length} ${operator.child_paths.length === 1 ? 'branch' : 'branches'}`
    return [
        title,
        operator.label ? `label: ${operator.label}` : '',
        operator.binding ? `as: "${operator.binding}"` : '',
        count,
        operator.path,
    ].filter(Boolean)
}

export function textWidth(lines: string[], minimum = 118, maximum = 340): number {
    const longest = Math.max(...lines.map(line => line.length), 1)
    return Math.max(minimum, Math.min(maximum, longest * 8.2 + 28))
}
