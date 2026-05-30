// Central definition of all server-side recurring intervals.
// Frontend poll intervals live in frontend/src/config/pollingIntervals.js —
// the two runtimes can't share a module, so keep the two files in sync by hand.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

// Flight status processor: status transitions (boarding → departure → landing),
// cost settlement and aircraft relocation. The frontend never surfaces changes
// faster than its own polling (live map 45s), so 60s here is invisible to
// players while cutting the fixed per-tick overhead (heartbeat + due-flight
// scans) by 6× compared to the old 10s tick.
export const FLIGHT_PROCESSOR_MS = 60 * SECOND;

// TTL for the in-memory airports cache. Airports are static reference data
// (~2500 rows) seeded at boot; the TTL only guards against rare runtime edits.
export const AIRPORT_CACHE_TTL_MS = 60 * MINUTE;