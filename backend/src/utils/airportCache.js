import pool from '../database/postgres.js';
import { AIRPORT_CACHE_TTL_MS } from '../config/intervals.js';

// In-memory cache of the (essentially static) airports reference table. Three
// hot paths otherwise re-read all ~2500 rows from the DB: hourly flight
// generation, the hourly used-market fill, and — worst of all — the medical
// diversion lookup, which can fire on every processFlights tick. Caching here
// removes both the hourly full scans and those per-tick egress spikes.
//
// The cached row shape is the union of all three consumers' columns.

let _rows = null;
let _loadedAt = 0;
let _inflight = null;

async function load() {
  const result = await pool.query(
    `SELECT iata_code, category, registration_prefix,
            latitude, longitude, runway_length_m
       FROM airports`
  );
  _rows = result.rows;
  _loadedAt = Date.now();
  return _rows;
}

// Returns all airport rows, refreshing from the DB only when the cache is empty
// or older than the TTL. Concurrent callers during a refresh share one query.
export async function getAirports() {
  const fresh = _rows && (Date.now() - _loadedAt) < AIRPORT_CACHE_TTL_MS;
  if (fresh) return _rows;
  if (_inflight) return _inflight;
  _inflight = load().finally(() => { _inflight = null; });
  return _inflight;
}

// Force the next getAirports() to reload — call after seeding/editing airports.
export function invalidateAirports() {
  _rows = null;
  _loadedAt = 0;
}