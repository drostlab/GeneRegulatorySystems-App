<script setup lang="ts">
import { defineComponent, h, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DockviewVue } from 'dockview-vue'
import type { DockviewApi, DockviewReadyEvent, VueComponent } from 'dockview-vue'
import 'dockview-vue/dist/styles/dockview.css'
import ScheduleEditor from './ScheduleEditor.vue'
import NetworkDiagram from './NetworkDiagram.vue'
import ScheduleViewer from './ScheduleViewer.vue'
import TrackViewer from './TrackViewer.vue'
import LoadingOverlay from './LoadingOverlay.vue'
import { useTheme } from '@/composables/useTheme'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useSimulationStore } from '@/stores/simulationStore'
import { isTauri } from '@/config/api'

const scheduleStore = useScheduleStore()
const simulationStore = useSimulationStore()
const { isDark } = useTheme()

const dockviewApi = ref<DockviewApi | null>(null)
const openPanelIds = ref(new Set<string>())
const edgeDropOverlay = {
    activationSize: { type: 'pixels' as const, value: 10 },
    size: { type: 'pixels' as const, value: 24 },
}
const networkDiagramRef = ref<InstanceType<typeof NetworkDiagram>>()
const trackViewerRef = ref<InstanceType<typeof TrackViewer> & {
    resize?: () => void
    syncVisibleTracks?: () => void
}>()
const unlistenFns: Array<() => void> = []
let lastScheduleLoaded = scheduleStore.isLoaded
let resizeRaf: number | null = null

const EditorPanel = defineComponent({
    name: 'EditorDockPanel',
    setup() {
        return () => h(ScheduleEditor, { class: 'dock-panel-content' })
    },
})

const NetworkPanel = defineComponent({
    name: 'NetworkDockPanel',
    setup() {
        return () => h(NetworkDiagram, {
            ref: networkDiagramRef,
            class: 'dock-panel-content',
        })
    },
})

const SchedulePanel = defineComponent({
    name: 'ScheduleDockPanel',
    setup() {
        return () => h('div', { class: 'schedule-panel dock-panel-content' }, [
            h(ScheduleViewer, {
                class: 'schedule-pane',
                segments: scheduleStore.segments,
                modelActivations: scheduleStore.modelActivations,
                eachPrefixes: scheduleStore.eachPrefixes,
                operators: scheduleStore.scheduleOperators,
            }),
            scheduleStore.isLoading
                ? h(LoadingOverlay, { label: 'Loading schedule…' })
                : null,
        ])
    },
})

const TrackPanel = defineComponent({
    name: 'TrackDockPanel',
    setup() {
        return () => h(TrackViewer, {
            ref: trackViewerRef,
            class: 'dock-panel-content',
        })
    },
})

const QuietGroupDragGhost = markRaw(defineComponent({
    name: 'QuietGroupDragGhost',
    setup() {
        return () => h('div', { class: 'quiet-group-drag-ghost' })
    },
})) as VueComponent

const dockviewComponents: Record<string, VueComponent> = {
    editor: markRaw(EditorPanel) as VueComponent,
    network: markRaw(NetworkPanel) as VueComponent,
    schedule: markRaw(SchedulePanel) as VueComponent,
    tracks: markRaw(TrackPanel) as VueComponent,
}

type PanelId = 'editor' | 'network' | 'schedule' | 'tracks'

const panelSpecs: Record<PanelId, { title: string; component: string }> = {
    editor: { title: 'Editor', component: 'editor' },
    network: { title: 'Network', component: 'network' },
    schedule: { title: 'Schedule', component: 'schedule' },
    tracks: { title: 'Simulation', component: 'tracks' },
}

const panelOrder: PanelId[] = ['editor', 'network', 'schedule', 'tracks']
const INITIAL_EDITOR_WIDTH = 520
const INITIAL_TRACKS_HEIGHT = 320
const LOADED_TRACKS_HEIGHT = 460

function syncOpenPanels(api = dockviewApi.value): void {
    openPanelIds.value = new Set(api?.panels.map(panel => panel.api.id) ?? [])
    if (isTauri()) {
        void import('@tauri-apps/api/event')
            .then(({ emit }) => emit('workspace:panels-open', [...openPanelIds.value]))
    }
}

