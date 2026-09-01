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
  /** Centre point of every #iugnorge changeset, used to find the busiest neighbourhood. */
  editPoints?: [number, number][]
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
  mappers: string[]
  changesets: number[]
}

export interface Dataset {
  hashtag: string
  generated: string
  lastSequence: number | null
  mappers: string[]
  projects: Project[]
}

export type Bbox = [number, number, number, number]
