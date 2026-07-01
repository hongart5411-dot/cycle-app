// cycleAPP backend — Node.js + Express + node-postgres (pg) + dotenv
// Single-user cycling-computer web app. Serves index.html (landing) and app.html
// (riding app) from one origin, plus a JSON API backed by Supabase Postgres.

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
// Optional shared-secret gate. When API_TOKEN is set, every /api route except
// /api/health requires it (Authorization: Bearer <token>, or x-api-key header).
// Unset = open API (keeps local dev / earlier behavior working).
const API_TOKEN = (process.env.API_TOKEN || '').trim();
// Username/password for the in-app login screen. Checked server-side (kept in env,
// never shipped to the client); on success the server returns API_TOKEN.
const AUTH_USER = (process.env.AUTH_USER || '').trim();
const AUTH_PASS = process.env.AUTH_PASS || '';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
// Supabase transaction-mode pooler (port 6543): use ONLY plain parameterized
// queries (pool.query). No session state, no named prepared statements.
// SSL is required; the pooler presents a cert chain we don't pin in dev.
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3, // serverless instances are short-lived; keep the per-instance pool small (Supabase pooler multiplexes)
});

// Reflects whether migrations succeeded at boot. /api/health does a live probe,
// but this is a useful fallback/log signal.
let dbReady = false;

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS rides (
    id          text PRIMARY KEY,
    date        timestamptz,
    screen      text,
    mock        boolean,
    secs        int,
    dist_km     numeric,
    avg_speed   numeric,
    max_speed   numeric,
    avg_power   int,
    max_power   int,
    np          int,
    iff         numeric,
    tss         int,
    avg_hr      int,
    ascent      int,
    tcx         text,
    created_at  timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS profile (
    id          int PRIMARY KEY DEFAULT 1,
    weight      int,
    ftp         int,
    height      int,
    age         int,
    sex         text,
    max_hr      int,
    updated_at  timestamptz DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS prefs (
    id              int PRIMARY KEY DEFAULT 1,
    selected_screen text,
    auto_connect    boolean,
    demo            boolean,
    auto_pause      boolean,
    updated_at      timestamptz DEFAULT now()
  );
`;

async function runMigrations() {
  await pool.query(MIGRATION_SQL);
}

// Serverless (Vercel) has no boot step, so ensure the schema lazily on the first
// API request, cached per cold start. Idempotent (CREATE TABLE IF NOT EXISTS) and
// effectively a no-op once the tables exist.
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool.query(MIGRATION_SQL)
      .then(() => { dbReady = true; })
      .catch((err) => { schemaPromise = null; dbReady = false; throw err; });
  }
  return schemaPromise;
}

// ---------------------------------------------------------------------------
// Helpers: row <-> JSON mapping (snake_case DB <-> camelCase API)
// ---------------------------------------------------------------------------
// pg returns NUMERIC as string and may return null. Coerce so the frontend gets
// real numbers. num() keeps null as null; numOr() applies a default for missing.
const num = (v) => (v === null || v === undefined ? null : Number(v));
const int = (v) => (v === null || v === undefined ? null : parseInt(v, 10));

// Full ride (includes tcx). Used by GET /api/rides/:id and POST response.
function rideFromRow(r) {
  return {
    id: r.id,
    date: r.date instanceof Date ? r.date.toISOString() : r.date,
    screen: r.screen,
    mock: r.mock,
    secs: int(r.secs),
    distKm: num(r.dist_km),
    avgSpeed: num(r.avg_speed),
    maxSpeed: num(r.max_speed),
    avgPower: int(r.avg_power),
    maxPower: int(r.max_power),
    np: int(r.np),
    iff: num(r.iff),
    tss: int(r.tss),
    avgHr: int(r.avg_hr),
    ascent: int(r.ascent),
    tcx: r.tcx,
  };
}

// Summary ride (omits heavy tcx). Used by GET /api/rides list.
function rideSummaryFromRow(r) {
  const ride = rideFromRow(r);
  delete ride.tcx;
  return ride;
}

const PROFILE_DEFAULTS = { weight: 83, ftp: 277, height: 183, age: 49, sex: 'M', maxHr: 0 };
const PREFS_DEFAULTS = { selectedScreen: 'zone2', autoConnect: true, demo: false, autoPause: true };

function profileFromRow(r) {
  return {
    weight: int(r.weight),
    ftp: int(r.ftp),
    height: int(r.height),
    age: int(r.age),
    sex: r.sex,
    maxHr: int(r.max_hr),
  };
}

function prefsFromRow(r) {
  return {
    selectedScreen: r.selected_screen,
    autoConnect: r.auto_connect,
    demo: r.demo,
    autoPause: r.auto_pause,
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '5mb' })); // TCX payloads can be large

// Permissive CORS for dev (app may be opened from file:// while testing).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Shared-token auth gate. Guards every /api route except /api/health, and only
// when API_TOKEN is configured (otherwise the API stays open, e.g. local dev).
// Token via "Authorization: Bearer <token>" or "x-api-key: <token>".
app.use((req, res, next) => {
  if (!API_TOKEN) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health' || req.path === '/api/login') return next();
  const auth = req.get('authorization') || '';
  const provided = (auth.startsWith('Bearer ') ? auth.slice(7) : (req.get('x-api-key') || '')).trim();
  if (provided === API_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// Lazily ensure tables exist before handling any API call (no-op once present).
// Matters on serverless cold starts; locally start() has already migrated.
app.use('/api', (req, res, next) => {
  ensureSchema().then(() => next()).catch(() => next());
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// Health — db reflects a live SELECT 1.
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true, protected: !!API_TOKEN });
  } catch (err) {
    res.json({ ok: true, db: false, protected: !!API_TOKEN });
  }
});

// Public login: exchange username/password for the API token. Credentials live in
// env (AUTH_USER/AUTH_PASS) and never reach the client; on success we return the
// bearer token the gate checks. Exempt from the auth gate above.
app.post('/api/login', (req, res) => {
  if (!API_TOKEN || !AUTH_USER || !AUTH_PASS) return res.status(503).json({ error: 'login not configured' });
  const { username, password } = req.body || {};
  if (String(username || '').trim() === AUTH_USER && String(password || '') === AUTH_PASS) {
    return res.json({ token: API_TOKEN });
  }
  return res.status(401).json({ error: 'invalid credentials' });
});

// List rides (newest first), omitting the heavy tcx field. Honors ?limit=N.
app.get('/api/rides', async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10);
    const hasLimit = Number.isInteger(limitRaw) && limitRaw > 0;
    const sql = hasLimit
      ? 'SELECT * FROM rides ORDER BY date DESC NULLS LAST LIMIT $1'
      : 'SELECT * FROM rides ORDER BY date DESC NULLS LAST';
    const { rows } = hasLimit ? await pool.query(sql, [limitRaw]) : await pool.query(sql);
    res.json(rows.map(rideSummaryFromRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single ride including tcx.
app.get('/api/rides/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM rides WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
    res.json(rideFromRow(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/update a ride (upsert by id).
app.post('/api/rides', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: 'Ride id is required' });

    const sql = `
      INSERT INTO rides
        (id, date, screen, mock, secs, dist_km, avg_speed, max_speed,
         avg_power, max_power, np, iff, tss, avg_hr, ascent, tcx)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (id) DO UPDATE SET
        date = EXCLUDED.date,
        screen = EXCLUDED.screen,
        mock = EXCLUDED.mock,
        secs = EXCLUDED.secs,
        dist_km = EXCLUDED.dist_km,
        avg_speed = EXCLUDED.avg_speed,
        max_speed = EXCLUDED.max_speed,
        avg_power = EXCLUDED.avg_power,
        max_power = EXCLUDED.max_power,
        np = EXCLUDED.np,
        iff = EXCLUDED.iff,
        tss = EXCLUDED.tss,
        avg_hr = EXCLUDED.avg_hr,
        ascent = EXCLUDED.ascent,
        tcx = EXCLUDED.tcx
      RETURNING *;
    `;
    const params = [
      b.id,
      b.date ?? null,
      b.screen ?? null,
      b.mock ?? null,
      b.secs ?? null,
      b.distKm ?? null,
      b.avgSpeed ?? null,
      b.maxSpeed ?? null,
      b.avgPower ?? null,
      b.maxPower ?? null,
      b.np ?? null,
      b.iff ?? null,
      b.tss ?? null,
      b.avgHr ?? null,
      b.ascent ?? null,
      b.tcx ?? null,
    ];
    const { rows } = await pool.query(sql, params);
    res.json(rideFromRow(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a ride (idempotent).
app.delete('/api/rides/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM rides WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Profile singleton (id = 1). Returns defaults if no row yet.
app.get('/api/profile', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM profile WHERE id = 1');
    if (rows.length === 0) return res.json({ ...PROFILE_DEFAULTS });
    res.json(profileFromRow(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/profile', async (req, res) => {
  try {
    const b = { ...PROFILE_DEFAULTS, ...(req.body || {}) };
    const sql = `
      INSERT INTO profile (id, weight, ftp, height, age, sex, max_hr, updated_at)
      VALUES (1, $1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (id) DO UPDATE SET
        weight = EXCLUDED.weight,
        ftp = EXCLUDED.ftp,
        height = EXCLUDED.height,
        age = EXCLUDED.age,
        sex = EXCLUDED.sex,
        max_hr = EXCLUDED.max_hr,
        updated_at = now()
      RETURNING *;
    `;
    const params = [b.weight, b.ftp, b.height, b.age, b.sex, b.maxHr];
    const { rows } = await pool.query(sql, params);
    res.json(profileFromRow(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prefs singleton (id = 1). Returns defaults if no row yet.
app.get('/api/prefs', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM prefs WHERE id = 1');
    if (rows.length === 0) return res.json({ ...PREFS_DEFAULTS });
    res.json(prefsFromRow(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/prefs', async (req, res) => {
  try {
    const b = { ...PREFS_DEFAULTS, ...(req.body || {}) };
    const sql = `
      INSERT INTO prefs (id, selected_screen, auto_connect, demo, auto_pause, updated_at)
      VALUES (1, $1, $2, $3, $4, now())
      ON CONFLICT (id) DO UPDATE SET
        selected_screen = EXCLUDED.selected_screen,
        auto_connect = EXCLUDED.auto_connect,
        demo = EXCLUDED.demo,
        auto_pause = EXCLUDED.auto_pause,
        updated_at = now()
      RETURNING *;
    `;
    const params = [b.selectedScreen, b.autoConnect, b.demo, b.autoPause];
    const { rows } = await pool.query(sql, params);
    res.json(prefsFromRow(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aggregate stats over all rides. Returns zeros/nulls gracefully with no rides.
app.get('/api/stats', async (_req, res) => {
  try {
    const sql = `
      SELECT
        COUNT(*)                          AS total_rides,
        COALESCE(SUM(dist_km), 0)         AS total_km,
        COALESCE(SUM(secs), 0)            AS total_secs,
        COALESCE(SUM(ascent), 0)          AS total_ascent,
        COALESCE(ROUND(AVG(avg_power)), 0) AS avg_power,
        COALESCE(MAX(max_power), 0)       AS max_power,
        COALESCE(MAX(max_speed), 0)       AS max_speed,
        COALESCE(AVG(avg_speed), 0)       AS avg_speed,
        MAX(date)                         AS last_ride_date
      FROM rides;
    `;
    const { rows } = await pool.query(sql);
    const r = rows[0];
    const lastRideDate = r.last_ride_date
      ? (r.last_ride_date instanceof Date ? r.last_ride_date.toISOString() : r.last_ride_date)
      : null;
    res.json({
      totalRides: int(r.total_rides) || 0,
      totalKm: Math.round(Number(r.total_km) * 100) / 100,
      totalSecs: int(r.total_secs) || 0,
      totalAscent: int(r.total_ascent) || 0,
      avgPower: int(r.avg_power) || 0,
      maxPower: int(r.max_power) || 0,
      maxSpeed: Math.round(Number(r.max_speed) * 10) / 10,
      avgSpeed: Math.round(Number(r.avg_speed) * 10) / 10,
      lastRideDate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Static file serving (same origin hosts pages + API)
// ---------------------------------------------------------------------------
// Explicit page routes first, then static for any other asset. We intentionally
// do NOT register a catch-all SPA fallback: index.html and app.html are distinct
// pages and unknown /api/* paths should 404 as JSON-ish, not return HTML.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get(['/app', '/app.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start() {
  try {
    await runMigrations();
    dbReady = true;
  } catch (err) {
    dbReady = false;
    console.error('\n[DB] Connection/migration FAILED — starting HTTP server anyway.');
    console.error('[DB] /api/health will report db:false. Static files will still serve.');
    console.error('[DB] Error:', err.message, '\n');
  }

  app.listen(PORT, () => {
    const line = '─'.repeat(52);
    console.log('\n' + line);
    console.log('  cycleAPP backend is running');
    console.log(line);
    console.log(`  Landing : http://localhost:${PORT}/`);
    console.log(`  App     : http://localhost:${PORT}/app`);
    console.log(`  API     : http://localhost:${PORT}/api/health`);
    console.log(`  Database: ${dbReady ? 'CONNECTED ✓ (tables ready)' : 'FAILED ✗ (serving static only)'}`);
    console.log(`  API auth: ${API_TOKEN ? 'ON ✓ (token required)' : 'OFF (open — set API_TOKEN to protect)'}`);
    console.log(line + '\n');
  });
}

// Local dev: migrate + listen. On Vercel the app is imported as a serverless
// handler (require.main !== module), so we export it without listening.
if (require.main === module) {
  start();
}

module.exports = app;
