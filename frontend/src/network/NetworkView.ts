/**
 * NetworkView - main orchestrator for the Cytoscape network diagram.
 *
 * Owns the cytoscape instance and lifecycle. Creates and coordinates
 * sub-modules: AdaptiveZoom, ModelFilter, SelectionSync, DynamicsSync.
 *
 * Usage:
 *   const view = new NetworkView()
 *   await view.init(containerRef)
 *   view.setNetwork(unionNetwork, geneColours)
 *   // ...
 *   view.destroy()
 */
import type { Core } from 'cytoscape'
import type { Ref } from 'vue'
import type { Parameter, UnionNetwork } from '@/types/network'
import cytoscape from 'cytoscape'
// @ts-ignore
import fcose from 'cytoscape-fcose'
// @ts-ignore
import svgExporter from 'cytoscape-svg'

import { getGeneViewElements } from './networkElements'
import { buildStylesheet, GENE_LABEL_STYLE, REACTION_LABEL_STYLE } from './networkStyles'
import { getTheme } from '@/config/theme'
import { AdaptiveZoom } from './AdaptiveZoom'
import { ModelFilter } from './ModelFilter'
import { SelectionSync } from './SelectionSync'
import { HoverSync } from './HoverSync'
import { DynamicsSync } from './DynamicsSync'
import { createEdgeTooltip, createNodeTooltip, type Tooltip } from './Tooltip'
import {
    InlineParameters,
    type ParameterValueLookup,
} from './editing/InlineParameters'
import type { RawEditActionHandler, LinkKind, ReagentRole } from './editing/actions'
import {
    ContextDispatch,
    type ContextMenuHandler,
} from './editing/ContextDispatch'
import { EdgeCreation } from './editing/EdgeCreation'
import { InlineRename } from './editing/InlineRename'
import { InlineEdgeNumber } from './editing/InlineEdgeNumber'
import { reactionNameFromRate } from './editing/reactionName'
import { saveFile } from '@/utils/saveFile'

/** Supplies the current set of taken gene names for rename collision checks. */
export type GeneNameLookup = () => Set<string>

cytoscape.use(fcose)
cytoscape.use(svgExporter)

/**
 * Everything we restore across a `setNetwork` rebuild so an edit doesn't
 * visually disturb the user's frame: where things were, where they were
 * looking, and what level of detail they were looking at.
 */
interface ViewState {
    positions: Map<string, { x: number, y: number }>
    pan: { x: number, y: number }
    zoom: number
    detailVisible: boolean
}

export class NetworkView {
    private cy: Core | null = null
    private container: HTMLDivElement | null = null
    private isDark = false

    private adaptiveZoom = new AdaptiveZoom()
    private modelFilter = new ModelFilter()
    private selectionSync = new SelectionSync()
    private hoverSync = new HoverSync()
    private dynamicsSync = new DynamicsSync()
    private inlineParameters = new InlineParameters()
    private contextDispatch = new ContextDispatch()
    private edgeCreation = new EdgeCreation()
    private inlineRename = new InlineRename()
    private inlineEdgeNumber = new InlineEdgeNumber()

    /** Stored so rename overlays (gene/reaction) can emit through one channel. */
    private editHandler: RawEditActionHandler | null = null
    /** Current taken gene names, for rename collision validation. */
    private geneNameLookup: GeneNameLookup = () => new Set()

    /**
     * Looks up a parameter's current value for the active model.
     * Replaced via `setParameterLookup`; defaults to "unknown" so tooltips
     * and inline chips gracefully degrade until wired up.
     */
    private parameterLookup: ParameterValueLookup = () => undefined

    private edgeTooltip: Tooltip = createEdgeTooltip(s => this.parameterLookup(s))
    private nodeTooltip: Tooltip = createNodeTooltip(s => this.parameterLookup(s))

    /** External callback for detail visibility changes (zoom or manual toggle). */
    private _onDetailChange: ((visible: boolean) => void) | null = null

    /** Register a callback for detail visibility changes. */
    set onDetailChange(cb: ((visible: boolean) => void) | null) {
        this._onDetailChange = cb
    }

    /** Fired with the new cytoscape instance after every `setNetwork`. */
    private _onCyReady: ((cy: Core) => void) | null = null
    set onCyReady(cb: ((cy: Core) => void) | null) {
        this._onCyReady = cb
        if (cb && this.cy) cb(this.cy)
    }

