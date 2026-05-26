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
import { buildStylesheet } from './networkStyles'
import { getTheme } from '@/config/theme'
import { AdaptiveZoom } from './AdaptiveZoom'
import { ModelFilter } from './ModelFilter'
import { SelectionSync } from './SelectionSync'
import { HoverSync } from './HoverSync'
import { DynamicsSync } from './DynamicsSync'
import { createEdgeTooltip, createNodeTooltip, type Tooltip } from './Tooltip'
import {
    InlineParameters,
    type ParameterChangeHandler,
    type ParameterValueLookup,
} from './InlineParameters'
import { saveFile } from '@/utils/saveFile'

cytoscape.use(fcose)
cytoscape.use(svgExporter)

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

    /** External callback for right-click on the network background. */
    private _onContextMenu: ((evt: MouseEvent) => void) | null = null

    /**
     * Register a handler invoked on right-click of the cytoscape background
     * (not on an element). The handler receives the original `MouseEvent`
     * with `clientX/Y`; useful for surfacing a PrimeVue `ContextMenu`.
     */
    set onContextMenu(cb: ((evt: MouseEvent) => void) | null) {
        this._onContextMenu = cb
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
     * Register a handler invoked when a user commits a new value via an
     * inline parameter chip. The handler receives the canonical parameter
     * symbol and the parsed numeric value.
     */
    set onParameterChange(handler: ParameterChangeHandler | null) {
        this.inlineParameters.onParameterChange = handler
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
     */
    setNetwork(network: UnionNetwork, geneColours: Record<string, string>): void {
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

        // Run animated fcose layout; attach modules on completion
        this.runLayout(network, geneColours)
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
        if (this.cy) {
            this.cy.style(buildStylesheet(isDark))
        }
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

    private runLayout(network: UnionNetwork, geneColours: Record<string, string>): void {
        if (!this.cy) return

        const layout = this.cy.layout({
            name: 'fcose',
            quality: 'proof',
            randomize: true,
            animate: true,
            animationDuration: 1000,
            fit: true,
            padding: 50,
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

            // Right-click on background -> external context menu (e.g. for
            // "Select all genes / species / Clear selection" actions).
            this.cy.on('cxttap', (evt: any) => {
                if (evt.target !== this.cy) return
                const oe = evt.originalEvent as MouseEvent | undefined
                if (!oe || !this._onContextMenu) return
                oe.preventDefault?.()
                this._onContextMenu(oe)
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
