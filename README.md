# cycleAPP — Backend

Backend API for **cycleAPP**, a personal single-user cycling-computer web app.
One Node.js + Express server hosts both the web pages and a JSON API backed by a
Supabase Postgres database.

## Stack

- Node.js + Express
- node-postgres (`pg`) → Supabase Postgres (transaction-mode pooler, port 6543)
- dotenv for configuration

## Prerequisites

- Node.js (tested on v24.x) and npm
- A Supabase Postgres database. The connection string lives in `.env` as
  `DATABASE_URL` (see `.env.example`). **`.env` is gitignored — never commit it.**

## Setup & run

```bash
npm install
npm start
```

For development with auto-reload on file changes:

```bash
npm run dev
```

The server starts on port `3000` (override with `PORT` in `.env`). On boot it
auto-creates the database tables (`CREATE TABLE IF NOT EXISTS`). If the database
is unreachable, the HTTP server still starts so the static pages serve, and
`/api/health` reports `db:false`.

## Deployment (Vercel)

The app is deployed to Vercel and reachable over HTTPS (works on mobile / iPhone).

**Live production URL:** https://cycle-2hzispfm0-rada12s-projects.vercel.app

| URL                                                            | Serves                           |
| ------------------------------------------------------------- | -------------------------------- |
| https://cycle-2hzispfm0-rada12s-projects.vercel.app/          | `index.html` (marketing landing) |
| https://cycle-2hzispfm0-rada12s-projects.vercel.app/app       | `app.html` (the riding app)      |
| https://cycle-2hzispfm0-rada12s-projects.vercel.app/api/health | API health probe (`db:true`)     |

How it works on Vercel:

- `server.js` runs as a serverless function (`@vercel/node`). It already exports
  the Express app (`module.exports = app`) and only calls `app.listen()` when run
  directly (`require.main === module`), so importing it on Vercel does **not**
  start a listener. The schema is ensured lazily on the first `/api/*` request
  (there is no boot step on serverless).
- `index.html` and `app.html` are served as static assets (`@vercel/static`).
- Routing lives in [`vercel.json`](./vercel.json): `/api/*` → the function,
  `/app` → `app.html`, `/` → `index.html`.
- [`.vercelignore`](./.vercelignore) keeps `.env` (DB password), `node_modules`,
  and local tooling dirs out of the upload.

Configuration / deploy steps (from this folder; not a git repo, so deploy directly):

```bash
# 1. Link the folder to a project (folder name has a space/uppercase, so name it explicitly)
npx vercel link --yes --project cycle-app

# 2. Set DATABASE_URL for production AND preview (value piped via stdin, never echoed/committed)
printf '%s' "<supabase-pooler-url>" | npx vercel env add DATABASE_URL production
printf '%s' "<supabase-pooler-url>" | npx vercel env add DATABASE_URL preview

# 3. Deploy to production
npx vercel --prod --yes
```

`DATABASE_URL` is configured as a Vercel **Environment Variable** (encrypted) for
both Production and Preview — it is never stored in `vercel.json` or any committed
file. The value is the Supabase transaction-mode pooler URL (port 6543); SSL is
handled in `server.js`.

> **Public access note:** Vercel "Deployment Protection" (Vercel Authentication /
> SSO) is **disabled** for this project so the `*.vercel.app` URL is reachable
> without a Vercel login (required for use on a phone). If it ever gets re-enabled,
> every URL 302-redirects to `vercel.com/sso-api`; turn it off under
> *Project → Settings → Deployment Protection → Vercel Authentication*.

## URLs

| URL                              | Serves                          |
| -------------------------------- | ------------------------------- |
| http://localhost:3000/           | `index.html` (marketing landing) |
| http://localhost:3000/app        | `app.html` (the riding app)     |
| http://localhost:3000/app.html   | `app.html` (the riding app)     |
| http://localhost:3000/api/health | API health probe                |

Any other file in the project directory is served statically.

## Database

The schema is defined in [`schema.sql`](./schema.sql) and is also applied
automatically at server boot. Single-user app:

- `profile` and `prefs` are **singletons** (one row each, `id = 1`).
- `rides` is a list of completed rides, each optionally carrying a (large) TCX XML blob.

`.env` holds the Supabase `DATABASE_URL`. The password is never written to any
file served to the client.

## API

All endpoints return JSON. Numeric fields are coerced to real numbers (pg returns
`NUMERIC` columns as strings). On failure a handler returns `500 { "error": "..." }`.

| Method | Path               | Description                                                                                  |
| ------ | ------------------ | -------------------------------------------------------------------------------------------- |
| GET    | `/api/health`      | `{ ok: true, db: true|false }` — `db` reflects a live `SELECT 1`.                             |
| GET    | `/api/rides?limit=N` | Array of rides, newest first (`ORDER BY date DESC`). **Omits** the heavy `tcx` field. `limit` optional. |
| GET    | `/api/rides/:id`   | Full ride **including** `tcx`. `404 { error }` if not found.                                  |
| POST   | `/api/rides`       | Body is a ride; upsert by `id`. `400 { error }` if `id` missing. Returns the saved ride.      |
| DELETE | `/api/rides/:id`   | `{ ok: true }` — idempotent (ok even if the ride did not exist).                              |
| GET    | `/api/profile`     | Profile object. Returns defaults if no row yet.                                              |
| PUT    | `/api/profile`     | Body is a profile; upsert singleton (`id = 1`). Returns the saved profile.                    |
| GET    | `/api/prefs`       | Prefs object. Returns defaults if no row yet.                                                |
| PUT    | `/api/prefs`       | Body is prefs; upsert singleton (`id = 1`). Returns the saved prefs.                          |
| GET    | `/api/stats`       | Aggregate stats over all rides (all-zeros/nulls when there are no rides).                     |

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

## Notes

- The frontend (`index.html`, `app.html`) is maintained separately; this backend
  never modifies those files.
- The Supabase connection uses SSL and the transaction-mode pooler, so the server
  uses only plain parameterized queries (no session state / named prepared statements).
