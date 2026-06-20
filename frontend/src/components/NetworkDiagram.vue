<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount, computed } from 'vue'
import { useScheduleStore } from '@/stores/scheduleStore'
import { useViewerStore } from '@/stores/viewerStore'
import { useSimulationStore } from '@/stores/simulationStore'
import { NetworkView } from '@/network/NetworkView'
import type { Core } from 'cytoscape'
import type { ContextTarget } from '@/network/editing/ContextDispatch'
import type { LinkKind, RawEditAction } from '@/network/editing/actions'
import { executeEdit } from '@/network/editing/executeEdit'
import { useTheme } from '@/composables/useTheme'
import ProgressSpinner from 'primevue/progressspinner'
import Button from 'primevue/button'
import ContextMenu from 'primevue/contextmenu'

const containerRef = ref<HTMLDivElement>()
const contextMenuRef = ref<InstanceType<typeof ContextMenu>>()
const scheduleStore = useScheduleStore()
const viewerStore = useViewerStore()
const simulationStore = useSimulationStore()
const networkView = new NetworkView()
const { isDark, onThemeChange } = useTheme()
const isDetailVisible = ref(false)
const contextTarget = ref<ContextTarget | null>(null)
const latestCy = ref<Core | null>(null)

const LINK_KINDS: { kind: LinkKind, label: string }[] = [
    { kind: 'activation', label: 'activation' },
    { kind: 'repression', label: 'repression' },
    { kind: 'proteolysis', label: 'proteolysis' },
]

/** Pick the lowest unused positive integer as the new gene name. */
function nextGeneName(taken: Set<string>): string {
    for (let n = 1; n <= taken.size + 1; n++) {
        const s = String(n)
        if (!taken.has(s)) return s
    }
    return String(taken.size + 1)
}

/**
 * Live source of truth for which gene names are in use right now. Reads cy
 * directly rather than `scheduleStore.allGenes` (which is derived from the
 * original loaded schedule and doesn't pick up optimistic create/delete).
 */
function takenGeneNames(): Set<string> {
    const cy = latestCy.value
    if (!cy) return new Set()
    return new Set(cy.nodes('.gene').map((n: any) => String(n.id())))
}

function emit(raw: RawEditAction): void {
    const cy = latestCy.value
    const net = scheduleStore.unionNetwork
    const spec = scheduleStore.schedule.spec
    if (!cy || !net || !spec) return
    const byPath = net.parameters_by_model_path ?? {}
    const model_path = viewerStore.activeModelPath ?? Object.keys(byPath)[0]
    if (!model_path) {
        console.warn('[NetworkDiagram] no model_path available; dropping edit', raw)
        return
    }
    executeEdit(raw, cy, {
        model_path,
        spec,
        segments: scheduleStore.segments,
        geneIds: takenGeneNames(),
        // Replacing scheduleStore.unionNetwork triggers the existing watch
        // that calls networkView.setNetwork, which now preserves positions
        // for any node id present in both the old and new graphs.
        onSuccess: (network) => {
            scheduleStore.unionNetwork = network
            // Mirror ScheduleEditor's save behaviour: when auto-run is enabled,
            // a successful edit kicks off a fresh simulation (TrackViewer watches
            // pendingAutoRun). The backend picks up the cached edits for this spec.
            if (simulationStore.autoRunOnSave) {
                simulationStore.pendingAutoRun = true
            }
        },
        onError: (msg) => console.warn('[edit]', msg),
    })
}

const backgroundMenuItems = computed(() => {
    const net = scheduleStore.unionNetwork
    const allGenes = scheduleStore.allGenes ?? []
    const allSpecies: string[] = net
        ? net.nodes.filter(n => n.kind === 'species').map(n => String(n.name))
        : []
    const hasSelection =
        viewerStore.selectedGenes.length > 0
        || viewerStore.selectedSpeciesNodes.length > 0
        || viewerStore.selectedOtherSpecies.length > 0
    return [
        {
            label: 'Add gene',
            command: () => {
                const tgt = contextTarget.value
                if (!tgt || tgt.kind !== 'background') return
                const name = nextGeneName(takenGeneNames())
                emit({ type: 'create_gene', name, position: tgt.position })
            },
        },
        { separator: true },
        {
            label: 'Select all genes',
            disabled: allGenes.length === 0,
            command: () => {
                viewerStore.selectedGenes = [...allGenes]
            },
        },
        {
            label: 'Select all species',
            disabled: allSpecies.length === 0,
            command: () => {
                viewerStore.selectedSpeciesNodes = allSpecies
                viewerStore.selectedOtherSpecies = scheduleStore.allOtherSpecies ?? []
            },
        },
        {
            label: 'Clear selection',
            disabled: !hasSelection,
            command: () => {
                viewerStore.selectedGenes = []
                viewerStore.selectedSpeciesNodes = []
                viewerStore.selectedOtherSpecies = []
            },
        },
    ]
})

const geneMenuItems = (geneId: string) => [
    {
        label: 'Rename gene',
        command: () => networkView.startGeneRename(geneId),
    },
    {
        label: 'Add regulatory link',
        items: LINK_KINDS.map(lk => ({
            label: lk.label,
            command: () => networkView.startEdgeDraw(geneId, lk.kind),
        })),
    },
    { separator: true },
    {
        label: 'Delete gene',
        command: () => emit({ type: 'delete_gene', geneId }),
    },
]

