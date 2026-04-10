<script setup lang="ts">
import Splitter from 'primevue/splitter'
import SplitterPanel from 'primevue/splitterpanel'
import Button from 'primevue/button'
import Menu from 'primevue/menu'
import ScheduleEditor from './components/ScheduleEditor.vue'
import NetworkDiagram from './components/NetworkDiagram.vue'
import SimulationViewer from './components/TrackViewer.vue'
import LogDrawer from './components/LogDrawer.vue'
import { ref } from 'vue'
import { useTheme } from './composables/useTheme'
import { useScheduleStore } from './stores/scheduleStore'

const { isDark, toggle } = useTheme()
const scheduleStore = useScheduleStore()

const networkDiagramRef = ref<InstanceType<typeof NetworkDiagram>>()
const simulationViewerRef = ref<InstanceType<typeof SimulationViewer>>()
const exportMenu = ref()

const exportMenuItems = [
    {
        label: 'Schedule spec (JSON)',
        icon: 'pi pi-file',
        command: () => scheduleStore.downloadSchedule(),
    },
    {
        label: 'Network diagram (SVG)',
        icon: 'pi pi-share-alt',
        command: () => networkDiagramRef.value?.exportSVG(),
    },
    {
        label: 'Simulation chart (PNG)',
        icon: 'pi pi-chart-line',
        command: () => simulationViewerRef.value?.exportSVG(),
    },
]

function toggleExportMenu(event: Event): void {
    exportMenu.value.toggle(event)
}
</script>

<template>
    <div style="display: flex; flex-direction: column; width: 100vw; height: 100vh">
        <div class="top-right-controls">
            <Button
                icon="pi pi-download"
                severity="secondary"
                text
                rounded
                aria-label="Export"
                v-grs-tooltip="'Export'"
                @click="toggleExportMenu"
            />
            <Menu ref="exportMenu" :model="exportMenuItems" popup />
            <Button
                :icon="isDark ? 'pi pi-moon' : 'pi pi-sun'"
                severity="secondary"
                text
                rounded
                v-grs-tooltip="'Toggle dark mode'"
                @click="toggle"
            />
        </div>
        <!-- Main 3-panel layout with horizontal splitter -->
        <Splitter layout="horizontal" style="flex: 1; overflow: hidden">
            <SplitterPanel style="display: flex; flex-direction: column" :size="30" :minSize="15">
                <ScheduleEditor />
            </SplitterPanel>

            <SplitterPanel style="display: flex; flex-direction: column" :size="70" :minSize="50">
                <Splitter layout="vertical" style="height: 100%; width: 100%">
                    <SplitterPanel style="display: flex; width: 100%" :size="45" :minSize="20">
                        <NetworkDiagram ref="networkDiagramRef" />
                    </SplitterPanel>
                        
                    
                    <SplitterPanel style="display: flex; width: 100%" :size="55" :minSize="20">
                        <SimulationViewer ref="simulationViewerRef" />
                    </SplitterPanel>
                </Splitter>
            </SplitterPanel>
        </Splitter>
        <LogDrawer />
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
</style>