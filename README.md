# EssentiaLyfe — Sourcing Autopilot

Real-estate sourcing pipeline for EssentiaLyfe. Pulls live Los Angeles listings,
processes the photos, lets you review and approve them, and delivers approved
properties (with cleaned, tagged photos) into Google Drive foldered by address.

## What it does

- **Sourcing** — collects real LA listings across three specs: for-sale (3bd+, $3.9M+),
  recently sold (3bd+, $3.9M+), and rentals (3bd+, $15k+).
- **Image pipeline** — for each property: downloads the real listing photos, removes
  watermarks/logos, blurs the address, tags each photo by room/amenity, resizes, and
  filters out bad or duplicate shots.
- **Review queue** — swipe to approve or pass; duplicate listings are turned away.
- **Google Drive delivery** — approved properties are saved to Drive, foldered by
  address, with the processed photos inside.
- **Dashboard** — live counts (in database vs. live) and the added-date on each listing.

## Tech

- **Node.js + Express** — backend + API
- **node:sqlite** (built into Node 22+) — local database, via a DB-abstraction layer
  so it swaps to PostgreSQL in production
- **Sharp** — image processing
- **googleapis** — Google Drive delivery (OAuth)
- Vanilla SPA frontend (`public/`)

## Running locally

```bash
npm install
npm start        # http://localhost:3000
```

On first boot with an empty database it pulls a real batch so the app is never blank.

## Configuration (environment variables)

Set these in your host (e.g. Railway → Variables). None are committed to the repo.

| Variable | Purpose |
|---|---|
| `RAPIDAPI_KEY` | Real-estate data + photo feed |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Drive delivery (OAuth) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Drive delivery (OAuth) |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Google Drive delivery (OAuth) |
| `DRIVE_MASTER_FOLDER_ID` | Drive folder approved properties land in |
| `PORT` | Server port (set automatically by most hosts) |

## Structure

```
src/
  server.js     Express app + API routes
  pipeline.js   collector + approval processing
  realtor.js    listing + photo source
  redfin.js     fallback source
  photos.js     gallery resolution
  images.js     Sharp image pipeline
  enrich.js     fills missing fields
  drive.js      Google Drive delivery
  db.js         database layer (sqlite → Postgres)
public/         dashboard / review-queue SPA
```
