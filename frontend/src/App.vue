<script setup lang="ts">
import Splitter from 'primevue/splitter'
import SplitterPanel from 'primevue/splitterpanel'
import Button from 'primevue/button'
import SimulationWorkspace from './components/SimulationWorkspace.vue'
import LogDrawer from './components/LogDrawer.vue'
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useTheme } from './composables/useTheme'
import { useScheduleStore } from './stores/scheduleStore'
import { useLogStore } from './stores/logStore'
import { isTauri } from '@/config/api'

const { isDark, toggle } = useTheme()
const scheduleStore = useScheduleStore()
const logStore = useLogStore()

const simulationWorkspaceRef = ref<InstanceType<typeof SimulationWorkspace>>()
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
    unlistenFns.push(await listen('menu:export-network-svg', () => simulationWorkspaceRef.value?.exportNetworkSVG()))
    unlistenFns.push(await listen('menu:export-simulation-png', () => simulationWorkspaceRef.value?.exportSimulationSVG()))
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
                <SimulationWorkspace ref="simulationWorkspaceRef" class="visual-workspace" />
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

.visual-workspace {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
}

</style>