function resizeTracksSoon(): void {
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
    resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        trackViewerRef.value?.resize()
    })
}

function resizeTracksAfterDockviewSettle(): void {
    resizeTracksSoon()
    window.setTimeout(resizeTracksSoon, 50)
    window.setTimeout(resizeTracksSoon, 180)
}

type SerializedGridNode = {
    type: 'leaf' | 'branch'
    data: any
    size?: number
}

function nodeContainsPanel(node: SerializedGridNode, panelId: PanelId): boolean {
    if (node.type === 'leaf') {
        return Array.isArray(node.data?.views) && node.data.views.includes(panelId)
    }
    return Array.isArray(node.data) && node.data.some((child: SerializedGridNode) => nodeContainsPanel(child, panelId))
}

function applyInitialEditorWidth(api = dockviewApi.value): void {
    if (!api || !api.getPanel('editor') || !api.getPanel('network')) return
    const layout = api.toJSON()
    const root = layout.grid.root as SerializedGridNode
    const children = root.type === 'branch' && Array.isArray(root.data)
        ? root.data as SerializedGridNode[]
        : []
    const editorChild = children.find(child => nodeContainsPanel(child, 'editor'))
    const peerChild = children.find(child => child !== editorChild)
    if (!editorChild || !peerChild) return

    const width = Math.max(layout.grid.width || api.width || 0, INITIAL_EDITOR_WIDTH * 2)
    editorChild.size = INITIAL_EDITOR_WIDTH
    peerChild.size = Math.max(1, width - INITIAL_EDITOR_WIDTH)
    layout.grid.width = width
    api.fromJSON(layout, { reuseExistingPanels: true })
    resizeTracksSoon()
}

function growSimulationPanel(api = dockviewApi.value): void {
    const panel = api?.getPanel('tracks')
    if (!panel) return
    const availableHeight = api?.height ?? LOADED_TRACKS_HEIGHT
    const maxHeight = Math.max(INITIAL_TRACKS_HEIGHT, availableHeight - 120)
    const targetHeight = Math.min(
        Math.max(LOADED_TRACKS_HEIGHT, panel.api.height || 0),
        maxHeight,
    )
    panel.api.setSize({ height: targetHeight })
    trackViewerRef.value?.syncVisibleTracks?.()
    resizeTracksAfterDockviewSettle()
}

function addPanel(id: PanelId): void {
    const api = dockviewApi.value
    if (!api || api.getPanel(id)) return
    if (id === 'schedule' && !scheduleStore.isLoaded) return
    const spec = panelSpecs[id]
    if (id === 'editor') {
        api.addPanel({
            id,
            ...spec,
            position: api.getPanel('network')
                ? { referencePanel: 'network', direction: 'left' }
                : undefined,
            initialWidth: INITIAL_EDITOR_WIDTH,
        })
    } else if (id === 'network') {
        api.addPanel({
            id,
            ...spec,
            position: api.getPanel('editor')
                ? { referencePanel: 'editor', direction: 'right' }
                : undefined,
        })
    } else if (id === 'schedule') {
        api.addPanel({
            id,
            ...spec,
            position: api.getPanel('editor')
                ? { referencePanel: 'editor', direction: 'below' }
                : undefined,
            initialHeight: 280,
        })
    } else {
        api.addPanel({
            id,
            ...spec,
            position: api.getPanel('network')
                    ? { referencePanel: 'network', direction: 'below' }
                    : api.getPanel('schedule')
                        ? { referencePanel: 'schedule', direction: 'right' }
                    : undefined,
            initialHeight: INITIAL_TRACKS_HEIGHT,
        })
    }
    syncOpenPanels(api)
    void nextTick(() => {
        applyInitialEditorWidth(api)
        resizeTracksSoon()
    })
}

function removePanel(id: PanelId): void {
    const api = dockviewApi.value
    const panel = api?.getPanel(id)
    if (!api || !panel) return
    api.removePanel(panel)
    syncOpenPanels(api)
}

function togglePanel(id: PanelId): void {
    const api = dockviewApi.value
    if (!api) return
    const panel = api.getPanel(id)
    if (panel) {
        removePanel(id)
        return
    }
    addPanel(id)
}