    /**
     * Register a handler invoked on right-click of any dispatchable target
     * (background, gene compound, regulatory edge). Receives the resolved
     * target plus the original `MouseEvent` (for PrimeVue `ContextMenu`
     * positioning).
     */
    set onContextMenu(cb: ContextMenuHandler | null) {
        this.contextDispatch.onContextMenu = cb
    }

    /**
     * Provide a callback that resolves a parameter symbol to its current
     * value for the active model. Called fresh on each render/edit, so
     * passing a function that reads from a reactive store keeps tooltips
     * and inline chips in sync with `viewerStore.activeModelPath`.
     */
    setParameterLookup(lookup: ParameterValueLookup): void {
        this.parameterLookup = lookup
        this.inlineParameters.setParameterLookup(lookup)
    }

    /**
     * Refresh inline chip values and parameter-driven edge data attributes
     * (e.g. `at`, which drives regulatory edge width via `mapData`). Call
     * when the active model changes so width/styles re-evaluate against the
     * newly selected model's parameter values.
     */
    refreshParameterValues(): void {
        this.inlineParameters.refreshValues()
        this.syncElementParameterData()
    }

    /**
     * Mirror `parameterLookup` into element `data(<name>)` attributes so any
     * cytoscape style rule using `mapData(<name>, ...)` re-evaluates. Edge
     * `parameters` arrays carry `{symbol, name}` slots — symbol keys the
     * model-specific value, name is the data attribute the style references.
     */
    private syncElementParameterData(): void {
        const cy = this.cy
        if (!cy) return
        cy.startBatch()
        cy.elements().forEach((el: any) => {
            const params = (el.data('parameters') ?? []) as Parameter[]
            for (const p of params) {
                const v = this.parameterLookup(p.symbol)
                if (v !== undefined) el.data(p.name, v)
            }
        })
        cy.endBatch()
    }

    /**
     * Register a handler invoked when the user commits any edit (parameter
     * change, link creation, rename, delete, ...). All editing submodules
     * funnel through this single channel. The action is "raw" — the caller
     * stamps the active `model_path` before dispatching.
     */
    set onEditAction(handler: RawEditActionHandler | null) {
        this.inlineParameters.onParameterChange = handler
            ? (symbol, value) => handler({ type: 'set_parameter', symbol, value })
            : null
        this.edgeCreation.onEdgeComplete = handler
            ? (source, target, kind) => handler({ type: 'create_link', source, target, kind })
            : null
        // Rename overlays (gene + reaction) emit through the stored handler;
        // see startGeneRename / startReactionRename.
        this.editHandler = handler
    }

    /** Supply gene-name lookup for in-flight rename collision validation. */
    setGeneNameLookup(lookup: GeneNameLookup): void {
        this.geneNameLookup = lookup
    }

    /** The active cytoscape instance, or null before `setNetwork`. */
    get cytoscape(): Core | null {
        return this.cy
    }

    /**
     * Initialise the cytoscape container.
     * Does not render anything until setNetwork() is called.
     */
    init(containerRef: Ref<HTMLDivElement | undefined>, isDark = false): void {
        if (!containerRef.value) return
        this.container = containerRef.value
        this.isDark = isDark
        this.applyContainerBackground()
    }

    /**
     * Set or replace the union network. Destroys the old graph and rebuilds.
     *
     * Position preservation: before destroying the previous cy we snapshot
     * every node's position by id. Any id that survives into the new graph
     * gets pinned (via fcose's `fixedNodeConstraint`), so existing nodes
     * stay exactly where the user placed them and only genuinely new
     * structure gets laid out. Used by the edit flow to make `apply →
     * reload-from-backend` feel like an in-place mutation.
     */
    setNetwork(network: UnionNetwork, geneColours: Record<string, string>): void {
        // Snapshot everything restorable BEFORE destroying — `cy.destroy()`
        // invalidates every element ref. Null on first-time loads, in which
        // case `restoreViewState` is a no-op and fcose does its full thing.
        const viewState = this.snapshotViewState()

        this.destroyCytoscape()

        if (!this.container) return

        const elements = getGeneViewElements(network, geneColours, this.isDark)

        this.cy = cytoscape({
            container: this.container,
            elements,
            wheelSensitivity: 0.1,
            style: buildStylesheet(this.isDark),
            layout: { name: 'preset' },
            userPanningEnabled: true,
            userZoomingEnabled: true,
            boxSelectionEnabled: false,
            selectionType: 'single',
        })

        // Elements are built from `link.properties` (the backend's default
        // model's values).  Sync to the currently active model before layout
        // so widths reflect the right model on first paint.
        this.syncElementParameterData()

        // Restore pan + zoom so an edit-reload doesn't visually jump.
        // Detail mode (gene vs species view) is restored after AdaptiveZoom
        // attaches — see `runLayout`'s layoutstop callback.
        this.restoreViewport(viewState)

        // Notify caller (e.g. editStore) about the new cy instance before
        // layout runs — they may want to bind handlers immediately.
        this._onCyReady?.(this.cy)

        // Run animated fcose layout; attach modules on completion
        this.runLayout(network, geneColours, viewState)
    }

