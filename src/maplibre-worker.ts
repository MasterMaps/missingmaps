import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

/**
 * MapLibre ships its worker as a sibling file and resolves it against
 * `import.meta.url`, which does not survive bundling — the built app 404s on
 * the worker and no GeoJSON source ever finishes loading. Letting Vite bundle
 * the worker and handing MapLibre the resulting URL fixes it in both dev and
 * production.
 */
setWorkerUrl(workerUrl)
