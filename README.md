# What #iugnorge mapped

A static web app that shows what **#iugnorge** has put on OpenStreetMap: pick one of the HOT
Tasking Manager projects the group has mapped and every building, road and waterway they added
lights up on the map, inside the task squares they worked in. Click a square to zoom into it.

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

### Drawing the highlights

The map is an ordinary [OpenFreeMap](https://openfreemap.org/) basemap — keyless and
CORS-enabled, both required for a page on GitHub Pages — with one PMTiles archive drawn on top.

That archive holds **only the group's own work**: ways whose current version belongs to one of
our `#iugnorge` changesets, plus the Tasking Manager task squares that contain at least one of
them. Everything else is basemap. Holding only our features instead of full before/after
snapshots is the difference between a few MB and a few hundred, which is what makes covering
every project affordable.

It also means the app makes **no live data queries at all**. An earlier version rendered a
before/after pair straight from Overpass attic queries; it worked, but Overpass allows two
concurrent queries per client and firewalls clients that lean on it — not a 429, the connection
simply stops opening. A room of mapathon participants on one venue wifi shares that budget. Tiles
sidestep the problem entirely: the extraction happens once, in CI, on a clean address.

[`scripts/build-tiles.mjs`](scripts/build-tiles.mjs) builds the archive. Two details are worth
knowing:

- **Query areas follow the changesets, not the project boundary.** Tasking Manager areas of
  interest can span a national border region; one of ours needs 1248 quarter-degree tiles to
  cover, to find edits sitting in two of them. Binning the recorded changeset locations into
  0.05° cells and querying each populated cell with a 3 km margin takes a full run from 1784
  queries to 518. The trade-off is that a changeset whose edits sprawl more than 3 km from its
  centre could lose features at the fringe — task squares are about 1 km, so this should be
  comfortably safe.
- **Attribution is by the changeset that last touched a way.** Exact for anything nobody has
  edited since, an undercount otherwise: a building we drew and a validator later squared off
  now belongs to their changeset. It undercounts; it never claims someone else's work.

Tiles are rebuilt by the **Build map tiles** workflow, which is manual — run it after a mapathon,
optionally with `only` set to just the project ids that changed.

## Running it

```sh
npm install
npm run dev            # http://localhost:5173/missingmaps/
npm run build

node scripts/build-tiles.mjs --only 63366   # rebuild tiles for one project

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
- **Build map tiles** — manual. Needs `tippecanoe`, which it builds from source; takes roughly an
  hour for all projects, most of it waiting on Overpass query slots.
- **Deploy to GitHub Pages** — builds and publishes on every push to `main`, including the commits
  the other two make.

Enable Pages once under _Settings → Pages → Source: GitHub Actions_.

## Attribution

Map data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright).
Basemap by [OpenFreeMap](https://openfreemap.org/), extraction via the
[Overpass API](https://overpass-api.de), project metadata via the HOT Tasking Manager.