function onReady(event: DockviewReadyEvent): void {
    dockviewApi.value = event.api
    event.api.onDidAddPanel(() => {
        syncOpenPanels(event.api)
        resizeTracksSoon()
    })
    event.api.onDidRemovePanel(() => {
        syncOpenPanels(event.api)
        resizeTracksSoon()
    })
    event.api.onWillDragPanel(() => startDockviewDrag())
    event.api.onWillDragGroup(() => startDockviewDrag())
    event.api.onDidDrop(() => stopDockviewDragSoon())
    event.api.onWillDrop(() => stopDockviewDragSoon())
    event.api.addPanel({
        id: 'editor',
        title: 'Editor',
        component: 'editor',
        initialWidth: INITIAL_EDITOR_WIDTH,
    })
    event.api.addPanel({
        id: 'network',
        title: 'Network',
        component: 'network',
        position: { referencePanel: 'editor', direction: 'right' },
    })
    if (scheduleStore.isLoaded) {
        event.api.addPanel({
            id: 'schedule',
            title: 'Schedule',
            component: 'schedule',
            position: { referencePanel: 'editor', direction: 'below' },
            initialHeight: 280,
        })
    }
    event.api.addPanel({
        id: 'tracks',
        title: 'Simulation',
        component: 'tracks',
        position: { referencePanel: 'network', direction: 'below' },
        initialHeight: INITIAL_TRACKS_HEIGHT,
    })
    syncOpenPanels(event.api)
    void nextTick(() => {
        applyInitialEditorWidth(event.api)
        resizeTracksSoon()
    })
    window.setTimeout(() => applyInitialEditorWidth(event.api), 50)
    window.setTimeout(resizeTracksSoon, 250)
}

function startDockviewDrag(): void {
    document.body.classList.add('grs-dockview-dragging')
    window.addEventListener('pointerup', stopDockviewDrag, { once: true })
    window.addEventListener('pointercancel', stopDockviewDrag, { once: true })
    window.addEventListener('dragend', stopDockviewDrag, { once: true })
    window.addEventListener('blur', stopDockviewDrag, { once: true })
}

function stopDockviewDragSoon(): void {
    window.setTimeout(stopDockviewDrag, 0)
    window.setTimeout(resizeTracksSoon, 0)
    window.setTimeout(resizeTracksSoon, 80)
}

function stopDockviewDrag(): void {
    document.body.classList.remove('grs-dockview-dragging')
    window.removeEventListener('pointerup', stopDockviewDrag)
    window.removeEventListener('pointercancel', stopDockviewDrag)
    window.removeEventListener('dragend', stopDockviewDrag)
    window.removeEventListener('blur', stopDockviewDrag)
}

onMounted(async () => {
    if (!isTauri()) return
    const { listen } = await import('@tauri-apps/api/event')
    for (const id of panelOrder) {
        unlistenFns.push(await listen(`menu:toggle-panel:${id}`, () => togglePanel(id)))
    }
})

watch(
    () => scheduleStore.isLoaded,
    loaded => {
        if (!loaded) {
            lastScheduleLoaded = false
            removePanel('schedule')
            return
        }
        if (!lastScheduleLoaded) {
            addPanel('schedule')
        }
        lastScheduleLoaded = true
    }
)

watch(
    () => simulationStore.isLoaded,
    loaded => {
        if (!loaded) return
        void nextTick(() => growSimulationPanel())
    }
)

onBeforeUnmount(() => {
    unlistenFns.forEach(fn => fn())
    unlistenFns.length = 0
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
    stopDockviewDrag()
})

defineExpose({
    exportNetworkSVG: () => networkDiagramRef.value?.exportSVG(),
    exportSimulationSVG: () => trackViewerRef.value?.exportSVG(),
})
</script>

<template>
    <section class="simulation-workspace grs-dockview-theme" :class="{ 'grs-dockview-dark': isDark }">
        <DockviewVue
            class="simulation-dockview"
            :components="dockviewComponents"
            single-tab-mode="default"
            :disable-dnd="false"
            :disable-floating-groups="false"
            floating-group-drag-handle="titlebar"
            dnd-strategy="pointer"
            :dnd-edges="edgeDropOverlay"
            :group-drag-ghost-component="QuietGroupDragGhost"
            @ready="onReady"
        />
    </section>
