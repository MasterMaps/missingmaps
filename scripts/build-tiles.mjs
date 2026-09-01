#!/usr/bin/env node
/**
 * Builds public/tiles/iugnorge.pmtiles — everything the group put on the map,
 * and nothing else.
 *
 * The archive holds only features whose current version belongs to one of our
 * #iugnorge changesets, plus the Tasking Manager task squares that contain at
 * least one of them. Surrounding context comes from an ordinary basemap at
 * runtime, so this stays small enough to live in the repository and the app
 * never has to query Overpass.
 *
 * Layers: buildings, roads, waterways, tasks.
 *
 * Attribution is by the changeset that last touched a way, which is exact for
 * anything nobody has edited since and an undercount otherwise — a building we
 * drew and someone else later squared off now belongs to their changeset. It
 * undercounts; it never claims someone else's work.
 *
 * Runs in CI: it queries Overpass once per project area, and Overpass firewalls
 * clients that do that from a shared address.
 *
 * Usage:
 *   node scripts/build-tiles.mjs [--only 49638,63366] [--outdir public/tiles]
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_FILE = resolve(ROOT, 'public/data/projects.json')

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const TM_API = 'https://tasking-manager-production-api.hotosm.org/api/v2'
const UA = 'missingmaps-iug/1.0 (+https://github.com/MasterMaps/missingmaps)'

/** Overpass struggles with very large areas, so big AOIs are queried in pieces. */
const MAX_SPAN_DEG = 0.25

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const OUT_DIR = resolve(ROOT, flag('outdir', 'public/tiles'))
const WORK_DIR = resolve(ROOT, '.tiles-work')
const only = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* --------------------------------------------------------------- overpass */

const query = (bbox) => {
  const [w, s, e, n] = bbox
  const box = `${s},${w},${n},${e}`
  // Only what humanitarian mapping actually produces. Landuse and natural
  // features are left to the basemap.
  return `[out:json][timeout:600];
(
  way["building"](${box});
  way["highway"](${box});
  way["waterway"](${box});
);
out meta geom;`
}

async function overpass(data, label) {
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'User-Agent': UA },
        body: new URLSearchParams({ data }),
      })
    } catch (err) {
      if (attempt >= 5) throw new Error(`${label}: ${err.message}`)
      await sleep(30_000)
      continue
    }
    if (res.ok) return res.json()
    if (![429, 504].includes(res.status) || attempt >= 5) throw new Error(`${label}: HTTP ${res.status}`)
    const wait = Number(res.headers.get('retry-after')) * 1000 || 30_000 * (attempt + 1)
    console.log(`    busy, waiting ${Math.round(wait / 1000)}s`)
    await sleep(wait)
  }
}

/** Splits a bbox into pieces no larger than MAX_SPAN_DEG on a side. */
function splitBbox([w, s, e, n]) {
  const cols = Math.max(1, Math.ceil((e - w) / MAX_SPAN_DEG))
  const rows = Math.max(1, Math.ceil((n - s) / MAX_SPAN_DEG))
  const out = []
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      out.push([
        w + ((e - w) * x) / cols,
        s + ((n - s) * y) / rows,
        w + ((e - w) * (x + 1)) / cols,
        s + ((n - s) * (y + 1)) / rows,
      ])
    }
  }
  return out
}

/* -------------------------------------------------------------- geometry */

const round = (v) => Math.round(v * 1e6) / 1e6

/** Turns one of our ways into a GeoJSON feature, or null if it is not drawable. */
function toFeature(el, project) {
  const tags = el.tags ?? {}
  const coords = el.geometry.map(({ lon, lat }) => [round(lon), round(lat)])
  const closed =
    coords.length > 3 &&
    coords[0][0] === coords[coords.length - 1][0] &&
    coords[0][1] === coords[coords.length - 1][1]

  const properties = { project, year: Number((el.timestamp || '').slice(0, 4)) || null }

  if (tags.building && tags.building !== 'no' && closed) {
    return ['buildings', properties, { type: 'Polygon', coordinates: [coords] }]
  }
  if (tags.highway) {
    return ['roads', { ...properties, kind: tags.highway }, { type: 'LineString', coordinates: coords }]
  }
  if (tags.waterway) {
    return ['waterways', { ...properties, kind: tags.waterway }, { type: 'LineString', coordinates: coords }]
  }
  return null
}

const centroid = (coords) => {
  let x = 0
  let y = 0
  for (const [lon, lat] of coords) {
    x += lon
    y += lat
  }
  return [x / coords.length, y / coords.length]
}

const bboxOf = (geometry) => {
  const lons = []
  const lats = []
  const walk = (c) => (typeof c[0] === 'number' ? (lons.push(c[0]), lats.push(c[1])) : c.forEach(walk))
  walk(geometry.coordinates)
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}

