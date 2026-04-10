import { apiFetchJson, apiFetchText } from '@/utils/api'
import { parseScheduleKey, type Schedule, type TimelineSegment } from '@/types/schedule'
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
    console.debug(`[ScheduleService] Loaded schedule: ${key}, segments: ${schedule.data?.segments.length ?? 0}`)
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
    console.debug(`[ScheduleService] Loaded schedule from spec: ${name}, segments: ${schedule.data?.segments.length ?? 0}`)
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
    console.debug(`[ScheduleService] fetchUnionNetwork: ${segments.length} segments`)
    return apiFetchJson<UnionNetwork>(
        '/schedules/union-network',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedule_spec: spec, segments })
        }
    )
}