</template>

<style scoped>
.simulation-workspace {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--p-surface-ground);
}

.grs-dockview-theme {
    --dv-paneview-active-outline-color: var(--p-primary-color) !important;
    --dv-tabs-and-actions-container-font-size: .68rem !important;
    --dv-tabs-and-actions-container-height: 24px !important;
    --dv-group-view-background-color: var(--p-surface-ground) !important;
    --dv-tabs-and-actions-container-background-color: var(--p-content-background) !important;
    --dv-activegroup-visiblepanel-tab-background-color: var(--p-surface-ground) !important;
    --dv-activegroup-hiddenpanel-tab-background-color: var(--p-content-background) !important;
    --dv-inactivegroup-visiblepanel-tab-background-color: var(--p-surface-ground) !important;
    --dv-inactivegroup-hiddenpanel-tab-background-color: var(--p-content-background) !important;
    --dv-activegroup-visiblepanel-tab-color: color-mix(in srgb, var(--p-text-color) 72%, transparent) !important;
    --dv-activegroup-hiddenpanel-tab-color: color-mix(in srgb, var(--p-text-muted-color) 78%, transparent) !important;
    --dv-inactivegroup-visiblepanel-tab-color: color-mix(in srgb, var(--p-text-muted-color) 72%, transparent) !important;
    --dv-inactivegroup-hiddenpanel-tab-color: color-mix(in srgb, var(--p-text-muted-color) 54%, transparent) !important;
    --dv-tab-divider-color: transparent !important;
    --dv-separator-border: color-mix(in srgb, var(--p-surface-border) 26%, transparent) !important;
    --dv-paneview-header-border-color: var(--p-surface-border) !important;
    --dv-icon-hover-background-color: color-mix(in srgb, var(--p-primary-color) 14%, transparent) !important;
    --dv-drag-over-background-color: color-mix(in srgb, var(--p-primary-color) 18%, transparent) !important;
    --dv-drag-over-border-color: var(--p-primary-color) !important;
    --dv-drag-over-border: 1px solid var(--p-primary-color) !important;
    --dv-sash-color: transparent !important;
    --dv-active-sash-color: transparent !important;
    --dv-active-sash-transition-delay: 0s !important;
    --dv-scrollbar-background-color: color-mix(in srgb, var(--p-text-muted-color) 28%, transparent) !important;
    --dv-floating-box-shadow: 0 14px 36px rgba(0, 0, 0, .22), 0 3px 10px rgba(0, 0, 0, .12) !important;
    --dv-floating-border: 1px solid var(--p-surface-border) !important;
    --dv-floating-titlebar-background-color: var(--p-content-background) !important;
    --dv-floating-titlebar-border-bottom: 1px solid var(--p-surface-border) !important;
    --dv-border-radius: 0 !important;
    --dv-tab-border-radius: 0 !important;
    --dv-tab-margin: 0 !important;
    --dv-spacing-padding: 0 !important;
}

.simulation-dockview {
    width: 100%;
    height: 100%;
}