    /** Destroy everything. */
    destroy(): void {
        this.destroyModules()
        this.destroyCytoscape()
        this.container = null
    }

    /** Re-apply theme on dark-mode toggle. */
    applyTheme(isDark: boolean): void {
        this.isDark = isDark
        this.applyContainerBackground()
        this.adaptiveZoom.applyTheme(isDark)
        this.inlineParameters.applyTheme(isDark)
        this.inlineRename.applyTheme(isDark)
        this.inlineEdgeNumber.applyTheme(isDark)
        if (this.cy) {
            this.cy.style(buildStylesheet(isDark))
        }
    }

    /** Begin drawing a new link of `kind` from the gene `sourceId`. */
    startEdgeDraw(sourceId: string, kind: LinkKind): void {
        this.edgeCreation.startDraw(sourceId, kind)
    }

    /** Begin inline rename of a gene compound. */
    startGeneRename(geneId: string): void {
        this.inlineRename.start({
            nodeId: geneId,
            initialValue: geneId,
            labelStyle: GENE_LABEL_STYLE,
            validate: (newName) =>
                !!newName && (newName === geneId || !this.geneNameLookup().has(newName)),
            onCommit: (newName) =>
                this.editHandler?.({ type: 'rename_gene', geneId, newName }),
        })
    }

    /**
     * Begin inline rename of an auxiliary reaction. `nodeId` is the reaction
     * node's structural cytoscape id; its declared name (the editable value)
     * comes from the rate symbol. No-op for non-renameable reactions.
     */
    startReactionRename(nodeId: string): void {
        if (!this.cy) return
        const ele = this.cy.getElementById(nodeId)
        if (!ele || ele.empty()) return
        const reactionName = reactionNameFromRate(ele.data('rate'))
        if (reactionName === null) return

        // Other reaction names in the graph, for collision validation.
        const taken = new Set(
            this.cy.nodes('[kind = "reaction"]')
                .map((n) => reactionNameFromRate(n.data('rate')))
                .filter((s): s is string => s !== null && s !== reactionName),
        )

        this.inlineRename.start({
            nodeId,
            initialValue: reactionName,
            labelStyle: REACTION_LABEL_STYLE,
            validate: (newName) => !!newName && !taken.has(newName),
            onCommit: (newName) =>
                this.editHandler?.({ type: 'rename_reaction', reactionName, newName }),
        })
    }

    /**
     * Arm a one-shot "pick a species" mode to connect a reagent to reaction
     * `reactionName` on side `role`. The next tap on a species node emits an
     * `add_reagent`; a tap on anything else (or Escape) cancels.
     */
    startReagentConnection(reactionName: string, role: ReagentRole): void {
        if (!this.cy) return
        const cy = this.cy
        const container = cy.container()
        if (container) container.style.cursor = 'crosshair'

        const cleanup = () => {
            if (container) container.style.cursor = ''
            cy.off('tap', onTap)
            document.removeEventListener('keydown', onKey)
        }
        const onTap = (evt: any) => {
            const t = evt.target
            cleanup()
            if (t !== cy && typeof t.isNode === 'function' && t.isNode()
                && t.data('kind') === 'species') {
                this.editHandler?.({
                    type: 'add_reagent', reactionName, species: String(t.id()), role,
                })
            }
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cleanup() }
        cy.on('tap', onTap)
        document.addEventListener('keydown', onKey)
    }

