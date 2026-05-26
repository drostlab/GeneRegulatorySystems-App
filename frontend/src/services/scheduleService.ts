import { apiFetchJson, apiFetchText } from '@/utils/api'
import { parseScheduleKey, type Schedule, type TimelineSegment } from '@/types/schedule'
import type { UnionNetwork } from '@/types/network'
import type { EditAction } from '@/network/editing/actions'

export async function fetchAvailableSchedules(): Promise<string[]> {
    return apiFetchJson<string[]>('/schedules')
}

export async function loadScheduleFromKey(key: string): Promise<Schedule> {
    const { source, name } = parseScheduleKey(key)
    const schedule = await apiFetchJson<Schedule>(
        `/schedules/${source}/${name}`,
        { method: 'GET' }
    )
    return schedule
}

export async function getScheduleSpec(key: string): Promise<string> {
    const { source, name } = parseScheduleKey(key)
    return apiFetchText(`/schedules/${source}/${encodeURIComponent(name)}/spec`)
}

export async function loadScheduleFromSpec(spec: string, name: string): Promise<Schedule> {
    const schedule = await apiFetchJson<Schedule>(
        '/schedules/load',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedule_name: name, schedule_spec: spec })
        }
    )
    return schedule
}

export async function uploadSchedule(spec: string, name: string): Promise<Schedule> {
    return apiFetchJson<Schedule>(
        '/schedules/upload',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedule_name: name, schedule_spec: spec })
        }
    )
}

export async function fetchUnionNetwork(spec: string, segments: TimelineSegment[]): Promise<UnionNetwork> {
    return apiFetchJson<UnionNetwork>(
        '/schedules/union-network',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedule_spec: spec, segments })
        }
    )
}

/**
 * Apply one edit action server-side and return the rebuilt union network.
 * `action.model_path` is already stamped by the executeEdit layer; the
 * backend strips it from the dispatch dict and uses it to route to the
 * right Definition.
 */
export async function applyEdit(
    spec: string,
    segments: TimelineSegment[],
    action: EditAction,
): Promise<UnionNetwork> {
    const { model_path, ...rest } = action
    return apiFetchJson<UnionNetwork>(
        '/schedules/edit',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                schedule_spec: spec,
                model_path,
                segments,
                action: rest,
            }),
        }
    )
}
