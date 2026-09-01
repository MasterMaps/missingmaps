#!/usr/bin/env node
/**
 * Builds public/data/projects.json — the list of HOT Tasking Manager projects
 * that changesets tagged #iugnorge have contributed to.
 *
 * Three ways in, all merged into the same file:
 *
 *   replication  (no auth)  Walks the OSM minutely changeset replication feed
 *                           backwards from the current sequence and picks out
 *                           changesets carrying the hashtag. Cheap for a rolling
 *                           window (~11 MB / 6 s per 24 h), hopeless for years.
 *   osmcha       (token)    Queries the OSMCha API by hashtag. This is the only
 *                           practical way to backfill the full history.
 *   touched      (no auth)  For every mapper already in the roster, asks the
 *                           Tasking Manager which projects they have worked on.
 *                           Catches projects whose changesets we never scanned,
 *                           but only sees tasks the mapper marked done.
 *
 * Usage:
 *   node scripts/ingest.mjs replication [--minutes 1560]
 *   node scripts/ingest.mjs osmcha [--since 2019-01-01]   (needs OSMCHA_TOKEN)
 *   node scripts/ingest.mjs touched
 *   node scripts/ingest.mjs all
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_FILE = resolve(ROOT, 'public/data/projects.json')

const HASHTAG = (process.env.HASHTAG || 'iugnorge').toLowerCase()
const TM_API = 'https://tasking-manager-production-api.hotosm.org/api/v2'
const REPLICATION = 'https://planet.openstreetmap.org/replication/changesets'
const UA = `missingmaps-iug/1.0 (+https://github.com/MasterMaps/missingmaps)`

const args = process.argv.slice(2)
const mode = args[0] || 'replication'
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

/* ------------------------------------------------------------------ store */

const emptyStore = () => ({
  hashtag: HASHTAG,
  generated: null,
  lastSequence: null,
  mappers: [],
  projects: {},
})

async function loadStore() {
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, 'utf8'))
    // On disk projects are an array (nicer to diff); in memory they are a map.
    return { ...raw, projects: Object.fromEntries((raw.projects || []).map((p) => [p.id, p])) }
  } catch {
    return emptyStore()
  }
}

async function saveStore(store) {
  const projects = Object.values(store.projects).sort(
    (a, b) => (b.lastEdit || '').localeCompare(a.lastEdit || '') || b.id - a.id,
  )
  const out = { ...store, generated: new Date().toISOString(), projects }
  await mkdir(dirname(DATA_FILE), { recursive: true })
  await writeFile(DATA_FILE, JSON.stringify(out, null, 2) + '\n')
  console.log(`\nwrote ${DATA_FILE} — ${projects.length} projects, ${store.mappers.length} mappers`)
}

/**
 * Folds one changeset into the store. `cs` is the normalised shape
 * { id, user, createdAt, hashtags, comment, host, changes }.
 */
function record(store, cs) {
  const ids = new Set()
  for (const m of `${cs.hashtags || ''} ${cs.comment || ''}`.matchAll(/hotosm-project-(\d+)/gi)) ids.add(+m[1])
  for (const m of (cs.host || '').matchAll(/\/projects\/(\d+)/g)) ids.add(+m[1])
  if (!ids.size) return false

  if (cs.user && !store.mappers.includes(cs.user)) store.mappers.push(cs.user)

  for (const id of ids) {
    const p = (store.projects[id] ??= { id, source: 'changesets', changesets: [], mappers: [] })
    p.source = 'changesets' // a real changeset outranks a `touched` guess
    // A changeset shows up in several replication files (once open, once closed),
    // so everything cumulative below has to be guarded on first sight.
    const firstSight = !p.changesets.includes(cs.id)
    if (firstSight) p.changesets.push(cs.id)
    if (cs.user && !p.mappers.includes(cs.user)) p.mappers.push(cs.user)
    if (cs.createdAt) {
      if (!p.firstEdit || cs.createdAt < p.firstEdit) p.firstEdit = cs.createdAt
      if (!p.lastEdit || cs.createdAt > p.lastEdit) p.lastEdit = cs.createdAt
    }
    // Union of the changeset bounding boxes — this is where the group actually
    // worked, which frames the before/after view far better than the project AOI.
    if (cs.bbox && firstSight) {
      // Keep the changeset centres too — the app grid-bins them to find the
      // neighbourhood the group worked hardest on and frames the view there.
      const centre = [
        +(((cs.bbox[0] + cs.bbox[2]) / 2).toFixed(4)),
        +(((cs.bbox[1] + cs.bbox[3]) / 2).toFixed(4)),
      ]
      p.editPoints ??= []
      if (p.editPoints.length < 2000) p.editPoints.push(centre)

      p.editBbox = p.editBbox
        ? [
            Math.min(p.editBbox[0], cs.bbox[0]),
            Math.min(p.editBbox[1], cs.bbox[1]),
            Math.max(p.editBbox[2], cs.bbox[2]),
            Math.max(p.editBbox[3], cs.bbox[3]),
          ]
        : cs.bbox
    }
  }
  return true
}

