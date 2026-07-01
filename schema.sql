-- cycleAPP database schema (Supabase Postgres)
-- This DDL is also run automatically on server boot (CREATE TABLE IF NOT EXISTS).
-- Single-user app: profile and prefs are singletons (one row each, id = 1). rides is a list.

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
