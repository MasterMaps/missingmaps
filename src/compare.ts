import { AttributionControl, Map as MlMap, type GeoJSONSource } from 'maplibre-gl'
import { createStyle, SOURCES } from './map-style'
import type { Snapshot } from './overpass'
import type { Bbox } from './types'

/** One half of the comparison: a map plus the caption strip above it. */
class Pane {
  readonly map: MlMap
  private readonly caption: HTMLElement
  private readonly stats: HTMLElement

  constructor(root: HTMLElement, title: string) {
    root.innerHTML = `
      <div class="pane-head"><span class="pane-title">${title}</span><span class="pane-date"></span></div>
      <div class="pane-map"></div>
      <div class="pane-stats"></div>`
    this.caption = root.querySelector('.pane-date')!
    this.stats = root.querySelector('.pane-stats')!
    this.map = new MlMap({
      container: root.querySelector('.pane-map') as HTMLElement,
      style: createStyle(),
      center: [0, 20],
      zoom: 2,
      attributionControl: false,
      // Keeps the last frame in the drawing buffer so the panes survive a
      // screenshot — the whole point of the app is showing these side by side.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    })
    this.map.addControl(
      new AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors' }),
    )
  }

  setDate(text: string) {
    this.caption.textContent = text
  }

  setSnapshot(snapshot: Snapshot | null) {
    for (const id of SOURCES) {
      const source = this.map.getSource(id) as GeoJSONSource | undefined
      source?.setData(snapshot ? snapshot[id] : { type: 'FeatureCollection', features: [] })
    }
    // Four `setData` calls land as four worker round trips; without an explicit
    // nudge the pane can sit on the previous frame and look empty.
    this.map.triggerRepaint()
    this.stats.innerHTML = snapshot
      ? `<b>${snapshot.stats.buildings.toLocaleString()}</b> buildings · <b>${snapshot.stats.roadKm.toLocaleString()}</b> km road`
      : ''
  }
}

export class Compare {
  readonly before: Pane
  readonly after: Pane
  private syncing = false

  constructor(beforeEl: HTMLElement, afterEl: HTMLElement) {
    this.before = new Pane(beforeEl, 'Before')
    this.after = new Pane(afterEl, 'After')
    this.link(this.before.map, this.after.map)
    this.link(this.after.map, this.before.map)
  }

  /** Mirrors camera movement one way; the `syncing` guard stops the echo. */
  private link(from: MlMap, to: MlMap) {
    from.on('move', () => {
      if (this.syncing) return
      this.syncing = true
      to.jumpTo({
        center: from.getCenter(),
        zoom: from.getZoom(),
        bearing: from.getBearing(),
        pitch: from.getPitch(),
      })
      this.syncing = false
    })
  }

  /** Fires after the user stops panning or zooming either map. */
  onViewChange(handler: () => void) {
    this.before.map.on('moveend', handler)
    this.after.map.on('moveend', handler)
  }

  onReady(handler: () => void) {
    let pending = 2
    const done = () => --pending === 0 && handler()
    for (const map of [this.before.map, this.after.map]) {
      // A caller that awaits something first can arrive after `load` has
      // already fired, and `once` would then never run.
      if (map.loaded()) done()
      else map.once('load', done)
    }
  }

  get zoom() {
    return this.before.map.getZoom()
  }

  /** The current viewport, padded a little so panning short distances stays cached. */
  get bbox(): Bbox {
    const b = this.before.map.getBounds()
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
  }

  fitBounds(bbox: Bbox, options: { maxZoom?: number; padding?: number } = {}) {
    this.before.map.fitBounds(bbox, { padding: options.padding ?? 24, maxZoom: options.maxZoom ?? 16, duration: 0 })
  }

  flyTo(centre: [number, number], zoom: number) {
    this.before.map.jumpTo({ center: centre, zoom })
  }

  resize() {
    this.before.map.resize()
    this.after.map.resize()
  }
}
