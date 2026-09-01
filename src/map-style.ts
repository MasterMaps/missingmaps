import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'

/**
 * The map is an ordinary basemap with our own edits drawn on top of it, out of
 * one PMTiles archive that contains nothing but those edits.
 *
 * Basemap tiles come from OpenFreeMap, which needs no API key and sends CORS
 * headers — both required for a page served from GitHub Pages.
 */

export const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'
export const TILES_SOURCE = 'iugnorge'

export const colours = {
  building: '#e8590c',
  buildingLine: '#b34700',
  road: '#e8590c',
  water: '#1c7ed6',
  square: '#e8590c',
  squareText: '#8a3600',
}

/** The layers we add on top of the basemap, in draw order. */
export function highlightLayers(tilesUrl: string): {
  source: StyleSpecification['sources'][string]
  layers: LayerSpecification[]
} {
  return {
    source: { type: 'vector', url: `pmtiles://${tilesUrl}`, attribution: '© OpenStreetMap contributors' },
    layers: [
      // Task squares sit underneath: they are context for the edits, not the point.
      {
        id: 'task-fill',
        type: 'fill',
        source: TILES_SOURCE,
        'source-layer': 'tasks',
        paint: {
          'fill-color': colours.square,
          // Squares with more of our work in them read as more solid.
          'fill-opacity': [
            'interpolate',
            ['linear'],
            ['coalesce', ['get', 'edits'], 0],
            0, 0.04,
            50, 0.1,
            400, 0.18,
          ],
        },
      },
      {
        id: 'task-outline',
        type: 'line',
        source: TILES_SOURCE,
        'source-layer': 'tasks',
        paint: {
          'line-color': colours.square,
          'line-opacity': 0.55,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 1.2, 18, 2],
        },
      },
      {
        id: 'task-label',
        type: 'symbol',
        source: TILES_SOURCE,
        'source-layer': 'tasks',
        minzoom: 13,
        layout: {
          'text-field': ['concat', ['to-string', ['get', 'edits']], ' edits'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
        },
        paint: { 'text-color': colours.squareText, 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
      },

      {
        id: 'our-waterways',
        type: 'line',
        source: TILES_SOURCE,
        'source-layer': 'waterways',
        paint: {
          'line-color': colours.water,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 3.5],
        },
      },
      {
        id: 'our-roads',
        type: 'line',
        source: TILES_SOURCE,
        'source-layer': 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': colours.road,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 1, 14, 2.5, 18, 7],
        },
      },
      {
        id: 'our-buildings',
        type: 'fill',
        source: TILES_SOURCE,
        'source-layer': 'buildings',
        paint: { 'fill-color': colours.building, 'fill-opacity': 0.85 },
      },
      {
        id: 'our-buildings-outline',
        type: 'line',
        source: TILES_SOURCE,
        'source-layer': 'buildings',
        minzoom: 15,
        paint: { 'line-color': colours.buildingLine, 'line-width': 0.6 },
      },
      // At overview zooms individual buildings vanish into nothing, so give
      // them a dot that survives being 20 cm wide on screen.
      {
        id: 'our-buildings-dot',
        type: 'circle',
        source: TILES_SOURCE,
        'source-layer': 'buildings',
        maxzoom: 13,
        paint: {
          'circle-color': colours.building,
          'circle-opacity': 0.5,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1, 12, 2.5],
        },
      },
    ],
  }
}

/** Layer ids that respond to a click, most specific first. */
export const CLICKABLE = ['our-buildings', 'task-fill']