/* -------------------------------------------------------------- fetch util */

async function get(url, { headers = {}, raw = false, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return raw ? Buffer.from(await res.arrayBuffer()) : await res.json()
    } catch (err) {
      if (attempt >= retries) throw err
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await worker(items[i], i)
      }
    }),
  )
  return results
}

/* ------------------------------------------------------------ replication */

const seqPath = (seq) => {
  const s = String(seq).padStart(9, '0')
  return `${s.slice(0, 3)}/${s.slice(3, 6)}/${s.slice(6, 9)}`
}

async function currentSequence() {
  const res = await fetch(`${REPLICATION}/state.yaml`, { headers: { 'User-Agent': UA } })
  const text = await res.text()
  return +text.match(/sequence:\s*(\d+)/)[1]
}

/** Pulls the tags out of one `<changeset>` element without a full XML parser. */
function parseChangesets(xml) {
  const out = []
  for (const m of xml.matchAll(/<changeset\s([^>]*?)(\/>|>([\s\S]*?)<\/changeset>)/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]))
    const tags = Object.fromEntries(
      [...(m[3] || '').matchAll(/<tag k="([^"]*)" v="([^"]*)"\s*\/>/g)].map((t) => [t[1], t[2]]),
    )
    const bbox =
      attrs.min_lon !== undefined
        ? [+attrs.min_lon, +attrs.min_lat, +attrs.max_lon, +attrs.max_lat]
        : null
    out.push({
      id: +attrs.id,
      user: unescapeXml(attrs.user || ''),
      createdAt: attrs.created_at,
      changes: +attrs.num_changes || 0,
      bbox,
      hashtags: unescapeXml(tags.hashtags || ''),
      comment: unescapeXml(tags.comment || ''),
      host: unescapeXml(tags.host || ''),
    })
  }
  return out
}

const unescapeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

async function ingestReplication(store) {
  const head = await currentSequence()
  const minutes = +flag('minutes', 1560) // 26 h — comfortably covers a daily run
  // Resume from where the last run stopped, but never scan more than the window.
  const from = Math.max(store.lastSequence ? store.lastSequence + 1 : 0, head - minutes)
  console.log(`replication: scanning ${head - from + 1} files (${from} → ${head})`)

  const seqs = Array.from({ length: head - from + 1 }, (_, i) => from + i)
  let matched = 0
  await pool(seqs, 24, async (seq) => {
    let buf
    try {
      buf = await get(`${REPLICATION}/${seqPath(seq)}.osm.gz`, { raw: true, retries: 2 })
    } catch {
      return // a missing minute is not worth failing the run over
    }
    const xml = gunzipSync(buf).toString('utf8')
    if (!xml.toLowerCase().includes(HASHTAG)) return
    for (const cs of parseChangesets(xml)) {
      const haystack = `${cs.hashtags} ${cs.comment}`.toLowerCase()
      if (!haystack.includes(`#${HASHTAG}`)) continue
      if (record(store, cs)) matched++
    }
  })
  store.lastSequence = head
  console.log(`replication: ${matched} changeset records with #${HASHTAG}`)
}

/* ----------------------------------------------------------------- osmcha */

