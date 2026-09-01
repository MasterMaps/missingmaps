import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson'
import type { Bbox } from './types'

/**
 * Both snapshots go to the main Overpass instance, and there is no fallback:
 * it is the only public one that both answers historical ("attic") queries and
 * sends CORS headers, which a page on GitHub Pages needs. The mirrors fail one
 * test or the other. Queries are therefore kept to a single map viewport.
 */
const OVERPASS = 'https://overpass-api.de/api/interpreter'

export interface Snapshot {
  /** Landuse, water bodies and green space — drawn underneath everything else. */
  areas: FeatureCollection<Polygon>
  buildings: FeatureCollection<Polygon>
  roads: FeatureCollection<LineString>
  waterways: FeatureCollection<LineString>
  stats: { buildings: number; roads: number; roadKm: number }
}

/** Tags that turn a closed way into an area rather than a line. */
const AREA_KEYS = ['building', 'building:part', 'landuse', 'leisure', 'amenity', 'natural']

const emptySnapshot = (): Snapshot => ({
  areas: { type: 'FeatureCollection', features: [] },
  buildings: { type: 'FeatureCollection', features: [] },
  roads: { type: 'FeatureCollection', features: [] },
  waterways: { type: 'FeatureCollection', features: [] },
  stats: { buildings: 0, roads: 0, roadKm: 0 },
})

interface OverpassWay {
  type: 'way'
  id: number
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
}

function buildQuery(bbox: Bbox, at: Date | null): string {
  // Overpass wants south,west,north,east.
  const [w, s, e, n] = bbox
  const box = `${s},${w},${n},${e}`
  const date = at ? `[date:"${at.toISOString().replace(/\.\d+Z$/, 'Z')}"]` : ''
  return `[out:json][timeout:90]${date};
(
  way["building"](${box});
  way["highway"](${box});
  way["waterway"~"^(river|stream|canal|ditch|drain)$"](${box});
  way["natural"~"^(water|wood|scrub|wetland|sand|bare_rock)$"](${box});
  way["landuse"](${box});
  way["leisure"~"^(park|garden|pitch|playground|golf_course)$"](${box});
);
out geom;`
}

const cache = new Map<string, Snapshot>()

const cacheKey = (bbox: Bbox, at: Date | null) =>
  `${bbox.map((v) => v.toFixed(4)).join(',')}@${at ? at.toISOString().slice(0, 10) : 'now'}`

/**
 * Fetches everything worth drawing inside `bbox`, either as it is now
 * (`at === null`) or as it stood at `at`.
 */
export async function fetchSnapshot(bbox: Bbox, at: Date | null, signal?: AbortSignal): Promise<Snapshot> {
  const key = cacheKey(bbox, at)
  const hit = cache.get(key)
  if (hit) return hit

  const body = await request(buildQuery(bbox, at), signal)
  const snapshot = toSnapshot(body.elements ?? [])
  cache.set(key, snapshot)
  // Each entry can hold thousands of features; drop the oldest once we have
  // more than a long browsing session would plausibly revisit.
  if (cache.size > 40) cache.delete(cache.keys().next().value!)
  return snapshot
}

/** 429 means all our query slots are busy, 504 that the instance is overloaded; both pass. */
const RETRYABLE = [429, 504]

async function request(query: string, signal?: AbortSignal, attempt = 0): Promise<{ elements: OverpassWay[] }> {
  let res: Response
  try {
    res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }), signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    // A network-level failure here usually means Overpass has cut us off for
    // querying too often, which reads as a CORS or "failed to fetch" error.
    throw new Error('Could not reach the Overpass API — it may be throttling this browser. Try again shortly.')
  }
  if (res.ok) return res.json()

  if (RETRYABLE.includes(res.status) && attempt < 2) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 4000 * (attempt + 1))
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })
    return request(query, signal, attempt + 1)
  }

  throw new Error(
    RETRYABLE.includes(res.status)
      ? 'Overpass is busy right now — pan the map or try again in a minute.'
      : `Overpass returned ${res.status}.`,
  )
}

/** Grows a viewport by `factor` so that small pans stay inside what we already fetched. */
export function padBbox(bbox: Bbox, factor = 0.25): Bbox {
  const [w, s, e, n] = bbox
  const dx = ((e - w) * factor) / 2
  const dy = ((n - s) * factor) / 2
  return [w - dx, s - dy, e + dx, n + dy]
}

export const contains = (outer: Bbox, inner: Bbox) =>
  outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]

function toSnapshot(elements: OverpassWay[]): Snapshot {
  const snapshot = emptySnapshot()

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    const tags = el.tags ?? {}
    const coords = el.geometry.map(({ lon, lat }) => [lon, lat] as [number, number])
    const closed =
      coords.length > 3 &&
      coords[0][0] === coords[coords.length - 1][0] &&
      coords[0][1] === coords[coords.length - 1][1]

    if (tags.highway) {
      snapshot.roads.features.push(line(el.id, tags, coords))
      snapshot.stats.roads++
      snapshot.stats.roadKm += lengthKm(coords)
      continue
    }
    if (tags.waterway && !closed) {
      snapshot.waterways.features.push(line(el.id, tags, coords))
      continue
    }
    if (!closed || !AREA_KEYS.some((k) => k in tags)) continue

    if (tags.building && tags.building !== 'no') {
      snapshot.buildings.features.push(polygon(el.id, tags, coords))
      snapshot.stats.buildings++
    } else {
      snapshot.areas.features.push(polygon(el.id, tags, coords))
    }
  }

  snapshot.stats.roadKm = Math.round(snapshot.stats.roadKm * 10) / 10
  return snapshot
}

const line = (id: number, tags: Record<string, string>, coords: number[][]): Feature<LineString> => ({
  type: 'Feature',
  id,
  properties: { ...tags, kind: tags.highway ?? tags.waterway },
  geometry: { type: 'LineString', coordinates: coords },
})

const polygon = (id: number, tags: Record<string, string>, coords: number[][]): Feature<Polygon> => ({
  type: 'Feature',
  id,
  properties: { ...tags, kind: areaKind(tags) },
  geometry: { type: 'Polygon', coordinates: [coords] },
})

function areaKind(tags: Record<string, string>): string {
  if (tags.natural === 'water' || tags.landuse === 'reservoir' || tags.landuse === 'basin') return 'water'
  if (tags.landuse === 'residential' || tags.landuse === 'retail' || tags.landuse === 'commercial')
    return 'built'
  if (tags.landuse === 'forest' || tags.natural === 'wood') return 'wood'
  if (tags.leisure || tags.landuse === 'grass' || tags.landuse === 'meadow') return 'green'
  if (tags.landuse === 'farmland' || tags.landuse === 'farmyard') return 'farm'
  return 'other'
}

/** Equirectangular approximation — plenty accurate over a single map view. */
function lengthKm(coords: number[][]): number {
  let km = 0
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1]
    const [lon2, lat2] = coords[i]
    const x = ((lon2 - lon1) * Math.PI) / 180 * Math.cos(((lat1 + lat2) / 2 * Math.PI) / 180)
    const y = ((lat2 - lat1) * Math.PI) / 180
    km += Math.hypot(x, y) * 6371
  }
  return km
}
