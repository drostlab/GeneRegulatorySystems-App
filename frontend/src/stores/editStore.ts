import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { EditAction } from '@/network/editing/actions'

export type EditStatus = 'pending' | 'confirmed' | 'failed'

export interface EditEntry {
    action: EditAction
    /**
     * Reserved for future use. With the server-authoritative flow we no
     * longer apply locally, so there's nothing to revert and the receipt
     * is empty. Kept as a slot so undo (once it lands) can attach state
     * here without breaking the entry shape.
     */
    receipt: Record<string, unknown>
    status: EditStatus
}

/**
 * editStore - audit log of edits attempted in this session.
 *
 * Server-authoritative: no optimistic application happens here. The store
 * just records what was sent and whether the backend accepted it, for
 * potential UI badges (unsaved/synced) and future undo.
 */
export const useEditStore = defineStore('edit', () => {
    const stack = ref<EditEntry[]>([])

    function add(entry: EditEntry): void {
        stack.value.push(entry)
        console.debug('[edit]', entry.action)
    }

    function markStatus(action: EditAction, status: EditStatus): void {
        for (let i = stack.value.length - 1; i >= 0; i--) {
            if (stack.value[i]!.action === action) {
                stack.value[i]!.status = status
                return
            }
        }
    }

    function clear(): void {
        stack.value = []
    }

    return { stack, add, markStatus, clear }
})