async function ingestOsmcha(store) {
  const token = process.env.OSMCHA_TOKEN
  if (!token) {
    console.log('osmcha: OSMCHA_TOKEN not set, skipping backfill')
    return
  }
  const since = flag('since', '2019-01-01')
  let url =
    `https://osmcha.org/api/v1/changesets/?hashtags=${encodeURIComponent(HASHTAG)}` +
    `&date__gte=${since}&page_size=100`
  let page = 0
  let matched = 0

  while (url) {
    const body = await get(url, { headers: { Authorization: `Token ${token}` } })
    for (const f of body.features || []) {
      const p = f.properties || {}
      // OSMCha has moved fields around between versions; take the union.
      const tags = p.tags || {}
      if (
        record(store, {
          id: +(f.id ?? p.id),
          user: p.user,
          createdAt: p.date || p.created_at,
          changes: p.create + p.modify + p.delete || 0,
          // Last resort: OSMCha has reshaped `hashtags` more than once, so if
          // the known shapes come up empty, scan the raw feature for the
          // project hashtag rather than dropping a real changeset.
          hashtags:
            tags.hashtags ||
            (Array.isArray(p.hashtags) ? p.hashtags.map((h) => `#${h.name || h}`).join(';') : '') ||
            JSON.stringify(f),
          comment: p.comment || tags.comment || '',
          host: tags.host || '',
          bbox: bboxOfGeometry(f.geometry),
        })
      )
        matched++
    }
    url = body.next
    if (++page % 10 === 0) console.log(`osmcha: page ${page}, ${matched} matched so far`)
  }
  console.log(`osmcha: ${matched} changesets with #${HASHTAG} across ${page} pages`)
}

/** OSMCha returns the changeset bbox as the feature geometry. */
function bboxOfGeometry(geometry) {
  if (!geometry) return null
  const lons = []
  const lats = []
  const walk = (c) => (typeof c[0] === 'number' ? (lons.push(c[0]), lats.push(c[1])) : c.forEach(walk))
  walk(geometry.coordinates)
  if (!lons.length) return null
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
}

/* ---------------------------------------------------------------- touched */

async function ingestTouched(store) {
  if (!store.mappers.length) {
    console.log('touched: no mappers in the roster yet, run `replication` or `osmcha` first')
    return
  }
  console.log(`touched: asking the Tasking Manager about ${store.mappers.length} mappers`)
  let added = 0
  await pool(store.mappers, 4, async (user) => {
    let body
    try {
      body = await get(`${TM_API}/projects/queries/${encodeURIComponent(user)}/touched/`, { retries: 1 })
    } catch {
      return // users who never logged into TM 404 here, which is fine
    }
    for (const mp of body.mappedProjects || []) {
      const p = (store.projects[mp.projectId] ??= {
        id: mp.projectId,
        source: 'tm-touched',
        changesets: [],
        mappers: [],
      })
      if (!p.mappers.includes(user)) p.mappers.push(user)
      if (mp.centroid?.coordinates) p.tmCentroid = mp.centroid.coordinates
      if (p.source === 'tm-touched') added++
    }
  })
  console.log(`touched: ${added} project/mapper links from the Tasking Manager`)
}

/* ------------------------------------------------------- project metadata */

async function enrich(store) {
  const stale = Object.values(store.projects).filter(
    (p) => !p.name || !p.bbox || p.lastEdit !== p.metadataAt,
  )
  if (!stale.length) return
  console.log(`metadata: fetching ${stale.length} projects from the Tasking Manager`)

  await pool(stale, 4, async (p) => {
    let d
    try {
      d = await get(`${TM_API}/projects/${p.id}/?abbreviated=true`, { retries: 2 })
    } catch (err) {
      console.warn(`metadata: project ${p.id} — ${err.message}`)
      return
    }
    const bbox = d.aoiBBOX
    Object.assign(p, {
      name: d.projectInfo?.name || `Project ${p.id}`,
      shortDescription: stripHtml(d.projectInfo?.shortDescription || ''),
      bbox,
      centre: bbox && [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
      created: d.created,
      status: d.status,
      countries: d.countryTag || [],
      organisation: d.organisationName || null,
      campaigns: (d.campaigns || []).map((c) => c.name),
      mappingTypes: d.mappingTypes || [],
      percentMapped: d.percentMapped,
      percentValidated: d.percentValidated,
      changesetComment: d.changesetComment,
      metadataAt: p.lastEdit,
    })
  })
}

const stripHtml = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)

/* ------------------------------------------------------------------- main */

const store = await loadStore()

if (mode === 'replication' || mode === 'all') await ingestReplication(store)
if (mode === 'osmcha' || mode === 'all') await ingestOsmcha(store)
if (mode === 'touched' || mode === 'all') await ingestTouched(store)
if (!['replication', 'osmcha', 'touched', 'all'].includes(mode)) {
  console.error(`unknown mode "${mode}" — expected replication | osmcha | touched | all`)
  process.exit(1)
}

await enrich(store)
await saveStore(store)
