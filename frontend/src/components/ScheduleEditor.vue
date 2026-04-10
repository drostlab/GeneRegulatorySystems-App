<script setup lang="ts">
/**
 * ScheduleEditor Component
 *
 * Responsibilities:
 * - Schedule selection dropdown (examples + user schedules)
 * - JSON editor (Monaco) for schedule source code
 * - Validation & error display
 * - Save/Load/Discard workflow
 *
 * State:
 * - Component-only: Editor UI state (focused, loaded indicator)
 * - Store: Schedule data, editing session, user schedules
 *
 * Integrates with:
 * - scheduleStore: schedule loading, validation, persistence
 * - useMonacoEditor: Monaco editor lifecycle
 * - No direct API calls (all via store → scheduleService)
 */
import { ref, reactive, onMounted, computed, watch, onBeforeUnmount} from 'vue'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useSimulationStore } from '@/stores/simulationStore'
import { useViewerStore } from '@/stores/viewerStore'
import { useMonacoEditor } from '@/composables/useMonacoEditor'
import { findRangeForJsonPath } from '@/utils/jsonPathUtils'
import Button from 'primevue/button'
import Select, { type SelectChangeEvent } from 'primevue/select'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import * as scheduleService from '@/services/scheduleService'
import { parseScheduleKey } from '@/types/schedule'

const store = useScheduleStore()
const simulationStore = useSimulationStore()
const viewerStore = useViewerStore()

const isLoading = computed(() => store.isLoading)

interface EditorState {
    currentName: string
    isEditing: boolean
}

const editor = reactive<EditorState>({
    currentName: '',
    isEditing: false
})

// Monaco editor 
const { init: initMonaco, setValue: setCurrentJson, getContent: getCurrentJson, updateOptions: updateOptionsMonaco, highlightScope, clearScopeHighlight, dispose: disposeMonaco } = useMonacoEditor(
    'schedule-editor-monaco'
)

watch(
    () => editor.isEditing,
    (isEditing) => {
        updateOptionsMonaco({
            readOnly: !isEditing,
            cursorStyle: isEditing ? 'line' : 'hidden'
        })
    }
)

function resetEditor() {
    editor.isEditing = false
    editor.currentName = store.schedule.name
    setCurrentJson(store.schedule.spec)
}


const availableScheduleKeys = ref<string[]>([])

interface ScheduleGroup {
    label: string
    items: Array<{ label: string; value: string }>
}

const scheduleOptions = computed(() => {
    const opts: ScheduleGroup[] = []

    const grouped = availableScheduleKeys.value.reduce((acc, key) => {
        const {source, name} = parseScheduleKey(key)
        if (!acc[source]) acc[source] = []
        acc[source].push({ label: `${source}/${name}`, value: key })
        return acc
    }, {} as Record<string, Array<{ label: string; value: string }>>)

    if (grouped.user?.length) {
        opts.push({ label: 'My Schedules', items: grouped.user })
    }
    if (grouped.examples?.length) {
        opts.push({ label: 'Examples', items: grouped.examples })
    }

    return opts
})

const errorMessages = computed(() => store.scheduleMessages.filter(m => m.type === 'error'))
const warningMessages = computed(() => store.scheduleMessages.filter(m => m.type === 'warning'))
const infoMessages = computed(() => store.scheduleMessages.filter(m => m.type === 'info'))

async function handleScheduleSelect(event: SelectChangeEvent) {
    const scheduleKey = event.value

    if (!scheduleKey || scheduleKey === store.scheduleKey) {
        return
    }

    // Clear simulation when user selects a new schedule
    simulationStore.clearResult()

    // Clear editor content immediately so stale JSON isn't visible during loading
    setCurrentJson('')
    
    await store.loadScheduleByKey(scheduleKey)
}

watch (
    () => store.schedule.spec,
    (spec) => {
        // Update editor when spec text changes (e.g. after fast fetch or full load)
        if (spec) {
            resetEditor()
        }
    }
)

function startEdit() {
    console.assert(!editor.isEditing, "startEdit called while editing")
    editor.isEditing = true
}

async function saveEdit() {
    const currentJson = getCurrentJson()
    
    console.assert(editor.isEditing, "saveEdit called while not editing")

    const hasChanges = editor.currentName !== store.schedule.name || currentJson !== store.schedule.spec
    if (hasChanges) {
        // Upload and use the response directly (already contains reified data)
        const uploaded = await scheduleService.uploadSchedule(currentJson, editor.currentName)
        store.setSchedule(uploaded)
    }

    // Update the schedule list
    availableScheduleKeys.value = await scheduleService.fetchAvailableSchedules()

    resetEditor()
}

function cancelEdit() {
    resetEditor()
}

function cancelScheduleNameEdit() {
    editor.currentName = store.schedule.name
}

// ============================================================================
// Scope highlight: sync Monaco editor with timeline hover / selection
// ============================================================================

/**
 * Resolve the json_path to highlight from the active model path.
 * Mirrors the same computed used by NetworkDiagram / ModelFilter.
 */
const activeHighlightPath = computed((): (string | number)[] | null => {
    // Only highlight when something is explicitly hovered — never for timepoint fallback.
    if (!viewerStore.editorHighlightModelPath) return null
    const seg = store.segments.find(s => s.model_path === viewerStore.editorHighlightModelPath)
    return seg?.json_path ?? null
})

watch(activeHighlightPath, (path) => {
    if (!path) {
        clearScopeHighlight()
        return
    }
    const range = findRangeForJsonPath(getCurrentJson(), path)
    if (!range) return
    highlightScope(range.startOffset, range.endOffset, true)
})

