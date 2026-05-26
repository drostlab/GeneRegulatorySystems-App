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
    | { type: 'create_link', source: string, target: string, kind: LinkKind }
    | { type: 'delete_link', linkId: string }
    | { type: 'change_link_kind', linkId: string, kind: LinkKind }

export type EditAction = RawEditAction & { model_path: string }

export type RawEditActionHandler = (action: RawEditAction) => void
