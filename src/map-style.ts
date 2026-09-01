import type { StyleSpecification } from 'maplibre-gl'

/**
 * A small OSM-Carto-flavoured style drawn entirely from GeoJSON we supply.
 *
 * Both panes have to use the exact same style — that is the whole point of the
 * comparison — and no tile server publishes historical raster tiles, so the
 * "before" side could never be a normal basemap anyway.
 */

/** A fresh object every time: two Map instances must not share source specs. */
const empty = () => ({ type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } })

export const SOURCES = ['areas', 'waterways', 'roads', 'buildings'] as const
export type SourceId = (typeof SOURCES)[number]

const colours = {
  background: '#f2efe9',
  water: '#aad3df',
  wood: '#add19e',
  green: '#cdebb0',
  farm: '#eef0d5',
  built: '#e4dfda',
  other: '#e8e6e1',
  buildingFill: '#cdab92',
  buildingLine: '#a5836b',
  roadCasing: '#c8c2ba',
  roadFill: '#ffffff',
  primary: '#fcd6a4',
  secondary: '#f7fabf',
  track: '#ac8331',
  label: '#5a5147',
  labelHalo: '#f2efe9',
}

/** The four zoom stops every line width is interpolated across. */
const STOPS = [12, 14, 18, 20] as const
/** Widths are given at z14 and z18; the outer stops are scaled off those. */
const scale = ([z14, z18]: Pair, zoom: number) =>
  zoom === 12 ? z14 * 0.4 : zoom === 14 ? z14 : zoom === 18 ? z18 : z18 * 1.6

type Pair = [number, number]

/** Line width in pixels, interpolated over zoom. */
const width = (z14: number, z18: number) =>
  ['interpolate', ['exponential', 1.6], ['zoom'], ...STOPS.flatMap((z) => [z, scale([z14, z18], z)])] as never

const MAJOR = ['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link']
const MEDIUM = ['secondary', 'tertiary', 'secondary_link', 'tertiary_link']

/**
 * Per-road-class width. MapLibre allows only one zoom expression per property,
 * so the `case` has to live inside each interpolation stop, not around it.
 */
const roadWidth = (major: Pair, medium: Pair, minor: Pair) =>
  [
    'interpolate',
    ['exponential', 1.6],
    ['zoom'],
    ...STOPS.flatMap((z) => [
      z,
      [
        'case',
        ['in', ['get', 'kind'], ['literal', MAJOR]], scale(major, z),
        ['in', ['get', 'kind'], ['literal', MEDIUM]], scale(medium, z),
        scale(minor, z),
      ],
    ]),
  ] as never

export function createStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: Object.fromEntries(SOURCES.map((id) => [id, empty()])),
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': colours.background } },

      {
        id: 'area-fill',
        type: 'fill',
        source: 'areas',
        paint: {
          'fill-color': [
            'match',
            ['get', 'kind'],
            'water', colours.water,
            'wood', colours.wood,
            'green', colours.green,
            'farm', colours.farm,
            'built', colours.built,
            colours.other,
          ],
          'fill-opacity': 0.9,
        },
      },

      {
        id: 'waterway-line',
        type: 'line',
        source: 'waterways',
        paint: { 'line-color': colours.water, 'line-width': width(1.5, 4) },
      },

      {
        id: 'road-casing',
        type: 'line',
        source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        filter: ['!', ['in', ['get', 'kind'], ['literal', ['path', 'footway', 'steps', 'track', 'cycleway']]]],
        paint: {
          'line-color': colours.roadCasing,
          'line-width': roadWidth([7, 20], [6, 16], [4, 11]),
        },
      },

      {
        id: 'road-fill',
        type: 'line',
        source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        filter: ['!', ['in', ['get', 'kind'], ['literal', ['path', 'footway', 'steps', 'track', 'cycleway']]]],
        paint: {
          'line-color': [
            'case',
            ['in', ['get', 'kind'], ['literal', MAJOR]], colours.primary,
            ['in', ['get', 'kind'], ['literal', ['secondary', 'secondary_link']]], colours.secondary,
            colours.roadFill,
          ] as never,
          'line-width': roadWidth([5, 17], [4, 13], [2.5, 8.5]),
        },
      },

      {
        id: 'path-line',
        type: 'line',
        source: 'roads',
        filter: ['in', ['get', 'kind'], ['literal', ['path', 'footway', 'steps', 'track', 'cycleway']]],
        paint: {
          'line-color': colours.track,
          'line-width': width(1, 2.5),
          'line-dasharray': [2, 2],
          'line-opacity': 0.7,
        },
      },

      {
        id: 'building-fill',
        type: 'fill',
        source: 'buildings',
        paint: { 'fill-color': colours.buildingFill, 'fill-opacity': 0.95 },
      },
      {
        id: 'building-outline',
        type: 'line',
        source: 'buildings',
        minzoom: 15,
        paint: { 'line-color': colours.buildingLine, 'line-width': width(0.4, 1) },
      },

      {
        id: 'road-label',
        type: 'symbol',
        source: 'roads',
        minzoom: 15,
        filter: ['has', 'name'],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-max-angle': 30,
        },
        paint: { 'text-color': colours.label, 'text-halo-color': colours.labelHalo, 'text-halo-width': 1.5 },
      },
    ],
  }
}
