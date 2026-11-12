/** One HOT Tasking Manager project the #iugnorge group has contributed to. */
export interface Project {
  id: number
  /** `changesets` when we saw real #iugnorge changesets, `tm-touched` when only the Tasking Manager knows. */
  source: 'changesets' | 'tm-touched'
  name?: string
  shortDescription?: string
  /** Project area of interest, [minLon, minLat, maxLon, maxLat]. */
  bbox?: [number, number, number, number]
  centre?: [number, number]
  /** Union of the #iugnorge changeset bounding boxes — where the group actually worked. */
  editBbox?: [number, number, number, number]
  tmCentroid?: [number, number]
  /** When the project was published in the Tasking Manager. */
  created?: string
  firstEdit?: string
  lastEdit?: string
  status?: string
  countries?: string[]
  organisation?: string | null
  campaigns?: string[]
  mappingTypes?: string[]
  percentMapped?: number
  percentValidated?: number
  changesetComment?: string
  mapperCount: number
  changesetCount: number
}

export interface Dataset {
  hashtag: string
  generated: string
  mapperCount: number
  projects: Project[]
}

export type Bbox = [number, number, number, number]

/** Written by the tile build: what ended up in the archive, per project. */
export interface TileSummary {
  generated: string
  projects: Record<number, { features: number; squares: number; bbox: Bbox | null }>
}
