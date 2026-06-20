/**
 * EditAction - unified channel for user edits to the network spec.
 *
 * Every editing module (parameter chips, edge creation, rename, delete) emits
 * a `RawEditAction`. The orchestration layer (NetworkDiagram → executeEdit)
 * stamps the active `model_path` to produce the full `EditAction` that lands
 * in editStore and eventually fires at the backend.
 *
 * Edits are per-model: a single network may have multiple model specs
 * (different parameter values, different links). Every edit — structural or
 * parameter — applies to the currently active model.
 */

export type LinkKind = 'activation' | 'repression' | 'proteolysis'

/**
 * Which side of a reaction a reagent sits on: `from` = substrate (input),
 * `to` = product (output). Matches the `Reagents` fields in the V1 spec.
 */
export type ReagentRole = 'from' | 'to'

export interface Position {
    x: number
    y: number
}

/** Action shape before the model_path is stamped on. */
export type RawEditAction =
    | { type: 'set_parameter', symbol: string, value: number }
    | { type: 'rename_gene', geneId: string, newName: string }
    // `reactionName` is the reaction's current declared name (extracted from
    // its rate symbol `reaction.<name>.k⁺`), not the structural cytoscape id.
    | { type: 'rename_reaction', reactionName: string, newName: string }
    | { type: 'delete_reaction', reactionName: string }
    // Create a new auxiliary reaction seeded with `species` as its sole reagent
    // on side `role` (substrate when 'from', product when 'to').
    | { type: 'add_reaction', species: string, role: ReagentRole }
    // Connect / disconnect a species to/from an existing reaction on side `role`.
    | { type: 'add_reagent', reactionName: string, species: string, role: ReagentRole }
    | { type: 'remove_reagent', reactionName: string, species: string, role: ReagentRole }
    // Set a reagent's stoichiometry; `value` of 0 removes the connection.
    | { type: 'set_stoichiometry', reactionName: string, species: string, role: ReagentRole, value: number }
    | { type: 'delete_gene', geneId: string }
    | { type: 'create_gene', name: string, position: Position }
    // For link actions, `source` / `target` are endpoint ids as they appear
    // on the cytoscape edge: gene ids for newly drawn links (e.g. `skn-1`),
    // or species ids for existing links (e.g. `skn-1.proteins`). The backend
    // normalises both to the owning gene by splitting on the first `.` —
    // robust to gene names that themselves contain `-` (e.g. `skn-1`).
    | { type: 'create_link', source: string, target: string, kind: LinkKind }
    | { type: 'delete_link', source: string, target: string, kind: LinkKind }
    | { type: 'change_link_kind', source: string, target: string, oldKind: LinkKind, newKind: LinkKind }

export type EditAction = RawEditAction & { model_path: string }

export type RawEditActionHandler = (action: RawEditAction) => void
