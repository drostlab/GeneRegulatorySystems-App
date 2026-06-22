<script setup lang="ts">
import Splitter from 'primevue/splitter'
import SplitterPanel from 'primevue/splitterpanel'
import Button from 'primevue/button'
import ScheduleEditor from './components/ScheduleEditor.vue'
import NetworkDiagram from './components/NetworkDiagram.vue'
import SimulationViewer from './components/TrackViewer.vue'
import ScheduleViewer from './components/ScheduleViewer.vue'
import LoadingOverlay from './components/LoadingOverlay.vue'
import LogDrawer from './components/LogDrawer.vue'
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useTheme } from './composables/useTheme'
import { useScheduleStore } from './stores/scheduleStore'
import { useLogStore } from './stores/logStore'
import { isTauri } from '@/config/api'

const { isDark, toggle } = useTheme()
const scheduleStore = useScheduleStore()
const logStore = useLogStore()

const networkDiagramRef = ref<InstanceType<typeof NetworkDiagram>>()
const simulationViewerRef = ref<InstanceType<typeof SimulationViewer>>()
const rootSplitterRef = ref<{ initializePanels: () => void }>()

watch(() => logStore.drawerVisible, async () => {
    await nextTick()
    rootSplitterRef.value?.initializePanels()
})

// Native File > Export submenu items fire these events.
const unlistenFns: Array<() => void> = []
onMounted(async () => {
    if (!isTauri()) return
    const { listen } = await import('@tauri-apps/api/event')
    unlistenFns.push(await listen('menu:export-schedule-json', () => scheduleStore.downloadSchedule()))
    unlistenFns.push(await listen('menu:export-network-svg', () => networkDiagramRef.value?.exportSVG()))
    unlistenFns.push(await listen('menu:export-simulation-png', () => simulationViewerRef.value?.exportSVG()))
})
onBeforeUnmount(() => {
    unlistenFns.forEach(fn => fn())
    unlistenFns.length = 0
})
</script>

<template>
    <div class="app-shell" style="display: flex; flex-direction: column; width: 100vw; height: 100vh">
        <div class="top-right-controls">
            <Button
                :icon="isDark ? 'pi pi-moon' : 'pi pi-sun'"
                severity="secondary"
                text
                rounded
                v-grs-tooltip="'Toggle dark mode'"
                @click="toggle"
            />
        </div>
        <Splitter ref="rootSplitterRef" layout="vertical" style="flex: 1; overflow: hidden">
            <SplitterPanel style="display: flex; min-height: 0" :size="logStore.drawerVisible ? 75 : 100" :minSize="40">
                <!-- Main 3-panel layout with horizontal splitter -->
                <Splitter layout="horizontal" style="width: 100%; overflow: hidden">
                    <SplitterPanel style="display: flex; flex-direction: column" :size="30" :minSize="15">
                        <ScheduleEditor />
                    </SplitterPanel>

                    <SplitterPanel style="display: flex; flex-direction: column" :size="70" :minSize="50">
                        <Splitter layout="vertical" style="height: 100%; width: 100%">
                            <SplitterPanel style="display: flex; width: 100%" :size="45" :minSize="20">
                                <NetworkDiagram ref="networkDiagramRef" />
                            </SplitterPanel>

                            <SplitterPanel style="display: flex; flex-direction: column; width: 100%" :size="55" :minSize="20">
                                <div class="schedule-pane-host">
                                    <ScheduleViewer
                                        class="schedule-pane"
                                        :segments="scheduleStore.segments"
                                        :model-activations="scheduleStore.modelActivations"
                                        :each-prefixes="scheduleStore.eachPrefixes"
                                        :operators="scheduleStore.scheduleOperators"
                                    />
                                    <LoadingOverlay
                                        v-if="scheduleStore.isLoading"
                                        label="Loading schedule…"
                                    />
                                </div>
                                <SimulationViewer ref="simulationViewerRef" class="track-pane" />
                            </SplitterPanel>
                        </Splitter>
                    </SplitterPanel>
                </Splitter>
            </SplitterPanel>
            <SplitterPanel
                v-if="logStore.drawerVisible"
                style="display: flex; min-height: 0"
                :size="25"
                :minSize="10"
            >
                <LogDrawer />
            </SplitterPanel>
        </Splitter>
    </div>
</template>

<style scoped>
.top-right-controls {
    position: fixed;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 1000;
    display: flex;
    flex-direction: row;
    gap: 2px;
}

.schedule-pane {
    flex: 1 1 auto;
    min-height: 0;
}

.schedule-pane-host {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    min-height: 0;
    padding: .5rem;
    overflow: hidden;
    background: var(--p-surface-ground);
}

.track-pane {
    flex: 1 1 auto;
    min-height: 0;
}
</style>