/**
 * The task squares the group actually worked in. A square counts only if one of
 * our features falls inside it — a square someone merely marked done does not.
 */
async function ourTaskSquares(projectId, points) {
  let body
  try {
    const res = await fetch(`${TM_API}/projects/${projectId}/tasks/`, { headers: { 'User-Agent': UA } })
    if (!res.ok) return []
    body = await res.json()
  } catch {
    return []
  }

  const squares = []
  for (const feature of body.features || []) {
    if (!feature.geometry) continue
    const [w, s, e, n] = bboxOf(feature.geometry)
    let edits = 0
    for (const [lon, lat] of points) {
      if (lon >= w && lon <= e && lat >= s && lat <= n) edits++
    }
    if (!edits) continue
    squares.push({
      type: 'Feature',
      properties: { project: projectId, task: feature.properties?.taskId ?? null, edits },
      geometry: feature.geometry,
    })
  }
  return squares
}

/* ------------------------------------------------------------------ main */

const raw = JSON.parse(await readFile(DATA_FILE, 'utf8'))
const projects = raw.projects.filter(
  (p) => (p.bbox || p.editBbox) && p.changesets?.length && (!only.length || only.includes(p.id)),
)
console.log(`tiles: ${projects.length} projects with #${raw.hashtag} changesets\n`)

await rm(WORK_DIR, { recursive: true, force: true })
await mkdir(WORK_DIR, { recursive: true })

const layers = ['buildings', 'roads', 'waterways', 'tasks']
const streams = Object.fromEntries(layers.map((l) => [l, []]))
const perProject = {}

for (const [index, project] of projects.entries()) {
  const bbox = project.bbox ?? project.editBbox
  const label = `#${project.id} ${(project.name || '').slice(0, 40)}`
  console.log(`[${index + 1}/${projects.length}] ${label}`)

  const ourChangesets = new Set(project.changesets)
  const pieces = splitBbox(bbox)
  const ours = []

  try {
    for (const [i, piece] of pieces.entries()) {
      const suffix = pieces.length > 1 ? ` [${i + 1}/${pieces.length}]` : ''
      const body = await overpass(query(piece), `${label}${suffix}`)
      for (const el of body.elements || []) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
        if (!ourChangesets.has(el.changeset)) continue
        ours.push(el)
      }
      await sleep(2000) // Overpass allows two slots; one at a time is polite.
    }
  } catch (err) {
    console.warn(`  failed: ${err.message}`)
    continue
  }

  const points = []
  let kept = 0
  for (const el of ours) {
    const feature = toFeature(el, project.id)
    if (!feature) continue
    const [layer, properties, geometry] = feature
    streams[layer].push(JSON.stringify({ type: 'Feature', properties, geometry }))
    points.push(centroid(geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates))
    kept++
  }

  const squares = await ourTaskSquares(project.id, points)
  for (const square of squares) streams.tasks.push(JSON.stringify(square))

  perProject[project.id] = { features: kept, squares: squares.length }
  console.log(`  ${kept} features by us, ${squares.length} task squares`)
}

const totals = Object.values(perProject).reduce(
  (acc, p) => ({ features: acc.features + p.features, squares: acc.squares + p.squares }),
  { features: 0, squares: 0 },
)
console.log(`\ntiles: ${totals.features} features, ${totals.squares} task squares`)

const inputs = []
for (const layer of layers) {
  if (!streams[layer].length) continue
  const file = join(WORK_DIR, `${layer}.geojsonl`)
  await writeFile(file, streams[layer].join('\n') + '\n')
  inputs.push('-L', `${layer}:${file}`)
  console.log(`  ${layer}: ${streams[layer].length}`)
}
if (!inputs.length) {
  console.error('tiles: nothing to tile')
  process.exit(1)
}

await mkdir(OUT_DIR, { recursive: true })
const out = join(OUT_DIR, 'iugnorge.pmtiles')

// z16 is plenty for buildings and the app overzooms past it. Dropping is
// allowed only at the overview zooms, where the task squares carry the story
// anyway; from z12 in, every feature is present.
const tippecanoe = [
  '-o', out,
  '--force',
  '-Z4',
  '-z16',
  '--drop-densest-as-needed',
  '--extend-zooms-if-still-dropping',
  '--no-tile-size-limit',
  '--simplification=2',
  ...inputs,
]
console.log(`\ntippecanoe ${tippecanoe.join(' ')}\n`)
await new Promise((done, reject) => {
  const proc = spawn('tippecanoe', tippecanoe, { stdio: 'inherit' })
  proc.on('close', (code) => (code === 0 ? done() : reject(new Error(`tippecanoe exited ${code}`))))
  proc.on('error', reject)
})

await rm(WORK_DIR, { recursive: true, force: true })
console.log(`\nwrote ${out}`)
