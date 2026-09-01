#!/usr/bin/env node
/**
 * Builds public/data/projects.json — the list of HOT Tasking Manager projects
 * that changesets tagged #iugnorge have contributed to.
 *
 * Four ways in, all merged into the same file:
 *
 *   replication  (no auth)  Walks the OSM minutely changeset replication feed
 *                           backwards from the current sequence and picks out
 *                           changesets carrying the hashtag. Cheap for a rolling
 *                           window (~11 MB / 6 s per 24 h), hopeless for years.
 *   planet       (no auth)  Streams the full changeset dump (~8.7 GB bzip2) and
 *                           matches the hashtag on the way past. Slow but total:
 *                           the only source that sees every changeset ever made.
 *   osmcha       (token)    Asks OSMCha for each known mapper's changesets. Good
 *                           top-up; cannot find mappers not already in the roster,
 *                           because OSMCha has no usable hashtag filter.
 *   touched      (no auth)  For every mapper already in the roster, asks the
 *                           Tasking Manager which projects they have worked on.
 *                           Catches projects whose changesets we never scanned,
 *                           but only sees tasks the mapper marked done.
 *
 * Usage:
 *   node scripts/ingest.mjs replication [--minutes 1560]
 *   node scripts/ingest.mjs planet [--dump URL]           (needs bzip2 on PATH)
 *   node scripts/ingest.mjs osmcha [--since 2019-01-01] [--users "A,B"]
 *   node scripts/ingest.mjs touched
 *   node scripts/ingest.mjs all       (everything except planet)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, { headers = {}, raw = false, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
      // A throttled request is not a failed one — back off in seconds, not
      // milliseconds, and do not count it against the error retries.
      if (res.status === 429 || res.status === 503) {
        if (attempt >= retries + 3) throw new Error(`still throttled after ${attempt} tries: ${url}`)
        const wait = Number(res.headers.get('retry-after')) * 1000 || 30_000 * (attempt + 1)
        console.log(`  throttled, waiting ${Math.round(wait / 1000)}s`)
        await sleep(wait)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return raw ? Buffer.from(await res.arrayBuffer()) : await res.json()
    } catch (err) {
      if (attempt >= retries) throw err
      await sleep(500 * 2 ** attempt)
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

/* ----------------------------------------------------------------- planet */

/**
 * Streams the full changeset dump and matches the hashtag on the way past.
 * It is ~8.7 GB of bzip2, but it is the only source that sees every changeset
 * ever made, so it is what finds the mappers and projects nobody in the current
 * roster can lead us to. Run it once; `replication` keeps things current after.
 *
 * The dump lags a few days, so follow it with a `replication` run.
 */
async function ingestPlanet(store) {
  const url = flag('dump', 'https://planet.openstreetmap.org/planet/changesets-latest.osm.bz2')
  console.log(`planet: streaming ${url}`)

  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`planet: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0

  // Node has no bzip2, and shelling out lets the download and the decompression
  // overlap instead of needing the whole dump on disk first.
  const bunzip = spawn('bzip2', ['-dc'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const decoder = new StringDecoder('utf8')
  let compressed = 0
  let matched = 0
  let seen = 0
  let nextReport = 500 << 20

  Readable.fromWeb(res.body)
    .on('data', (chunk) => {
      compressed += chunk.length
      if (compressed > nextReport) {
        nextReport += 500 << 20
        const pct = total ? ` (${Math.round((compressed / total) * 100)}%)` : ''
        console.log(`planet: ${(compressed / (1 << 30)).toFixed(1)} GB read${pct}, ${matched} matched`)
      }
    })
    .pipe(bunzip.stdin)

  let buf = ''
  for await (const chunk of bunzip.stdout) {
    buf += decoder.write(chunk)
    // Cut the buffer at the last complete element so no changeset is split.
    const cut = buf.lastIndexOf('</changeset>')
    if (cut === -1) {
      if (buf.length > 8 << 20) buf = buf.slice(-(2 << 20))
      continue
    }
    const ready = buf.slice(0, cut + 12)
    buf = buf.slice(cut + 12)

    // Cheap reject: the vast majority of chunks never mention the hashtag.
    if (!ready.toLowerCase().includes(HASHTAG)) continue
    for (const cs of parseChangesets(ready)) {
      seen++
      if (!`${cs.hashtags} ${cs.comment}`.toLowerCase().includes(`#${HASHTAG}`)) continue
      if (record(store, cs)) matched++
    }
  }

  await new Promise((resolve, reject) => {
    bunzip.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`bzip2 exited ${code}`))))
    bunzip.on('error', reject)
  })
  console.log(`planet: ${matched} changeset records with #${HASHTAG} (${seen} candidates examined)`)
}

