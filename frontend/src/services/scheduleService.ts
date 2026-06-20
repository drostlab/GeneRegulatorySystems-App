import { apiFetchJson, apiFetchText } from '@/utils/api'
import { parseScheduleKey, type Schedule, type ScheduleSource, type TimelineSegment } from '@/types/schedule'
import type { UnionNetwork } from '@/types/network'

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

export async function loadScheduleFromSpec(spec: string, name: string, source: ScheduleSource = 'snapshot'): Promise<Schedule> {
    const schedule = await apiFetchJson<Schedule>(
        '/schedules/load',
        {
            method: 'POST',
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
