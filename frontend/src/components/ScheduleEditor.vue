<script setup lang="ts">
/**
 * ScheduleEditor Component
 *
 * Responsibilities:
 * - Schedule selection dropdown (examples + user schedules)
 * - JSON editor (Monaco) for schedule source code
 * - Validation & error display
 * - Always-on editing with save, new, and duplicate actions
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
import { ref, reactive, onMounted, computed, watch, onBeforeUnmount } from 'vue'
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
const shortcutModifier = navigator.platform.toUpperCase().includes('MAC') ? '⌘' : 'Ctrl+'

interface EditorState {
    currentName: string
    isNew: boolean
    originalName: string
    originalSource: string
}

const editor = reactive<EditorState>({
    currentName: '',
    isNew: false,
    originalName: '',
    originalSource: 'user'
})
const isSaving = ref(false)
const editorContent = ref('')

// Monaco editor 
const { init: initMonaco, setValue: setCurrentJson, getContent: getCurrentJson, highlightScope, clearScopeHighlight, dispose: disposeMonaco } = useMonacoEditor(
    'schedule-editor-monaco',
    content => { editorContent.value = content }
)

const hasUnsavedChanges = computed(() =>
    editor.isNew ||
    editor.currentName !== store.schedule.name ||
    editorContent.value !== store.schedule.spec
)

function resetEditor() {
    editor.currentName = store.schedule.name
    editor.originalName = store.schedule.name
    editor.originalSource = store.schedule.source
    editor.isNew = false
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

    const loaded = await store.loadScheduleByKey(scheduleKey)
    if (loaded) simulationStore.clearResult()
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

function uniqueScheduleName(base: string): string {
    const existingNames = new Set(availableScheduleKeys.value.map(key => parseScheduleKey(key).name))
    if (!existingNames.has(base)) return base
    let suffix = 2
    while (existingNames.has(`${base} ${suffix}`)) suffix++
    return `${base} ${suffix}`
}

function scheduleSourceLabel(key: string): string {
    if (!key) return ''
    return `${parseScheduleKey(key).source}/`
}

async function saveEdit() {
    if (isSaving.value || isLoading.value || !editor.currentName.trim()) return

    const currentJson = getCurrentJson()
    if (!hasUnsavedChanges.value) return

    isSaving.value = true
    try {
        const origin = editor.isNew ? undefined : {
            name: editor.originalName,
            source: editor.originalSource,
        }
        const uploaded = await scheduleService.uploadSchedule(currentJson, editor.currentName.trim(), origin)
        store.setSchedule(uploaded)
        availableScheduleKeys.value = await scheduleService.fetchAvailableSchedules()
        resetEditor()

        if (simulationStore.autoRunOnSave) {
            simulationStore.pendingAutoRun = true
        }
    } finally {
        isSaving.value = false
    }
}

async function createNewSchedule() {
    const name = uniqueScheduleName('untitled')
    const loaded = await store.loadScheduleBySpec('{\n}\n', name, 'user')
    if (!loaded) return
    simulationStore.clearResult()
    editor.isNew = true
    editor.currentName = name
    editor.originalName = ''
    editor.originalSource = 'user'
}

async function duplicateSchedule() {
    if (!store.schedule.spec) return
    const name = uniqueScheduleName(`${store.schedule.name || 'untitled'} copy`)
    const loaded = await store.loadScheduleBySpec(getCurrentJson(), name, 'user')
    if (!loaded) return
    simulationStore.clearResult()
    editor.isNew = true
    editor.currentName = name
    editor.originalName = ''
    editor.originalSource = 'user'
}

function handleEditorShortcut(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey)) return

    const key = event.key.toLowerCase()
    if (key === 's' && !event.shiftKey) {
        event.preventDefault()
        void saveEdit()
    } else if (key === 'n' && !event.shiftKey) {
        event.preventDefault()
        if (!isLoading.value) void createNewSchedule()
    } else if (key === 'd' && event.shiftKey) {
        event.preventDefault()
        if (!isLoading.value && store.schedule.spec) void duplicateSchedule()
    }
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

    await initMonaco('', true)
    resetEditor()
    window.addEventListener('keydown', handleEditorShortcut, true)
})

onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleEditorShortcut, true)
    disposeMonaco()
})

</script>

<template>
    <div class="schedule-editor">
        <!-- Header -->
        <div class="card-header">
            <div class="card-header-row">
                <!-- A joined source/name control avoids showing the title twice. -->
                <div class="schedule-title-control">
                    <Select
                        :model-value="store.scheduleKey"
                        :options="scheduleOptions"
                        optionLabel="label"
                        optionValue="value"
                        placeholder="Open"
                        class="schedule-picker"
                        @change="handleScheduleSelect"
                        size="small"
                        :disabled="isLoading"
                        option-group-label="label"
                        option-group-children="items"
                        v-grs-tooltip="'Switch schedule'"
                    >
                        <template #option="slotProps">
                            <div class="dropdown-option">{{ slotProps.option.label }}</div>
                        </template>
                        <template #value="slotProps">
                            <div v-if="slotProps.value" class="schedule-source">
                                <i class="pi pi-folder-open" />
                                {{ scheduleSourceLabel(slotProps.value) }}
                            </div>
                            <span v-else class="schedule-source">
                                <i class="pi pi-folder-open" />
                                open
                            </span>
                        </template>
                        <template #optiongroup="slotProps">
                            <div class="dropdown-option-group">{{ slotProps.option.label }}</div>
                        </template>
                        <template #empty>
                            <div class="dropdown-option">No available schedules</div>
                        </template>
                    </Select>

                    <InputText
                        v-model="editor.currentName"
                        type="text"
                        size="small"
                        placeholder="Schedule name"
                        class="schedule-name-input"
                        aria-label="Schedule name"
                    />
                </div>

                <div class="schedule-actions">
                    <!-- Save in place (renaming a user schedule moves it). -->
                    <Button
                        icon="pi pi-save"
                        severity="secondary"
                        rounded
                        v-grs-tooltip="`Save (${shortcutModifier}S)`"
                        @click="saveEdit"
                        size="small"
                        :loading="isSaving"
                        :disabled="isLoading || isSaving || !editor.currentName.trim() || !hasUnsavedChanges"
                    />

                    <Button
                        icon="pi pi-plus"
                        severity="secondary"
                        rounded
                        v-grs-tooltip="`New schedule (${shortcutModifier}N)`"
                        @click="createNewSchedule"
                        size="small"
                        :disabled="isLoading"
                    />

                    <Button
                        icon="pi pi-copy"
                        severity="secondary"
                        rounded
                        v-grs-tooltip="`Duplicate schedule (${shortcutModifier}${shortcutModifier === '⌘' ? '⇧' : 'Shift+'}D)`"
                        @click="duplicateSchedule"
                        size="small"
                        :disabled="isLoading || !store.schedule.spec"
                    />
                </div>

            </div>
        </div>

        <!-- Editor -->
        <div class="editor-wrapper">
            <div v-if="hasUnsavedChanges" class="unsaved-indicator" aria-live="polite">
                <span class="unsaved-dot" />
                Unsaved
            </div>
            <div
                id="schedule-editor-monaco"
                class="editor-container"
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
    container-type: inline-size;
}

.card-header-row {
    flex-wrap: wrap;
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
    position: relative;
}

.schedule-title-control {
    display: flex;
    flex: 1 1 190px;
    min-width: 0;
}

.schedule-picker {
    width: 130px;
    flex: 0 0 130px;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
}

.schedule-source {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: var(--font-size-sm);
    white-space: nowrap;
}

.schedule-name-input {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm) !important;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    margin-left: -1px;
}

.schedule-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--spacing-lg);
    margin-left: auto;
}

@container (max-width: 400px) {
    .schedule-title-control {
        flex-basis: 100%;
    }

    .schedule-actions {
        width: 100%;
        justify-content: flex-end;
    }
}

.schedule-name-input:focus {
    position: relative;
    z-index: 1;
}

.unsaved-indicator {
    position: absolute;
    z-index: 5;
    top: var(--spacing-sm);
    right: calc(var(--spacing-md) + 8px);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border: 1px solid var(--p-surface-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--p-surface-card) 92%, transparent);
    box-shadow: var(--p-shadow-sm);
    color: var(--p-text-muted-color);
    font-size: var(--font-size-xs);
    pointer-events: none;
}

.unsaved-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--p-primary-color);
}

.editor-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--p-surface-ground);
    border: 2px solid transparent;
    transition: all 0.2s ease;
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