onMounted(async () => {
    try {
        availableScheduleKeys.value = await scheduleService.fetchAvailableSchedules()
    } catch (e) {
        console.error('[ScheduleEditor] Failed to load schedules:', e)
    }

    await initMonaco()
    // Load first schedule if none loaded
    if (!store.schedule.name && availableScheduleKeys.value.length > 0) {
        await store.loadScheduleByKey(availableScheduleKeys.value[0]!)
    }
    else {
        resetEditor()
    }
})

onBeforeUnmount(() =>
    disposeMonaco()
)

</script>

<template>
    <div class="schedule-editor">
        <!-- Header -->
        <div class="card-header">
            <div class="card-header-row">
                <!-- Schedule dropdown -->
                <Select
                    v-show="!editor.isEditing"
                    :model-value="store.scheduleKey"
                    :options="scheduleOptions"
                    optionLabel="label"
                    optionValue="value"
                    placeholder="Select schedule"
                    class="dropdown-small"
                    @change="handleScheduleSelect"
                    size="small"
                    :disabled="isLoading"
                    option-group-label="label"
                    option-group-children="items"
                >
                    <template #option="slotProps">
                        <div class="dropdown-option">{{ slotProps.option.label }}</div>
                    </template>
                    <template #value="slotProps">
                        <div v-if="slotProps.value" class="dropdown-option">
                            {{ slotProps.value }}
                        </div>
                        <span v-else class="dropdown-option">Select schedule</span>
                    </template>
                    <template #optiongroup="slotProps">
                        <div class="dropdown-option-group">{{ slotProps.option.label }}</div>
                    </template>
                    <template #empty>
                        <div class="dropdown-option">No available schedules</div>
                    </template>
                </Select>

                <!-- Schedule title during edit mode -->
                <InputText
                    v-show="editor.isEditing"
                    v-model="editor.currentName"
                    type="text"
                    size="small"
                    placeholder="Schedule name"
                    class="input-small"
                    @keyup.esc="cancelScheduleNameEdit"
                />

                <!-- Enter edit mode -->
                <Button
                    v-show="!editor.isEditing"
                    icon="pi pi-pencil"
                    severity="secondary"
                    rounded
                    title="Edit"
                    @click="startEdit"
                    size="small"
                    :disabled="isLoading"
                />

                <!-- (try to) Save edited schedule -->
                <Button
                    v-show="editor.isEditing"
                    icon="pi pi-check"
                    severity="success"
                    rounded
                    title="Save"
                    @click="saveEdit"
                    size="small"
                    :disabled="isLoading"
                />

                <!-- Cancel editing -->
                <Button
                    v-show="editor.isEditing"
                    icon="pi pi-times"
                    severity="error"
                    rounded
                    title="Cancel"
                    @click="cancelEdit"
                    size="small"
                />

            </div>
        </div>

        <!-- Editor -->
        <div class="editor-wrapper">
            <div
                id="schedule-editor-monaco"
                class="editor-container"
                :class="{ 'editor-editing': editor.isEditing }"
            ></div>
        </div>

        <!-- Validation Messages -->
        <div class="validation-area" v-if="store.scheduleMessages.length > 0">
            <Message
                v-if="infoMessages.length > 0 && errorMessages.length === 0"
                severity="info"
                class="validation-message"
            >
                <div class="message-list">
                    <div
                        v-for="(msg, i) in infoMessages"
                        :key="i"
                        class="message-item"
                    >
                        {{ msg.content }}
                    </div>
                </div>
            </Message>
            <Message
                v-if="errorMessages.length > 0"
                severity="error"
                class="validation-message"
            >
                <div class="error-list">
                    <div
                        v-for="(msg, i) in errorMessages"
                        :key="i"
                        class="error-item"
                    >
                        {{ msg.content }}
                    </div>
                </div>
            </Message>
            <Message
                v-if="warningMessages.length > 0"
                severity="warn"
                class="validation-message"
            >
                <div class="warning-list">
                    <div v-for="(msg, i) in warningMessages" :key="i" class="warning-item">
                        {{ msg.content }}
                    </div>
                </div>
            </Message>
        </div>

        <!-- Dim overlay while schedule is loading (no spinner -- the slow part is data/network, not validation) -->
        <div v-if="isLoading" class="disabled-overlay" />
    </div>
</template>

<style scoped>
@import '@fontsource/fira-code';

/* Component layout */
.schedule-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--p-surface-ground);
    position: relative;
}

/* Validation area */
.validation-area {
    padding: var(--spacing-md) var(--spacing-lg);
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
    max-height: 90px;
    overflow-y: auto;
    background: var(--p-surface-section);
    flex-shrink: 0;
    border-bottom: 1px solid var(--p-surface-border);
}


:deep(.validation-message .p-message-text) {
    font-size: var(--font-size-md);
    font-weight: 400 !important;
}

.error-list,
.warning-list,
.message-list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
}

.error-item,
.warning-item,
.message-item {
    font-size: var(--font-size-sm);
    line-height: 1.3;
}

/* Editor container */
.editor-wrapper {
    flex: 1;
    overflow: hidden;
}

.editor-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--p-surface-ground);
    border: 2px solid transparent;
    transition: all 0.2s ease;
}

.editor-container.editor-editing {
    border: 2px solid var(--p-primary-color);
    background: var(--p-primary-50);
}

/* Monaco scope highlight — must be global (decorations are injected outside Vue's scoped context) */
:global(.scope-highlight),
:global(.scope-highlight-first) {
    background-color: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
}
/* First line: extends from the start character to the right edge of the editor
   via a ::after pseudo-element clipped by Monaco's overflow:hidden container. */
:global(.scope-highlight-first) {
    display: inline-block !important;
    position: relative;
}
:global(.scope-highlight-first::after) {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 100%;
    width: 100vw;
    background-color: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
    pointer-events: none;
}
</style>