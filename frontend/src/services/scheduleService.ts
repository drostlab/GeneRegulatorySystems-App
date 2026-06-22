import { apiFetchJson, apiFetchText } from '@/utils/api'
import { parseScheduleKey, type Schedule, type ScheduleSource, type TimelineSegment } from '@/types/schedule'
import type { UnionNetwork } from '@/types/network'

export interface RequestOptions {
    signal?: AbortSignal
}

export async function fetchAvailableSchedules(): Promise<string[]> {
    return apiFetchJson<string[]>('/schedules')
}

export async function loadScheduleFromKey(key: string, options: RequestOptions = {}): Promise<Schedule> {
    const { source, name } = parseScheduleKey(key)
    const schedule = await apiFetchJson<Schedule>(
        `/schedules/${source}/${encodeURIComponent(name)}`,
        { method: 'GET', ...options }
    )
    return schedule
}

export async function getScheduleSpec(key: string, options: RequestOptions = {}): Promise<string> {
    const { source, name } = parseScheduleKey(key)
    return apiFetchText(`/schedules/${source}/${encodeURIComponent(name)}/spec`, {
        method: 'GET',
        ...options,
    })
}

export async function loadScheduleFromSpec(spec: string, name: string, source: ScheduleSource = 'snapshot', options: RequestOptions = {}): Promise<Schedule> {
    const schedule = await apiFetchJson<Schedule>(
        '/schedules/load',
        {
            method: 'POST',
            signal: options.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedule_name: name, schedule_spec: spec, schedule_source: source })
        }
    )
    return schedule
}

export interface SaveScheduleOrigin {
    name: string
    source: string
}

export async function uploadSchedule(spec: string, name: string, origin?: SaveScheduleOrigin): Promise<Schedule> {
    return apiFetchJson<Schedule>(
        '/schedules/upload',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                schedule_name: name,
                schedule_spec: spec,
                original_name: origin?.name,
                original_source: origin?.source,
            })
        }
    )
}

export async function fetchUnionNetwork(spec: string, segments: TimelineSegment[], options: RequestOptions = {}): Promise<UnionNetwork> {
    return apiFetchJson<UnionNetwork>(
        '/schedules/union-network',
        {
            method: 'POST',
            signal: options.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedule_spec: spec, segments })
        }
    )
}
