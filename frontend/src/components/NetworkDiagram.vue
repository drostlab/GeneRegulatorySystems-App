<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount, computed } from 'vue'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useViewerStore } from '@/stores/viewerStore'
import { NetworkView } from '@/network/NetworkView'
import { useTheme } from '@/composables/useTheme'
import ProgressSpinner from 'primevue/progressspinner'
import Button from 'primevue/button'

const containerRef = ref<HTMLDivElement>()
const scheduleStore = useScheduleStore()
const viewerStore = useViewerStore()
const networkView = new NetworkView()
const { isDark, onThemeChange } = useTheme()
const isDetailVisible = ref(false)

// Sync isDetailVisible when zoom or toggle changes detail visibility
networkView.onDetailChange = (visible: boolean) => {
    isDetailVisible.value = visible
}

/** Label for the active model shown in the bottom-left overlay.
 * Rect hover changes the active model (branch switching); instant hover does not. */
const activeModelLabel = computed(() => {
    const modelPath = viewerStore.activeModelPath
    if (!modelPath) return null
    const segments = scheduleStore.segments
    const seg = segments.find(s => s.model_path === modelPath && s.from !== s.to)
    if (!seg) return null
    return {
        label: seg.label || modelPath,
        path: modelPath,
    }
})

onMounted(() => {
    networkView.init(containerRef, isDark.value)
    onThemeChange((dark) => networkView.applyTheme(dark))

    // Render when union network arrives
    if (scheduleStore.unionNetwork) {
        networkView.setNetwork(scheduleStore.unionNetwork, scheduleStore.geneColours ?? {})
        isDetailVisible.value = networkView.isDetailVisible
    }
})

onBeforeUnmount(() => {
    networkView.destroy()
})

watch(() => scheduleStore.unionNetwork, (network) => {
    if (network) {
        networkView.setNetwork(network, scheduleStore.geneColours ?? {})
        isDetailVisible.value = networkView.isDetailVisible
    }
})

function toggleDetail(): void {
    networkView.toggleDetail()
    isDetailVisible.value = networkView.isDetailVisible
}

function exportSVG(): void {
    networkView.exportSVG()
}

defineExpose({ exportSVG })
</script>

<template>
    <div class="network-diagram-container">
        <div ref="containerRef" class="cytoscape-container" />

        <!-- Bottom-right controls -->
        <div class="controls">
            <Button
                :icon="isDetailVisible ? 'pi pi-search-minus' : 'pi pi-search-plus'"
                v-grs-tooltip="isDetailVisible ? 'Gene view' : 'Species view'"
                severity="secondary"
                size="small"
                text
                rounded
                @click="toggleDetail"
            />
        </div>

        <!-- Model info overlay -->
        <div v-if="activeModelLabel" class="model-label-overlay">
            <div class="model-label-name">{{ activeModelLabel.label }}</div>
            <div class="model-label-path">{{ activeModelLabel.path }}</div>
        </div>

        <!-- Dim overlay while schedule is validating (keep old network, no spinner) -->
        <div v-if="scheduleStore.isLoading && !scheduleStore.isNetworkLoading" class="disabled-overlay" />

        <!-- Spinner overlay while network is actually being fetched -->
        <div v-if="scheduleStore.isNetworkLoading" class="loading-overlay">
            <div class="loading-card">
                <ProgressSpinner style="width: 50px; height: 50px" stroke-width="3" />
                <div class="loading-text">Loading network...</div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.network-diagram-container {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
}

.cytoscape-container {
    width: 100%;
    height: 100%;
    position: absolute;
    inset: 0;
}

.controls {
    position: absolute;
    bottom: 8px;
    right: 8px;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 2px;
}

.model-label-overlay {
    position: absolute;
    bottom: 8px;
    left: 8px;
    background: var(--overlay-background);
    border: 1px solid var(--p-surface-border);
    border-radius: 8px;
    padding: 8px 12px;
    font-family: Montserrat, sans-serif;
    pointer-events: none;
    max-width: 60%;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.model-label-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--p-text-color);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.model-label-path {
    font-size: 10px;
    color: var(--p-text-muted-color);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}


</style>
