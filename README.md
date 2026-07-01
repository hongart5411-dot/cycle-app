# cycleAPP 🚴

A personal, single-user **cycling computer** as a web app — pair BLE power / heart‑rate
sensors, watch live ride metrics on a handlebar phone mount, record the ride, and export
a **TCX** file for Strava. Backed by a small Express + Supabase Postgres API.

## Live

| URL | What |
| --- | --- |
| **https://hongart5411-dot.github.io/cycle-app/** | Marketing **landing** page — static, GitHub Pages |
| https://cycle-2hzispfm0-rada12s-projects.vercel.app/ | Landing on Vercel (full stack) |
| https://cycle-2hzispfm0-rada12s-projects.vercel.app/app | The **riding app** (needs the API) |

> GitHub Pages serves the **static landing only**. The riding app's cloud sync and the
> live `/api/stats` strip need the backend, which runs on Vercel (serverless). With no
> backend reachable the landing degrades gracefully to its built‑in animated demo.

## What's in here

- **`index.html`** — Marketing landing page. Self‑contained vanilla HTML/CSS/JS with a live
  animated demo of the ride screen. Optionally paints real aggregate totals from
  `/api/stats`; when there is no backend (e.g. on GitHub Pages) it silently keeps the demo.
- **`app.html`** — The actual riding web app: Web Bluetooth sensors, live ride screens, ride
  recording, TCX export, ride history and settings. Syncs to the backend, with a local mock
  fallback when offline or on an unsupported browser.
- **`server.js`** — Express + `pg` backend. Serves the pages and a JSON API
  (`/api/rides | profile | prefs | stats | health`) over a Supabase Postgres database.
- **`schema.sql`** — Database schema (also applied automatically at server boot).
- **`cycleAPP.md`** — Original build spec. The app was first specced as a Flutter iOS app;
  this repo is the web implementation of that spec.

## Project structure

```
.
├── index.html      # landing page  → deployed to GitHub Pages
├── app.html        # riding web app (Web Bluetooth, TCX export)
├── server.js       # Express + pg API + static host
├── schema.sql      # Postgres schema
├── vercel.json     # Vercel routing: /api → function, /app → app.html, / → index.html
├── .env.example    # env template (real .env is gitignored)
├── package.json
├── cycleAPP.md     # original build spec
└── .nojekyll       # serve Pages files verbatim (no Jekyll)
```

## Riding app features

- **BLE sensors (Web Bluetooth)** — cycling power + cadence (e.g. Favero Assioma; Cycling
  Power Service `0x1818` / `0x2A63`) and heart rate (Heart Rate Service `0x180D` / `0x2A37`).
  Falls back to a mock/demo stream when no hardware is present.
- **Live ride screen** — big, high‑contrast numbers for power, speed, cadence, heart rate,
  gradient, distance and elapsed time; built to be readable on a bike mount in daylight.
- **Recording → TCX** — trackpoints captured during the ride and exported as a
  Strava‑compatible **TCX** file (watts, heart rate, cadence, altitude, distance).
- **History & settings** — completed‑rides list, rider profile (weight, FTP, height, age…)
  and preferences, all synced to the backend.

## Local development

```bash
npm install
npm start          # http://localhost:3000   (npm run dev for auto-reload)
```

Requires Node.js (tested on v24.x) and a Supabase Postgres `DATABASE_URL` in `.env`
(see [`.env.example`](./.env.example)). On boot the server auto‑creates the tables
(`CREATE TABLE IF NOT EXISTS`). If the database is unreachable the HTTP server still starts
so the static pages serve, and `/api/health` reports `db:false`.

| URL | Serves |
| --- | --- |
| `http://localhost:3000/` | `index.html` (landing) |
| `http://localhost:3000/app` | `app.html` (riding app) |
| `http://localhost:3000/api/health` | API health probe |

## Deployment

### Landing → GitHub Pages
`index.html` is a static file at the repo root, published via GitHub Pages from the `main`
branch (root). A [`.nojekyll`](./.nojekyll) file disables Jekyll so files are served
verbatim. Live at **https://hongart5411-dot.github.io/cycle-app/**. Any push to `main`
redeploys the site automatically.