    /**
     * Open the inline stoichiometry editor on a substrate/product edge of an
     * auxiliary reaction. No-op for cascade edges (reaction endpoint has no
     * editable name). Commit emits `set_stoichiometry`.
     */
    private startStoichiometryEdit(edge: any): void {
        if (!this.cy) return
        const linkKind = String(edge.data('kind'))
        const role: ReagentRole = linkKind === 'substrate' ? 'from' : 'to'
        const species = String(linkKind === 'substrate' ? edge.data('source') : edge.data('target'))
        const reactionNodeId = String(linkKind === 'substrate' ? edge.data('target') : edge.data('source'))
        const reactionName = reactionNameFromRate(
            this.cy.getElementById(reactionNodeId).data('rate'),
        )
        if (reactionName === null) return
        const current = Number(edge.data('stoichiometry') ?? 1)

        this.inlineEdgeNumber.start({
            edgeId: String(edge.id()),
            initialValue: current,
            onCommit: (value) =>
                this.editHandler?.({ type: 'set_stoichiometry', reactionName, species, role, value }),
        })
    }

    /** Toggle between gene and species views manually. */
    toggleDetail(): void {
        this.adaptiveZoom.toggleDetail()
    }

    /** Export the current network as an SVG file download. */
    exportSVG(): void {
        if (!this.cy) return
        const svg: string = (this.cy as any).svg({ full: true, scale: 1.5 })
        const blob = new Blob([svg], { type: 'image/svg+xml' })
        saveFile(blob, {
            filename: 'network.svg',
            mimeType: 'image/svg+xml',
            filterName: 'SVG Image',
            extensions: ['svg'],
        })
    }

    /** Whether species/reaction detail is currently visible. */
    get isDetailVisible(): boolean {
        return this.adaptiveZoom.isDetailVisible
    }

    // ========================================================================
    // Internal
    // ========================================================================

    /**
     * Snapshot the current cy's node positions by id. Returns an empty map
     * if there's no cy yet — handy for the initial `setNetwork` where
     * everything is genuinely new and we want fcose to do its full thing.
     */
    /**
     * Capture everything restorable across a `setNetwork` rebuild:
     *   - per-node positions (pin via fcose `fixedNodeConstraint`)
     *   - viewport (pan + zoom)
     *   - detail mode (gene view vs species view)
     *
     * Returns `null` on first-time loads (no previous cy) so callers can
     * skip restoration and let fcose lay things out from scratch.
     *
     * Selection lives in `viewerStore` and persists across rebuilds on its
     * own; chip edit state is per-element and dies with the destroy, which
     * is fine — no edit can be in progress at this moment by construction
     * (`emit` only fires on commit).
     */
    private snapshotViewState(): ViewState | null {
        if (!this.cy) return null
        const positions = new Map<string, { x: number, y: number }>()
        this.cy.nodes().forEach((n: any) => {
            const p = n.position()
            positions.set(String(n.id()), { x: p.x, y: p.y })
        })
        const p = this.cy.pan()
        return {
            positions,
            pan: { x: p.x, y: p.y },
            zoom: this.cy.zoom(),
            detailVisible: this.adaptiveZoom.isDetailVisible,
        }
    }

    /** Restore pan + zoom on the freshly-created cy. No-op when null. */
    private restoreViewport(state: ViewState | null): void {
        if (!state || !this.cy) return
        this.cy.zoom(state.zoom)
        this.cy.pan(state.pan)
    }

    /**
     * Restore detail mode after AdaptiveZoom has attached. AdaptiveZoom
     * resets to gene view on attach and then auto-checks zoom 500ms later;
     * we short-circuit that by flipping immediately if needed.
     */
    private restoreDetailMode(state: ViewState | null): void {
        if (!state) return
        if (state.detailVisible !== this.adaptiveZoom.isDetailVisible) {
            this.adaptiveZoom.toggleDetail()
        }
    }

