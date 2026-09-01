import './maplibre-worker'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

import { Compare } from './compare'
import { contains, fetchSnapshot, padBbox } from './overpass'
import { busiestArea } from './hotspots'
import type { Bbox, Dataset, Project } from './types'

/** Below this zoom a viewport query would ask Overpass for a whole city. */
const MIN_ZOOM = 14
const DEBOUNCE_MS = 700

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const projectSelect = el<HTMLSelectElement>('project')
const beforeInput = el<HTMLInputElement>('before-date')
const anotherArea = el<HTMLButtonElement>('another-area')
const statusEl = el<HTMLDivElement>('status')
const infoEl = el<HTMLDivElement>('project-info')

const compare = new Compare(el('pane-before'), el('pane-after'))

let dataset: Dataset
let current: Project | undefined
/** Index into the project's hotspot list, so "Another area" can cycle. */
let hotspotIndex = 0
let inFlight: AbortController | undefined
let debounce: number | undefined
/** What the panes are currently showing, so we do not re-ask Overpass for it. */
let showing: { bbox: Bbox; date: string } | undefined

/* -------------------------------------------------------------- bootstrap */

async function start() {
  const res = await fetch(`${import.meta.env.BASE_URL}data/projects.json`)
  if (!res.ok) throw new Error(`Could not load the project list (HTTP ${res.status})`)
  dataset = await res.json()

  el('hashtag').textContent = `#${dataset.hashtag}`
  el('dataset-note').textContent =
    `${dataset.projects.length} projects · ${dataset.mappers.length} mappers · ` +
    `updated ${new Date(dataset.generated).toLocaleDateString('en-GB', { dateStyle: 'medium' })}`

  for (const p of dataset.projects) {
    const option = document.createElement('option')
    option.value = String(p.id)
    option.textContent = `${p.name ?? `Project ${p.id}`} (#${p.id})`
    projectSelect.append(option)
  }

  projectSelect.addEventListener('change', () => selectProject(Number(projectSelect.value)))
  beforeInput.addEventListener('change', () => void refresh())
  anotherArea.addEventListener('click', () => {
    hotspotIndex++
    frameProject()
  })

  compare.onReady(() => {
    const fromUrl = Number(new URLSearchParams(location.search).get('project'))
    const initial = dataset.projects.find((p) => p.id === fromUrl) ?? dataset.projects[0]
    projectSelect.value = String(initial.id)
    selectProject(initial.id)
    compare.onViewChange(scheduleRefresh)
  })

  window.addEventListener('resize', () => compare.resize())
}

/* ---------------------------------------------------------------- project */

function selectProject(id: number) {
  current = dataset.projects.find((p) => p.id === id)
  if (!current) return
  hotspotIndex = 0
  showing = undefined

  beforeInput.value = defaultBeforeDate(current)
  beforeInput.min = '2007-10-08' // as far back as the Overpass history goes
  beforeInput.max = new Date().toISOString().slice(0, 10)

  const url = new URL(location.href)
  url.searchParams.set('project', String(id))
  history.replaceState(null, '', url)

  renderInfo(current)
  frameProject()
}

/**
 * The day before the Tasking Manager project opened. Anything the group mapped
 * happened after that, so this is the honest "before" state.
 */
function defaultBeforeDate(project: Project): string {
  const anchor = project.created ?? project.firstEdit
  const date = anchor ? new Date(anchor) : new Date()
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function frameProject() {
  if (!current) return
  const spot = busiestArea(current, hotspotIndex)
  anotherArea.disabled = !current.editPoints || current.editPoints.length < 2

  if (spot) {
    compare.flyTo(spot, 16)
  } else if (current.editBbox) {
    compare.fitBounds(current.editBbox)
  } else if (current.tmCentroid ?? current.centre) {
    compare.flyTo((current.tmCentroid ?? current.centre)!, 16)
  } else if (current.bbox) {
    compare.fitBounds(current.bbox)
  }
  // The camera jump above emits its own `moveend`; going through the debounce
  // means the two paths collapse into one query instead of racing.
  scheduleRefresh()
}

function renderInfo(project: Project) {
  const bits: string[] = []
  if (project.countries?.length) bits.push(project.countries.join(', '))
  if (project.organisation) bits.push(project.organisation)
  if (project.percentMapped != null) bits.push(`${project.percentMapped}% mapped`)

  const provenance =
    project.source === 'changesets'
      ? `${project.changesets.length} #${dataset.hashtag} changesets by ${project.mappers.length} mappers`
      : `worked on by ${project.mappers.length} of our mappers (from the Tasking Manager)`

  infoEl.innerHTML = `
    <div>
      <strong>${escapeHtml(project.name ?? `Project ${project.id}`)}</strong>
      <span class="muted">${bits.map(escapeHtml).join(' · ')}</span>
    </div>
    <div class="muted">
      ${escapeHtml(provenance)} ·
      <a href="https://tasks.hotosm.org/projects/${project.id}" target="_blank" rel="noreferrer">
        open in Tasking Manager
      </a>
    </div>`
}

/* ------------------------------------------------------------- comparison */

function scheduleRefresh() {
  window.clearTimeout(debounce)
  debounce = window.setTimeout(() => void refresh(), DEBOUNCE_MS)
}

async function refresh() {
  if (!current) return

  if (compare.zoom < MIN_ZOOM) {
    setStatus(`Zoom in to load the comparison (zoom ${MIN_ZOOM}+)`, 'hint')
    compare.before.setSnapshot(null)
    compare.after.setSnapshot(null)
    showing = undefined
    return
  }

  const before = new Date(`${beforeInput.value}T00:00:00Z`)
  if (Number.isNaN(before.getTime())) return

  compare.before.setDate(before.toLocaleDateString('en-GB', { dateStyle: 'medium' }))
  compare.after.setDate('today')

  // Panning inside data we already have is free; only leaving it costs a query.
  const viewport = compare.bbox
  if (showing && showing.date === beforeInput.value && contains(showing.bbox, viewport)) return

  inFlight?.abort()
  const controller = new AbortController()
  inFlight = controller
  const bbox = padBbox(viewport)
  setStatus('Loading OpenStreetMap history…', 'busy')

  try {
    // Sequential on purpose: Overpass allows very few concurrent slots per client.
    const past = await fetchSnapshot(bbox, before, controller.signal)
    const now = await fetchSnapshot(bbox, null, controller.signal)
    if (controller.signal.aborted) return
    compare.before.setSnapshot(past)
    compare.after.setSnapshot(now)
    showing = { bbox, date: beforeInput.value }

    const added = now.stats.buildings - past.stats.buildings
    setStatus(
      added > 0
        ? `+${added.toLocaleString()} buildings in this view since ${beforeInput.value}`
        : 'No change in building count in this view',
      added > 0 ? 'good' : 'hint',
    )
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    setStatus((err as Error).message, 'error')
  }
}

/* ------------------------------------------------------------------- misc */

function setStatus(message: string, kind: 'busy' | 'error' | 'good' | 'hint') {
  statusEl.textContent = message
  statusEl.className = `status status-${kind}`
  statusEl.hidden = false
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

start().catch((err: Error) => setStatus(err.message, 'error'))