### Full app + API → Vercel
`server.js` runs as a serverless function (`@vercel/node`) — it exports the Express app and
only calls `app.listen()` when run directly, so importing it on Vercel does **not** start a
listener; the schema is ensured lazily on the first `/api/*` request. `index.html` and
`app.html` are served as static assets, and routing lives in [`vercel.json`](./vercel.json)
(`/api/*` → the function, `/app` → `app.html`, `/` → `index.html`).
[`.vercelignore`](./.vercelignore) keeps `.env`, `node_modules` and local tooling out of the
upload. `DATABASE_URL` is set as an **encrypted Vercel Environment Variable** (Production +
Preview) — never stored in any committed file. Vercel "Deployment Protection" is disabled so
the URL is reachable without a Vercel login (needed on a phone).

## API

All endpoints return JSON. Numeric fields are coerced to real numbers (pg returns `NUMERIC`
columns as strings). On failure a handler returns `500 { "error": "..." }`.

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/health` | `{ ok: true, db: true\|false }` — `db` reflects a live `SELECT 1`. |
| GET | `/api/rides?limit=N` | Rides, newest first (`ORDER BY date DESC`). **Omits** the heavy `tcx` field. `limit` optional. |
| GET | `/api/rides/:id` | Full ride **including** `tcx`. `404 { error }` if not found. |
| POST | `/api/rides` | Body is a ride; upsert by `id`. `400 { error }` if `id` missing. Returns the saved ride. |
| DELETE | `/api/rides/:id` | `{ ok: true }` — idempotent (ok even if the ride did not exist). |
| GET | `/api/profile` | Profile object. Returns defaults if no row yet. |
| PUT | `/api/profile` | Body is a profile; upsert singleton (`id = 1`). Returns the saved profile. |
| GET | `/api/prefs` | Prefs object. Returns defaults if no row yet. |
| PUT | `/api/prefs` | Body is prefs; upsert singleton (`id = 1`). Returns the saved prefs. |
| GET | `/api/stats` | Aggregate stats over all rides (all‑zeros/nulls when there are no rides). |

### Data shapes (camelCase JSON)

```jsonc
// ride
{
  "id": "r1719200000000", "date": "2026-06-24T09:00:00.000Z", "screen": "zone2",
  "mock": false, "secs": 3600, "distKm": 32.5, "avgSpeed": 32.5, "maxSpeed": 51.2,
  "avgPower": 210, "maxPower": 640, "np": 225, "iff": 0.81, "tss": 88, "avgHr": 142,
  "ascent": 410, "tcx": "<TrainingCenterDatabase>...</TrainingCenterDatabase>"
}

// profile  (defaults shown)
{ "weight": 83, "ftp": 277, "height": 183, "age": 49, "sex": "M", "maxHr": 0 }

// prefs    (defaults shown)
{ "selectedScreen": "zone2", "autoConnect": true, "demo": false, "autoPause": true }

// stats
{
  "totalRides": 0, "totalKm": 0, "totalSecs": 0, "totalAscent": 0,
  "avgPower": 0, "maxPower": 0, "maxSpeed": 0, "avgSpeed": 0, "lastRideDate": null
}
```

## Database

The schema is defined in [`schema.sql`](./schema.sql) and applied automatically at server
boot. Single‑user app:

- `profile` and `prefs` are **singletons** (one row each, `id = 1`).
- `rides` is a list of completed rides, each optionally carrying a (large) TCX XML blob.

The Supabase connection uses SSL and the transaction‑mode pooler (port 6543), so the server
uses only plain parameterized queries (no session state / named prepared statements). The
password lives only in `.env` and is never written to any file served to the client.

## Notes

- **`.env` is gitignored — never commit it.** Only `.env.example` (placeholders) is tracked.
- The landing stays public: with no/invalid API token the `/api/stats` call returns 401 and
  the personal‑totals strip simply stays hidden, so private data isn't exposed to visitors.
- **BLE requires a real device + a browser that supports Web Bluetooth** (Chrome/Edge over
  HTTPS). Use demo/mock mode otherwise.
