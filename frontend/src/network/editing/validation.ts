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
import { reactionNameFromRate } from './reactionName'

export type ValidationResult =
    | { ok: true }
    | { ok: false, reason: string }

/**
 * `.` is reserved as the gene/species separator in the app's id scheme
 * (`gene.proteins`, structural reaction ids, parameter symbols). The core
 * library tolerates dotted gene names, but the app's first-dot splitting
 * does not — so we forbid it at the edit boundary.
 */
const NO_DOT_REASON = 'Gene names cannot contain "."'

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
            if (newName.includes('.')) return { ok: false, reason: NO_DOT_REASON }
            if (newName === action.geneId) return { ok: true }
            if (geneIds.has(newName)) {
                return { ok: false, reason: `A gene named "${newName}" already exists` }
            }
            return { ok: true }
        }
        case 'create_gene': {
            const name = action.name.trim()
            if (!name) return { ok: false, reason: 'Name cannot be empty' }
            if (name.includes('.')) return { ok: false, reason: NO_DOT_REASON }
            if (geneIds.has(name)) {
                return { ok: false, reason: `A gene named "${name}" already exists` }
            }
            return { ok: true }
        }
        case 'rename_reaction': {
            const newName = action.newName.trim()
            if (!newName) return { ok: false, reason: 'Name cannot be empty' }
            if (newName === action.reactionName) return { ok: true }
            const taken = cy.nodes('[kind = "reaction"]')
                .map((n: any) => reactionNameFromRate(n.data('rate')))
                .filter((s: string | null): s is string => s !== null)
            if (taken.includes(newName)) {
                return { ok: false, reason: `A reaction named "${newName}" already exists` }
            }
            return { ok: true }
        }
        case 'set_stoichiometry': {
            if (!Number.isInteger(action.value) || action.value < 0) {
                return { ok: false, reason: 'Stoichiometry must be a non-negative integer' }
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
        case 'delete_reaction':
        case 'add_reaction':
        // add_reagent / remove_reagent rules (duplicate, last-reagent) are
        // enforced authoritatively on the backend, which returns a clear error.
        case 'add_reagent':
        case 'remove_reagent':
        case 'delete_link':
        case 'change_link_kind':
        case 'set_parameter':
            return { ok: true }
    }
}