:deep(.dock-panel-content) {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

:deep(.schedule-panel) {
    position: relative;
    display: flex;
    padding: .5rem;
    overflow: hidden;
    background: var(--p-surface-ground);
}

:deep(.schedule-pane) {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
}

:deep(.dv-dockview),
:deep(.dv-grid-view),
:deep(.dv-branch-node),
:deep(.dv-resize-container),
:deep(.dv-split-view),
:deep(.dv-view),
:deep(.dv-void-container),
:deep(.dv-tabs-container),
:deep(.dv-actions-container) {
    background: var(--p-surface-ground) !important;
}

:deep(.dv-tabs-and-actions-container) {
    background: var(--p-content-background) !important;
    border-bottom: 1px solid color-mix(in srgb, var(--p-surface-border) 30%, transparent) !important;
}

:deep(.dv-groupview) {
    background: var(--p-surface-ground) !important;
    border: 0 !important;
}

:deep(.dv-content-container) {
    background: var(--p-surface-ground) !important;
}

:deep(.dv-tab-divider) {
    background: transparent;
}

:deep(.dv-split-view-container.dv-separator-border .dv-view:not(:first-child)::before) {
    background-color: color-mix(in srgb, var(--p-surface-border) 22%, transparent) !important;
}

:deep(.dv-sash) {
    background: transparent !important;
}

:deep(.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash) {
    width: 10px;
}

:deep(.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash) {
    height: 10px;
}

:deep(.dv-sash:hover) {
    background: transparent !important;
}

:deep(.dv-sash.dv-active),
:deep(.dv-sash.active) {
    background: transparent !important;
}

:deep(.dv-sash::after) {
    content: '';
    position: absolute;
    opacity: 0;
    pointer-events: none;
    background: color-mix(in srgb, var(--p-primary-color) 34%, transparent);
    transition: opacity .12s ease;
}

:deep(.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash::after) {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 3px;
    transform: translateX(-50%);
}

:deep(.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash::after) {
    left: 0;
    right: 0;
    top: 50%;
    height: 3px;
    transform: translateY(-50%);
}

:deep(.dv-sash:hover::after),
:deep(.dv-sash:active::after) {
    opacity: 1;
}

:deep(.dv-tab) {
    font-family: Montserrat, sans-serif;
    font-size: .68rem;
    font-weight: 500;
    color: color-mix(in srgb, var(--p-text-muted-color) 72%, transparent) !important;
    background: transparent !important;
    border-radius: 0 !important;
    opacity: .72;
    min-width: 0;
}

:deep(.dv-tab),
:deep(.dv-tab *),
:deep(.dv-default-tab),
:deep(.dv-default-tab *) {
    outline: none !important;
}

:deep(.dv-tab.dv-active-tab) {
    color: color-mix(in srgb, var(--p-text-color) 76%, transparent) !important;
    background: transparent !important;
    opacity: .9;
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--p-primary-color) 42%, transparent);
}

:deep(.dv-groupview.dv-active-group > .dv-tabs-and-actions-container),
:deep(.dv-groupview.dv-inactive-group > .dv-tabs-and-actions-container) {
    border-top: 0 !important;
    border-right: 0 !important;
    border-left: 0 !important;
    border-bottom: 1px solid color-mix(in srgb, var(--p-surface-border) 30%, transparent) !important;
    outline: none !important;
    box-shadow: none !important;
}

:deep(.dv-groupview.dv-active-group > .dv-tabs-and-actions-container .dv-tab),
:deep(.dv-groupview.dv-inactive-group > .dv-tabs-and-actions-container .dv-tab),
:deep(.dv-groupview.dv-active-group > .dv-tabs-and-actions-container .dv-tab.dv-active-tab),
:deep(.dv-groupview.dv-inactive-group > .dv-tabs-and-actions-container .dv-tab.dv-active-tab),
:deep(.dv-groupview.dv-active-group > .dv-tabs-and-actions-container .dv-tab.dv-inactive-tab),
:deep(.dv-groupview.dv-inactive-group > .dv-tabs-and-actions-container .dv-tab.dv-inactive-tab) {
    border: 0 !important;
    border-top: 0 !important;
    border-bottom: 0 !important;
    background: transparent !important;
    outline: none !important;
}

:deep(.dv-tab::before),
:deep(.dv-tab::after),
:deep(.dv-default-tab::before),
:deep(.dv-default-tab::after) {
    display: none !important;
    content: none !important;
}

:deep(.dv-tab:focus),
:deep(.dv-tab:focus-visible),
:deep(.dv-tab:active),
:deep(.dv-default-tab:focus),
:deep(.dv-default-tab:focus-visible),
:deep(.dv-default-tab:active) {
    color: color-mix(in srgb, var(--p-text-color) 76%, transparent) !important;
    background: transparent !important;
    outline: none !important;
    box-shadow: none !important;
}

:deep(.dv-tab:hover) {
    color: color-mix(in srgb, var(--p-text-color) 84%, transparent) !important;
    background: color-mix(in srgb, var(--p-primary-color) 4%, transparent) !important;
    opacity: .95;
}

