import { addProtocol, AttributionControl, Map as MlMap, NavigationControl, Popup } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { BASEMAP_STYLE, CLICKABLE, highlightLayers, TILES_SOURCE } from './map-style'
import type { Bbox } from './types'

/** PMTiles is a file format, not a tile server; this teaches MapLibre to read it. */
let registered = false
function registerPmtiles() {
  if (registered) return
  addProtocol('pmtiles', new Protocol().tile)
  registered = true
}

export interface SquareClick {
  bbox: Bbox
  edits: number
  task: number | null
  project: number
}

export class HighlightMap {
  readonly map: MlMap
  private ready = false

  constructor(container: HTMLElement, tilesUrl: string) {
    registerPmtiles()

    this.map = new MlMap({
      container,
      style: BASEMAP_STYLE,
      center: [10, 20],
      zoom: 1.6,
      attributionControl: false,
      // Lets the canvas survive a screenshot, which is half the point of this.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    })

    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    this.map.addControl(
      new AttributionControl({
        compact: true,
        customAttribution: '© OpenStreetMap contributors · basemap © OpenFreeMap',
      }),
    )

    this.map.on('load', () => {
      // A globe suits the "everywhere we have mapped" view — the work is spread
      // across four continents and a flat map exaggerates the spread. MapLibre
      // eases into mercator on its own as you zoom into a project.
      this.map.setProjection({ type: 'globe' })

      const { source, layers } = highlightLayers(tilesUrl)
      this.map.addSource(TILES_SOURCE, source as never)
      for (const layer of layers) this.map.addLayer(layer)
      this.ready = true
      this.onReadyHandlers.forEach((handler) => handler())
      this.onReadyHandlers = []
    })

    for (const id of CLICKABLE) {
      this.map.on('mouseenter', id, () => (this.map.getCanvas().style.cursor = 'pointer'))
      this.map.on('mouseleave', id, () => (this.map.getCanvas().style.cursor = ''))
    }
  }

  private onReadyHandlers: (() => void)[] = []

  onReady(handler: () => void) {
    if (this.ready) handler()
    else this.onReadyHandlers.push(handler)
  }

  /** Clicking a task square zooms to it. */
  onSquareClick(handler: (square: SquareClick) => void) {
    this.map.on('click', 'task-fill', (event) => {
      const feature = event.features?.[0]
      if (!feature) return
      handler({
        bbox: geometryBbox(feature.geometry),
        edits: Number(feature.properties?.edits ?? 0),
        task: feature.properties?.task ?? null,
        project: Number(feature.properties?.project),
      })
    })
  }

  /** Pulls back to the whole globe rather than fitting a world-sized bbox. */
  showWorld() {
    this.map.easeTo({ center: [12, 8], zoom: 1.5, duration: 900 })
  }

  zoomTo(bbox: Bbox, options: { padding?: number; maxZoom?: number; duration?: number } = {}) {
    this.map.fitBounds(bbox, {
      padding: options.padding ?? 40,
      maxZoom: options.maxZoom ?? 17,
      duration: options.duration ?? 900,
    })
  }

  popup(lngLat: [number, number], html: string) {
    new Popup({ closeButton: false, offset: 8 }).setLngLat(lngLat).setHTML(html).addTo(this.map)
  }

  /** Restricts the highlight layers to one project, or shows all of them. */
  filterToProject(id: number | null) {
    const filter = id === null ? null : (['==', ['get', 'project'], id] as never)
    for (const layer of [
      'task-fill',
      'task-outline',
      'task-label',
      'our-waterways',
      'our-roads',
      'our-buildings',
      'our-buildings-outline',
      'our-buildings-dot',
    ]) {
      if (this.map.getLayer(layer)) this.map.setFilter(layer, filter)
    }
  }

  resize() {
    this.map.resize()
  }
}

function geometryBbox(geometry: GeoJSON.Geometry): Bbox {
  const lons: number[] = []
  const lats: number[] = []
  const walk = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [lon, lat] = c as number[]
      lons.push(lon)
      lats.push(lat)
    } else {
      ;(c as unknown[]).forEach(walk)
    }
  }
  walk((geometry as { coordinates: unknown }).coordinates)
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}
