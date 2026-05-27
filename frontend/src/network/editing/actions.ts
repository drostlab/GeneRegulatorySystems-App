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

export interface Position {
    x: number
    y: number
}

/** Action shape before the model_path is stamped on. */
export type RawEditAction =
    | { type: 'set_parameter', symbol: string, value: number }
    | { type: 'rename_gene', geneId: string, newName: string }
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
