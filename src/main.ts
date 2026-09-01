import './maplibre-worker'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

import { HighlightMap } from './map'
import type { Bbox, Dataset, Project, TileSummary } from './types'

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const projectSelect = el<HTMLSelectElement>('project')
const backButton = el<HTMLButtonElement>('back')
const infoEl = el<HTMLDivElement>('project-info')
const statusEl = el<HTMLDivElement>('status')

const map = new HighlightMap(el('map'), `${import.meta.env.BASE_URL}tiles/iugnorge.pmtiles`)

let dataset: Dataset
/** Per-project feature counts and extents, written by the tile build. */
let summary: TileSummary['projects'] = {}
let current: Project | undefined

/* -------------------------------------------------------------- bootstrap */

async function start() {
  const [res, tiles] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/projects.json`),
    fetch(`${import.meta.env.BASE_URL}data/tiles.json`),
  ])
  if (!res.ok) throw new Error(`Could not load the project list (HTTP ${res.status})`)
  dataset = await res.json()
  // Absent before the first tile build; the app still works, it just cannot
  // tell which projects have anything to show.
  if (tiles.ok) summary = ((await tiles.json()) as TileSummary).projects ?? {}

  el('hashtag').textContent = `#${dataset.hashtag}`
  el('dataset-note').textContent =
    `${dataset.projects.length} projects · ${dataset.mappers.length} mappers · ` +
    `updated ${new Date(dataset.generated).toLocaleDateString('en-GB', { dateStyle: 'medium' })}`

  const everywhere = document.createElement('option')
  everywhere.value = ''
  everywhere.textContent = 'Everywhere we have mapped'
  projectSelect.append(everywhere)

  for (const project of withEdits(dataset.projects)) {
    const option = document.createElement('option')
    option.value = String(project.id)
    // Date first: the list is ordered by it, so it should be the thing you scan.
    const count = summary[project.id]?.features
    option.textContent =
      `${shortDate(project.lastEdit)} · ${project.name ?? `Project ${project.id}`}` +
      (count ? ` (${count.toLocaleString()})` : '')
    projectSelect.append(option)
  }

  projectSelect.addEventListener('change', () => select(Number(projectSelect.value) || null))
  backButton.addEventListener('click', () => (current ? frame(current) : select(null)))

  map.onReady(() => {
    const fromUrl = Number(new URLSearchParams(location.search).get('project'))
    select(dataset.projects.some((p) => p.id === fromUrl) ? fromUrl : null)
  })

  map.onSquareClick((square) => {
    map.zoomTo(square.bbox, { padding: 60, maxZoom: 18 })
    setStatus(
      `Task ${square.task ?? '—'} · ${square.edits.toLocaleString()} features mapped here`,
      'good',
    )
    backButton.hidden = false
  })

  window.addEventListener('resize', () => map.resize())
}

/**
 * Projects with something on the map, most recently mapped first — the last
 * mapathon is the one people want to look at.
 *
 * A handful of projects are a single stray changeset that left nothing behind,
 * or whose work was place names rather than buildings; listing them only offers
 * an empty map. Before the first tile build nothing is known, so list them all.
 */
const withEdits = (projects: Project[]) =>
  projects
    .filter((p) => p.changesets.length)
    .filter((p) => !Object.keys(summary).length || (summary[p.id]?.features ?? 0) > 0)
    .sort((a, b) => (b.lastEdit ?? '').localeCompare(a.lastEdit ?? ''))

/* ---------------------------------------------------------------- project */

function select(id: number | null) {
  current = id === null ? undefined : dataset.projects.find((p) => p.id === id)
  projectSelect.value = current ? String(current.id) : ''
  backButton.hidden = true

  const url = new URL(location.href)
  if (current) url.searchParams.set('project', String(current.id))
  else url.searchParams.delete('project')
  history.replaceState(null, '', url)

  map.filterToProject(current?.id ?? null)
  renderInfo(current)

  if (current) frame(current)
  else {
    map.zoomTo([-160, -50, 175, 65], { padding: 20, maxZoom: 3 })
    setStatus('Pick a project, or click any square to zoom in', 'hint')
  }
}

/** Frames the whole of what the group mapped, not a guess at where it is. */
function frame(project: Project) {
  const extent = summary[project.id]?.bbox ?? project.editBbox ?? project.bbox
  if (extent) map.zoomTo(extent, { padding: 48, maxZoom: 16 })
  backButton.hidden = true
  setStatus('Click a square to zoom into it', 'hint')
}

function renderInfo(project: Project | undefined) {
  if (!project) {
    const totals = withEdits(dataset.projects)
    const changesets = totals.reduce((sum, p) => sum + p.changesets.length, 0)
    const countries = new Set(totals.flatMap((p) => p.countries ?? []))
    infoEl.innerHTML = `
      <div><strong>Everywhere we have mapped</strong>
        <span class="muted">${totals.length} projects · ${countries.size} countries</span></div>
      <div class="muted">${changesets.toLocaleString()} changesets tagged #${escapeHtml(dataset.hashtag)}</div>`
    return
  }

  const bits: string[] = []
  if (project.countries?.length) bits.push(project.countries.join(', '))
  if (project.organisation) bits.push(project.organisation)
  if (project.firstEdit) bits.push(mappedWhen(project))

  infoEl.innerHTML = `
    <div>
      <strong>${escapeHtml(project.name ?? `Project ${project.id}`)}</strong>
      <span class="muted">${bits.map(escapeHtml).join(' · ')}</span>
    </div>
    <div class="muted">
      ${project.changesets.length} changesets by ${project.mappers.length} mappers ·
      <a href="https://tasks.hotosm.org/projects/${project.id}" target="_blank" rel="noreferrer">
        open in Tasking Manager
      </a>
    </div>`
}

/* ------------------------------------------------------------------- misc */

const monthYear = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

/** A single mapathon reads as one date; a longer campaign as a span of months. */
function mappedWhen({ firstEdit, lastEdit }: Project) {
  if (!firstEdit) return ''
  if (!lastEdit || firstEdit.slice(0, 10) === lastEdit.slice(0, 10)) return `mapped ${shortDate(firstEdit)}`
  const from = monthYear(firstEdit)
  const to = monthYear(lastEdit)
  return from === to ? `mapped ${from}` : `mapped ${from} – ${to}`
}

const shortDate = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : 'undated'

function setStatus(message: string, kind: 'error' | 'good' | 'hint') {
  statusEl.textContent = message
  statusEl.className = `status status-${kind}`
  statusEl.hidden = false
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export type { Bbox }

start().catch((err: Error) => setStatus(err.message, 'error'))