    private runLayout(
        network: UnionNetwork,
        geneColours: Record<string, string>,
        viewState: ViewState | null = null,
    ): void {
        if (!this.cy) return

        // Pin every node whose id survived from the previous graph. If 100%
        // of nodes are pinned, fcose effectively no-ops (existing layout
        // preserved exactly). If a handful are unpinned (e.g. a freshly
        // created gene), fcose places only those, relative to neighbours.
        const positions = viewState?.positions
        const fixedNodeConstraint = !positions || positions.size === 0
            ? undefined
            : this.cy.nodes()
                .map((n: any) => ({ id: String(n.id()), pos: positions.get(String(n.id())) }))
                .filter((e: any) => e.pos !== undefined)
                .map((e: any) => ({ nodeId: e.id, position: e.pos }))

        const hasFixed = fixedNodeConstraint !== undefined && fixedNodeConstraint.length > 0

        const layout = this.cy.layout({
            name: 'fcose',
            quality: 'proof',
            // Skip randomization when we're preserving most positions —
            // otherwise fcose perturbs even pinned nodes' neighbours.
            randomize: !hasFixed,
            // No animation on edit reloads — the pinned nodes don't move and
            // animating just the new ones for 400ms feels janky.
            animate: !hasFixed,
            animationDuration: 1000,
            fit: !hasFixed,
            padding: 50,
            ...(hasFixed ? { fixedNodeConstraint } : {}),
            nodeDimensionsIncludeLabels: true,
            uniformNodeDimensions: false,
            packComponents: true,
            // Strong repulsion to avoid overlap
            nodeRepulsion: 50000,
            idealEdgeLength: (edge: any) => {
                if (edge.data('kind') === 'differentiation_tree') return 10
                const weight = edge.data('weight') ?? 1
                // Softer scaling: sqrt dampens extreme differences
                return 150 / Math.sqrt(weight)
            },
            edgeElasticity: (edge: any) => {
                if (edge.data('kind') === 'differentiation_tree') return 0.05
                if (edge.hasClass('peripheral')) return 0.02
                return 0.45
            },
            nestingFactor: 0.1,
            gravity: 32.8,
            numIter: 1000,
            tile: true,
            tilingPaddingVertical: 30,
            tilingPaddingHorizontal: 30,
            gravityRangeCompound: 3.5,
            gravityCompound: 1.0,
            gravityRange: 3.8,
            initialEnergyOnIncremental: 1,
        } as any)

        layout.one('layoutstop', () => {
            if (!this.cy) return

            this.adaptiveZoom.attach(this.cy, network, geneColours, this.isDark)
            this.restoreDetailMode(viewState)
            this.modelFilter.attach(this.cy)
            this.selectionSync.attach(this.cy)
            this.hoverSync.attach(this.cy)
            this.dynamicsSync.attach(this.cy)
            this.edgeTooltip.attach(this.cy)
            this.nodeTooltip.attach(this.cy)
            this.inlineParameters.attach(this.cy, this.isDark)

            // Hovering a parameter chip should surface the same tooltip the
            // underlying element would show on direct hover.
            this.inlineParameters.onChipHover = (ele, x, y) => {
                const tooltip = ele.isEdge?.() ? this.edgeTooltip : this.nodeTooltip
                tooltip.showFor(ele, x, y)
            }
            this.inlineParameters.onChipLeave = () => {
                this.edgeTooltip.hide()
                this.nodeTooltip.hide()
            }

            // Double-click on background resets zoom and pan
            this.cy.on('dbltap', (evt) => {
                if (evt.target === this.cy) this.cy!.fit(undefined, 50)
            })

            this.contextDispatch.attach(this.cy)
            this.edgeCreation.attach(this.cy)
            this.inlineRename.attach(this.cy, this.isDark)
            this.inlineEdgeNumber.attach(this.cy, this.isDark)
            this.cy.on('tap', 'edge[kind="substrate"], edge[kind="product"]', (evt) => {
                this.startStoichiometryEdit(evt.target)
            })

            // When detail visibility changes (zoom or toggle), sync externally
            this.adaptiveZoom.onDetailChange = (visible: boolean) => {
                this.modelFilter.refresh()
                this.selectionSync.refresh()
                this.dynamicsSync.notifyDetailChanged(visible)
                this.inlineParameters.notifyDetailChanged()
                // Force cytoscape to re-evaluate styles for elements whose
                // classes just changed (e.g. `.species-view` adds/removes).
                // Without this, z-index changes can lag until the next
                // position/drag event triggers a redraw.
                this.cy?.style().update()
                this._onDetailChange?.(visible)
            }
        })

        layout.run()
    }

    private destroyModules(): void {
        this.adaptiveZoom.destroy()
        this.modelFilter.destroy()
        this.selectionSync.destroy()
        this.hoverSync.destroy()
        this.dynamicsSync.destroy()
        this.edgeTooltip.destroy()
        this.nodeTooltip.destroy()
        this.inlineParameters.destroy()
        this.contextDispatch.destroy()
        this.edgeCreation.destroy()
        this.inlineRename.destroy()
        this.inlineEdgeNumber.destroy()
    }

    private destroyCytoscape(): void {
        this.destroyModules()
        if (this.cy) {
            this.cy.destroy()
            this.cy = null
        }
    }

    private applyContainerBackground(): void {
        if (!this.container) return
        const t = getTheme(this.isDark)
        this.container.style.backgroundImage =
            'radial-gradient(circle, ' + t.network.dotGrid + ' 1px, transparent 1px)'
        this.container.style.backgroundSize = '30px 30px'
    }
}