const reactionMenuItems = (nodeId: string, reactionName: string) => [
    {
        label: 'Rename reaction',
        command: () => networkView.startReactionRename(nodeId),
    },
    {
        label: 'Add reagent',
        items: [
            {
                label: 'input (pick a species)',
                command: () => networkView.startReagentConnection(reactionName, 'from'),
            },
            {
                label: 'output (pick a species)',
                command: () => networkView.startReagentConnection(reactionName, 'to'),
            },
        ],
    },
    { separator: true },
    {
        label: 'Delete reaction',
        command: () => emit({ type: 'delete_reaction', reactionName }),
    },
]

const reagentEdgeMenuItems = (reactionName: string, species: string, role: 'from' | 'to') => [
    {
        label: 'Remove connection',
        command: () => emit({ type: 'remove_reagent', reactionName, species, role }),
    },
]

const speciesMenuItems = (speciesId: string) => [
    {
        label: 'New reaction',
        items: [
            {
                label: 'with this as input',
                command: () => emit({ type: 'add_reaction', species: speciesId, role: 'from' }),
            },
            {
                label: 'with this as output',
                command: () => emit({ type: 'add_reaction', species: speciesId, role: 'to' }),
            },
        ],
    },
]

const regEdgeMenuItems = (source: string, target: string, currentKind: LinkKind) => [
    {
        label: 'Change kind',
        items: LINK_KINDS
            .filter(lk => lk.kind !== currentKind)
            .map(lk => ({
                label: lk.label,
                command: () => emit({
                    type: 'change_link_kind',
                    source, target, oldKind: currentKind, newKind: lk.kind,
                }),
            })),
    },
    { separator: true },
    {
        label: 'Delete link',
        command: () => emit({ type: 'delete_link', source, target, kind: currentKind }),
    },
]

const contextMenuItems = computed(() => {
    const tgt = contextTarget.value
    if (!tgt || tgt.kind === 'background') return backgroundMenuItems.value
    if (tgt.kind === 'gene') return geneMenuItems(tgt.id)
    if (tgt.kind === 'reaction') return reactionMenuItems(tgt.id, tgt.reactionName)
    if (tgt.kind === 'species') return speciesMenuItems(tgt.id)
    if (tgt.kind === 'reagent-edge') {
        return reagentEdgeMenuItems(tgt.reactionName, tgt.species, tgt.role)
    }
    if (tgt.kind === 'reg-edge') {
        return regEdgeMenuItems(tgt.source, tgt.target, tgt.linkKind as LinkKind)
    }
    return []
})

// Sync isDetailVisible when zoom or toggle changes detail visibility
networkView.onDetailChange = (visible: boolean) => {
    isDetailVisible.value = visible
}

/** Label for the active model shown in the bottom-left overlay.
 * Rect hover changes the active model (branch switching); instant hover does not.
 * When an execution path is available (rect hover), prefer matching by that to
 * disambiguate branches sharing the same model definition. */
const activeModelLabel = computed(() => {
    const modelPath = viewerStore.activeModelPath
    if (!modelPath) return null
    const segments = scheduleStore.segments
    const execPath = viewerStore.hoveredExecutionPath
    const seg = execPath
        ? segments.find(s => s.execution_path === execPath && s.from !== s.to)
        : segments.find(s => s.model_path === modelPath && s.from !== s.to)
    if (!seg) return null
    return {
        label: seg.label || modelPath,
        path: modelPath,
    }
})

onMounted(() => {
    networkView.init(containerRef, isDark.value)
    onThemeChange((dark) => networkView.applyTheme(dark))

    // Resolve parameter values against the active model. Read fresh on each
    // call so tooltips and inline chips reflect whichever model is active.
    //
    // Fallback: if the active model path has no entry (e.g. it points at an
    // instant model that wasn't reified, or there's only one model in the
    // schedule and the user hasn't hovered yet), pick the first available
    // model so chips still show meaningful values instead of `?`.
    networkView.setParameterLookup((symbol: string) => {
        const byPath = scheduleStore.unionNetwork?.parameters_by_model_path
        if (!byPath) return undefined
        const mp = viewerStore.activeModelPath
        if (mp && byPath[mp]) return byPath[mp]?.[symbol]
        const firstKey = Object.keys(byPath)[0]
        return firstKey ? byPath[firstKey]?.[symbol] : undefined
    })

    networkView.onEditAction = emit
    networkView.setGeneNameLookup(takenGeneNames)
    networkView.onCyReady = (cy) => { latestCy.value = cy }

    // Right-click resolves to a target (background / gene / regulatory edge)
    // and surfaces the matching context menu.
    networkView.onContextMenu = (target, evt) => {
        contextTarget.value = target
        contextMenuRef.value?.show(evt)
    }

    // Render when union network arrives
    if (scheduleStore.unionNetwork) {
        networkView.setNetwork(scheduleStore.unionNetwork, scheduleStore.geneColours ?? {})
        isDetailVisible.value = networkView.isDetailVisible
    }
})

// Refresh inline chip values whenever the user hovers a different model
// (timeline rectangles, branch switches, etc.).
watch(() => viewerStore.activeModelPath, () => {
    networkView.refreshParameterValues()
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

        <!-- Right-click context menu (selection bulk-actions) -->
        <ContextMenu ref="contextMenuRef" :model="contextMenuItems" />

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
