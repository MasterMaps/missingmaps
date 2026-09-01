# #iugnorge before & after

A static web app that shows what **#iugnorge** has added to OpenStreetMap: pick one of the
HOT Tasking Manager projects the group has mapped, and see the same area side by side as it
stood before the project started and as it stands today.

Live at **https://mastermaps.github.io/missingmaps/**

## How the pieces fit together

### Finding the projects

Every OSM changeset carries its hashtags as a tag. A changeset from a mapathon looks like this:

```
comment  = "#hotosm-project-63366 #FloresEQ mapped buildings within earthquake-affected areas"
hashtags = "#hotosm-project-63366;#FloresEQ;#iugnorge"
host     = "https://tasks.hotosm.org/projects/63366/map/"
```

The Tasking Manager pre-fills the comment with `#hotosm-project-<id>`; the mapper adds
`#iugnorge` on top. Because both hashtags land in the same changeset, the project ID falls
straight out of it — from `hashtags`, or from the `host` URL as a second opinion.

> **This only works if mappers keep the pre-filled comment and add to it.** Replacing the whole
> comment with just `#iugnorge` loses the project link. Edits made outside the Tasking Manager
> have no project to point at and are skipped.

Note where the group's hashtag actually lands. In a sample of 79 `#iugnorge` changesets, **all 79
carried it in the `hashtags` tag and only 4 in `comment`** — everyone uses iD's separate _Hashtags_
field, which writes `hashtags` and leaves the comment alone. Anything that searches changeset
comments (OSMCha's `comment` filter included) therefore misses almost all of them, so the ingest
reads the `hashtags` tag first. Both are matched case-insensitively: `#IUGNorge` counts too.

[`scripts/ingest.mjs`](scripts/ingest.mjs) builds [`public/data/projects.json`](public/data/projects.json)
from three sources:

| Mode          | Auth           | What it is good for                                                                                                                                                                                                                    |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replication` | none           | Walks the [OSM minutely changeset replication feed](https://planet.openstreetmap.org/replication/changesets/) backwards from the current sequence. ~11 MB and under a minute per 24 h of history. This is what keeps the list current. |
| `planet`      | none           | Streams the full [changeset dump](https://planet.openstreetmap.org/planet/) (~8.7 GB bzip2, ~15 min) and matches the hashtag on the way past. The only source that sees every changeset ever made — run it once to seed the history.   |
| `osmcha`      | `OSMCHA_TOKEN` | Asks the [OSMCha API](https://osmcha.org) for each known mapper's changesets. Quick top-up between planet runs, but blind to mappers who are not already in the roster.                                                                |
| `touched`     | none           | Asks the Tasking Manager which projects each known mapper has worked on. Fills in projects whose changesets we never scanned, but only sees tasks the mapper marked done.                                                              |

Nothing else can do this from the browser: OSMCha needs a token, and the Tasking Manager API
only sends CORS headers to `tasks.hotosm.org`. So the project list is built in CI and committed
as a static JSON file, and the app itself stays a pure frontend.

### Drawing before and after

No tile server publishes historical raster tiles, so the "before" side cannot be a normal
basemap. Instead both panes render from GeoJSON that the app fetches live from the
[Overpass API](https://overpass-api.de), using an _attic_ query for the past:

```
[out:json][date:"2026-08-30T00:00:00Z"];
way["building"](bbox); ...
out geom;
```

Both panes share one hand-written MapLibre style, so any visible difference is a real
difference in the data. `overpass-api.de` is the only public instance that answers historical
queries _and_ sends CORS headers, so it is the single upstream — the app queries one map
viewport at a time, caches every answer, pads the box so small pans stay free, and backs off
when the server says it is busy.

The "before" date defaults to the day before the Tasking Manager project opened, and can be
changed to any date back to 2007.

> **Rate limits are per IP.** Overpass allows two concurrent queries per client and blocks
> clients that hammer it. That is ample for one person exploring, but a room full of people on
> the same venue wifi shares one budget — for a mapathon, drive the comparison from one screen
> rather than asking everyone to open it at once.

## Running it

```sh
npm install
npm run dev            # http://localhost:5173/missingmaps/
npm run build

npm run ingest                        # scan the last ~26 h of changesets
node scripts/ingest.mjs planet        # full history from the changeset dump
node scripts/ingest.mjs touched       # add projects via the Tasking Manager
node scripts/ingest.mjs osmcha --users "Name One,Name Two"   # needs OSMCHA_TOKEN
```

Set `HASHTAG` to track a different group, e.g. `HASHTAG=missingmaps npm run ingest`.

### Backfilling the full history

Run `node scripts/ingest.mjs planet` once, then a normal `replication` run to cover the few days
the dump lags behind. It needs `bzip2` on the PATH and streams straight from the network, so
nothing large is written to disk. The same thing is available as the **Update project list**
workflow with mode `planet`.

### Why the OSMCha path looks the way it does

OSMCha has **no hashtag filter**. Two lookups could stand in for one, and neither is usable:
`metadata=hashtags=iugnorge` (an `icontains` into the raw OSM tags, which is exactly the right
field) and `comment=iugnorge` both time out against the production database — even narrowed to a
single month. `users` is indexed and answers in seconds, so `osmcha` mode walks the roster one
mapper at a time and matches the hashtag client-side.

That makes it a good top-up and a poor backfill: it can only find changesets by mappers we
already know about. Use `planet` to discover the rest, or pass `--users "A,B"` to add people by
hand. Requests need the header `Authorization: Token <your-token>` — the literal word `Token` is
required — and OSMCha throttles hard, so the script backs off and keeps going.

To set the token up:

1. Sign in at [osmcha.org](https://osmcha.org) with your OSM account, then open
   [osmcha.org/user](https://osmcha.org/user) and copy the value shown under **API key**.
   Logging in creates the token automatically; there is nothing to generate.
2. Add it to the repository as a secret named `OSMCHA_TOKEN`:
   `gh secret set OSMCHA_TOKEN` (or _Settings → Secrets and variables → Actions_).

### Automation

- **Update project list** — every six hours, scans new changesets and commits the JSON if it changed.
- **Deploy to GitHub Pages** — builds and publishes on every push to `main`, including the data commits.

Enable Pages once under _Settings → Pages → Source: GitHub Actions_.

## Attribution

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
History via the Overpass API, project metadata via the HOT Tasking Manager.