:deep(.dv-tab.dv-active-tab),
:deep(.dv-tab.dv-active-tab:focus),
:deep(.dv-tab.dv-active-tab:focus-visible),
:deep(.dv-tab.dv-active-tab:active) {
    color: color-mix(in srgb, var(--p-text-color) 76%, transparent) !important;
    background: transparent !important;
    opacity: .9;
    outline: none !important;
    border: 0 !important;
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--p-primary-color) 42%, transparent) !important;
}

:deep(.dv-tab:hover),
:deep(.dv-tab.dv-active-tab:hover) {
    color: color-mix(in srgb, var(--p-text-color) 84%, transparent) !important;
    background: color-mix(in srgb, var(--p-primary-color) 5%, transparent) !important;
}

:deep(.dv-tab.dv-tab-dragging),
:deep(.dv-tab.dv-tab-dragging:hover),
:deep(.dv-tab.dv-tab-dragging:active) {
    color: color-mix(in srgb, var(--p-text-color) 78%, transparent) !important;
    background: color-mix(in srgb, var(--p-primary-color) 7%, var(--p-content-background)) !important;
    border: 0 !important;
    outline: none !important;
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--p-primary-color) 30%, transparent) !important;
}

:deep(.dv-tab.dv-tab--dragging) {
    background: transparent !important;
    box-shadow: none !important;
}

:global(.dv-tab-ghost-drag),
:global(.dv-tab-ghost-drag.dv-tab),
:global(.dv-tab-ghost-drag .dv-default-tab) {
    color: color-mix(in srgb, var(--p-text-color) 78%, transparent) !important;
    background: color-mix(in srgb, var(--p-primary-color) 7%, var(--p-content-background)) !important;
    border: 1px solid color-mix(in srgb, var(--p-surface-border) 34%, transparent) !important;
    border-radius: 6px !important;
    outline: none !important;
    box-shadow: 0 8px 24px color-mix(in srgb, #000 14%, transparent) !important;
}

:global(.dv-tab-ghost-drag::before),
:global(.dv-tab-ghost-drag::after) {
    display: none !important;
    content: none !important;
}

:deep(.dv-tab .dv-default-tab .dv-default-tab-content) {
    margin-right: 2px;
}

:deep(.dv-tab .dv-default-tab .dv-default-tab-action) {
    width: 14px;
    height: 14px;
    padding: 1px;
}

:deep(.dv-tab .dv-default-tab .dv-default-tab-action svg) {
    width: 8px;
    height: 8px;
}

:deep(.dv-tab-close) {
    color: color-mix(in srgb, var(--p-text-muted-color) 70%, transparent);
    opacity: .34;
}

:deep(.dv-tab:hover .dv-tab-close),
:deep(.dv-tab.dv-active-tab .dv-tab-close) {
    opacity: .58;
}

:deep(.quiet-group-drag-ghost) {
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
}

:deep(.dv-watermark-container) {
    background: var(--p-surface-ground) !important;
    color: var(--p-text-muted-color) !important;
}

:deep(.dv-drop-target-anchor) {
    color: var(--p-primary-color);
}

:deep(.dv-floating-group) {
    border: var(--dv-floating-border);
    box-shadow: var(--dv-floating-box-shadow);
    background: var(--p-surface-ground);
}

:global(body.grs-dockview-dragging),
:global(body.grs-dockview-dragging *) {
    user-select: none !important;
    -webkit-user-select: none !important;
}

:global(body.grs-dockview-dragging .dock-panel-content),
:global(body.grs-dockview-dragging .schedule-panel),
:global(body.grs-dockview-dragging .schedule-view),
:global(body.grs-dockview-dragging .simulation-viewer),
:global(body.grs-dockview-dragging .network-diagram) {
    pointer-events: none !important;
}

:global(body.grs-dockview-dragging .dv-dockview),
:global(body.grs-dockview-dragging .dv-tabs-and-actions-container),
:global(body.grs-dockview-dragging .dv-tabs-container),
:global(body.grs-dockview-dragging .dv-actions-container),
:global(body.grs-dockview-dragging .dv-tab),
:global(body.grs-dockview-dragging .dv-sash),
:global(body.grs-dockview-dragging .dv-drop-target),
:global(body.grs-dockview-dragging .dv-drop-target-anchor) {
    pointer-events: auto !important;
}
</style>