/* ----------------------------------------------------------------- osmcha */

/**
 * OSMCha has no hashtag filter, and the two lookups that could stand in for one
 * — `metadata=hashtags=x` (icontains into a JSON column) and `comment=x` — both
 * time out against the production database, even narrowed to a single month.
 * `users` is indexed and answers in seconds, so the backfill walks the roster
 * one mapper at a time and matches the hashtag here instead.
 *
 * The trade-off: this only sees mappers we already know about. The roster grows
 * by itself from the replication scan; pass `--users a,b,c` to add people who
 * have not mapped since the scanning started.
 */
async function ingestOsmcha(store) {
  const token = process.env.OSMCHA_TOKEN
  if (!token) {
    console.log('osmcha: OSMCHA_TOKEN not set, skipping backfill')
    return
  }

  for (const extra of (flag('users', '') || '').split(',').map((u) => u.trim()).filter(Boolean)) {
    if (!store.mappers.includes(extra)) store.mappers.push(extra)
  }
  if (!store.mappers.length) {
    console.log('osmcha: no mappers known yet — run `replication` first, or pass --users a,b,c')
    return
  }

  const since = flag('since', '2019-01-01')
  const headers = { Authorization: `Token ${token}` }
  let matched = 0
  let scanned = 0

  await pool(store.mappers, 2, async (user) => {
    let url =
      `https://osmcha.org/api/v1/changesets/?users=${encodeURIComponent(user)}` +
      `&date__gte=${since}&page_size=100`
    let mine = 0

    try {
      while (url) {
        const body = await get(url, { headers })
        for (const f of body.features || []) {
          const p = f.properties || {}
          // Careful: OSMCha's `tags` are its own review labels. The OSM tags of
          // the changeset live in `metadata`.
          const meta = p.metadata || {}
          scanned++
          const hashtags = meta.hashtags || ''
          const comment = p.comment || meta.comment || ''
          if (!`${hashtags} ${comment}`.toLowerCase().includes(`#${HASHTAG}`)) continue
          if (
            record(store, {
              id: +(f.id ?? p.id),
              user: p.user || user,
              createdAt: p.date,
              changes: (p.create || 0) + (p.modify || 0) + (p.delete || 0),
              hashtags,
              comment,
              host: meta.host || '',
              bbox: bboxOfGeometry(f.geometry),
            })
          ) {
            matched++
            mine++
          }
        }
        url = body.next
      }
      console.log(`osmcha: ${user} — ${mine} #${HASHTAG} changesets`)
    } catch (err) {
      // One mapper failing should not throw away everyone else's results.
      console.warn(`osmcha: ${user} — gave up after ${mine} changesets (${err.message})`)
    }
  })

  console.log(`osmcha: ${matched} changeset records with #${HASHTAG}, from ${scanned} scanned`)
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

// `planet` is deliberately not part of `all` — it is a one-off, not a routine.
if (mode === 'planet') await ingestPlanet(store)
if (mode === 'replication' || mode === 'all') await ingestReplication(store)
if (mode === 'osmcha' || mode === 'all') await ingestOsmcha(store)
if (mode === 'touched' || mode === 'all') await ingestTouched(store)
if (!['planet', 'replication', 'osmcha', 'touched', 'all'].includes(mode)) {
  console.error(`unknown mode "${mode}" — expected planet | replication | osmcha | touched | all`)
  process.exit(1)
}

await enrich(store)
await saveStore(store)
