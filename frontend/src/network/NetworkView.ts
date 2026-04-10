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
import type { UnionNetwork } from '@/types/network'
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
    private edgeTooltip: Tooltip = createEdgeTooltip()
    private nodeTooltip: Tooltip = createNodeTooltip()

    /** External callback for detail visibility changes (zoom or manual toggle). */
    private _onDetailChange: ((visible: boolean) => void) | null = null

    /** Register a callback for detail visibility changes. */
    set onDetailChange(cb: ((visible: boolean) => void) | null) {
        this._onDetailChange = cb
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

        const elements = getGeneViewElements(network, geneColours)
        console.debug(`[NetworkView] Rendering: ${elements.length} gene-level elements`)

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
            console.debug('[NetworkView] Layout complete, attaching modules')

            this.adaptiveZoom.attach(this.cy, network, geneColours)
            this.modelFilter.attach(this.cy)
            this.selectionSync.attach(this.cy)
            this.hoverSync.attach(this.cy)
            this.dynamicsSync.attach(this.cy)
            this.edgeTooltip.attach(this.cy)
            this.nodeTooltip.attach(this.cy)

            // Double-click on background resets zoom and pan
            this.cy.on('dbltap', (evt) => {
                if (evt.target === this.cy) this.cy!.fit(undefined, 50)
            })

            // When detail visibility changes (zoom or toggle), sync externally
            this.adaptiveZoom.onDetailChange = (visible: boolean) => {
                this.modelFilter.refresh()
                this.selectionSync.refresh()
                this.dynamicsSync.notifyDetailChanged(visible)
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
