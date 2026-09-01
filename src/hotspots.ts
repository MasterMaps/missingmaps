import type { Project } from './types'

/** Roughly 1 km at the equator — about one screenful at zoom 16. */
const CELL = 0.01

/**
 * Finds the neighbourhoods the group worked hardest on by grid-binning the
 * changeset centres, then returns the `rank`-th busiest (wrapping around, so
 * the "Another area" button can cycle through them forever).
 */
export function busiestArea(project: Project, rank = 0): [number, number] | null {
  const points = project.editPoints
  if (!points?.length) return null

  const bins = new Map<string, { lon: number; lat: number; n: number }>()
  for (const [lon, lat] of points) {
    const key = `${Math.floor(lon / CELL)}/${Math.floor(lat / CELL)}`
    const bin = bins.get(key) ?? { lon: 0, lat: 0, n: 0 }
    bin.lon += lon
    bin.lat += lat
    bin.n++
    bins.set(key, bin)
  }

  const ranked = [...bins.values()].sort((a, b) => b.n - a.n)
  const pick = ranked[rank % ranked.length]
  return [pick.lon / pick.n, pick.lat / pick.n]
}
