/**
 * executeEdit - orchestrate one user edit end-to-end.
 *
 * Server-authoritative flow (stance 2):
 *   1. Client-side validate as a UX preflight (cheap, catches obvious
 *      collisions before bothering the server).
 *   2. POST the action to `/schedules/edit`.
 *   3. Backend mutates the v1 Definition at `model_path` only, rebuilds
 *      the union network, returns it.
 *   4. Replace `scheduleStore.unionNetwork`. The existing
 *      `NetworkDiagram` watch picks it up and renders — position-
 *      preserving fcose (see `NetworkView.setNetwork`) keeps existing
 *      nodes in place and lays out only the new bits.
 *
 * No local mutation, no receipts, no revert. On failure we toast and
 * leave the current state alone (no local divergence happened, so no
 * cleanup needed).
 */
import type { UnionNetwork } from '@/types/network'
import type { TimelineSegment } from '@/types/schedule'
import type { EditAction, RawEditAction } from './actions'
import { validateAction } from './validation'
import { applyEdit } from '@/services/scheduleService'
import { useEditStore } from '@/stores/editStore'
import type { Core } from 'cytoscape'

export interface ExecuteOptions {
    /** Stamped onto the raw action. */
    model_path: string
    /** Current gene ids — for client-side validation. */
    geneIds: Set<string>
    /** Spec string (server keys its cache and edits map by spec hash). */
    spec: string
    /** Segments — server uses them to know which model paths to union. */
    segments: TimelineSegment[]
    /** Called with the rebuilt union network on success. Caller assigns it
     *  into the schedule store, which triggers the render watch. */
    onSuccess: (network: UnionNetwork) => void
    /** User-facing error reporting. */
    onError?: (message: string) => void
}

export async function executeEdit(
    raw: RawEditAction,
    cy: Core,
    opts: ExecuteOptions,
): Promise<void> {
    const action: EditAction = { ...raw, model_path: opts.model_path } as EditAction

    // Preflight: client-side validation (rename collisions, duplicate
    // links) so obvious mistakes never reach the backend. The backend
    // also validates — this is just for UX latency.
    const validation = validateAction(action, cy, opts.geneIds)
    if (!validation.ok) {
        opts.onError?.(validation.reason)
        return
    }

    const editStore = useEditStore()
    editStore.add({ action, receipt: {}, status: 'pending' })

    try {
        const network = await applyEdit(opts.spec, opts.segments, action)
        editStore.markStatus(action, 'confirmed')
        opts.onSuccess(network)
    } catch (err) {
        console.warn('[executeEdit] backend rejected', action, err)
        editStore.markStatus(action, 'failed')
        opts.onError?.(`Edit failed: ${err instanceof Error ? err.message : String(err)}`)
    }
}
