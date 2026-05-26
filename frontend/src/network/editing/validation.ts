/**
 * validation - pure rules for edit actions.
 *
 * Modules call `validateAction` before emitting so they can show inline UX
 * feedback (red border on rename input, toast on duplicate link, etc.).
 * `executeEdit` calls it again as a defensive check before applying — the
 * single source of truth so frontend and orchestration layers can't drift.
 *
 * Rules are intentionally minimal and frontend-only. Real validation
 * (referential integrity, spec-level invariants) belongs on the backend.
 */
import type { Core } from 'cytoscape'
import type { RawEditAction, EditAction } from './actions'

export type ValidationResult =
    | { ok: true }
    | { ok: false, reason: string }

/**
 * Validate an action against current cytoscape state.
 *
 * `geneIds` is the current set of gene cytoscape ids. We pass it explicitly
 * rather than deriving from cy each call — most callers already have a set
 * (e.g. from scheduleStore.allGenes).
 */
export function validateAction(
    action: RawEditAction | EditAction,
    cy: Core,
    geneIds: Set<string>,
): ValidationResult {
    switch (action.type) {
        case 'rename_gene': {
            const newName = action.newName.trim()
            if (!newName) return { ok: false, reason: 'Name cannot be empty' }
            if (newName === action.geneId) return { ok: true }
            if (geneIds.has(newName)) {
                return { ok: false, reason: `A gene named "${newName}" already exists` }
            }
            return { ok: true }
        }
        case 'create_gene': {
            const name = action.name.trim()
            if (!name) return { ok: false, reason: 'Name cannot be empty' }
            if (geneIds.has(name)) {
                return { ok: false, reason: `A gene named "${name}" already exists` }
            }
            return { ok: true }
        }
        case 'create_link': {
            // Self-loops are permitted (autoregulation is meaningful).
            const existing = cy.edges().filter((e: any) =>
                e.data('source') === action.source
                && e.data('target') === action.target
                && e.data('kind') === action.kind,
            )
            if (existing.length > 0) {
                return { ok: false, reason: `A ${action.kind} link already exists between these genes` }
            }
            return { ok: true }
        }
        case 'delete_gene':
        case 'delete_link':
        case 'change_link_kind':
        case 'set_parameter':
            return { ok: true }
    }
}
