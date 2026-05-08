// ── Delay System ──────────────────────────────────────────────────────────
// Auto-rolls delay/cancel/diversion events when flights transition
// scheduled → boarding. Player has no real-time control; outcomes are
// shaped by OCC config (maintenance program, ground handling, wet lease,
// hotel partnership).

import pool from '../database/postgres.js';

// ── Tunables ───────────────────────────────────────────────────────────────
export const BASE_RATES = {
  technical_ground: 0.012, // 1.2%
  ground_ops:       0.010, // 1.0%
  // ATC rate depends on dep airport category; resolved in rollDelays().
  weather:          0.005, // 0.5%
  technical_air:    0.003, // 0.3%
  medical:          0.001, // 0.1%
};

const ATC_RATES_BY_CATEGORY = {
  8: 0.015,
  7: 0.010,
  6: 0.006,
};
const ATC_RATE_DEFAULT = 0.003; // cat 5 and below

// Minor delay duration windows by wake category (minutes)
const MINOR_DELAY_RANGE = {
  L: [5, 15],
  M: [5, 20],
  H: [5, 25],
};

// Medical delay duration by flight distance (minutes)
function medicalDelayMinutes(distanceKm) {
  if (distanceKm < 2000) return 30;
  if (distanceKm <= 6000) return 45;
  return 60;
}

// Wake-cat → turnaround (minutes); aligned with AircraftSchedule WAKE_TURNAROUND
const TURNAROUND_BY_WAKE = { L: 25, M: 40, H: 60 };

// Maintenance program effects (per aircraft per week)
export const MAINTENANCE_PROGRAMS = {
  basic:    { weeklyCost: 0,   technicalReduction: 0.000 },
  enhanced: { weeklyCost: 200, technicalReduction: 0.004 },
  premium:  { weeklyCost: 500, technicalReduction: 0.008 },
};

// Ground handling levels (per hub per week)
export const GROUND_HANDLING_LEVELS = {
  standard: { weeklyCost: 0,    groundOpsReduction: 0.000 },
  priority: { weeklyCost: 3750, groundOpsReduction: 0.003 },
  premium:  { weeklyCost: 6250, groundOpsReduction: 0.006 },
};

// Wet lease contracts (per airline per week)
export const WET_LEASE_CONTRACTS = {
  none:      { weeklyCost: 0,     revenueShare: null },
  basic:     { weeklyCost: 2500,  revenueShare: 0.40 },
  premium:   { weeklyCost: 6250,  revenueShare: 0.25 },
  unlimited: { weeklyCost: 15000, revenueShare: 0.15 },
};

// Hotel partnerships (per airline per week)
export const HOTEL_PARTNERSHIPS = {
  none:      { weeklyCost: 0,     hotelCostPerPax: 150 },
  basic:     { weeklyCost: 1250,  hotelCostPerPax: 120 },
  premium:   { weeklyCost: 3750,  hotelCostPerPax: 90 },
  exclusive: { weeklyCost: 10000, hotelCostPerPax: 60 },
};

const REBOOKING_COST_PER_PAX = 100;

// Maintenance baseline (matches MAINT_BASE_COST in flights.js)
const MAINT_BASE_COST = { L: 2000, M: 8000, H: 15000 };

// ── Helpers ────────────────────────────────────────────────────────────────
function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function rollChance(p) {
  return Math.random() < p;
}

function clampRate(r) {
  return Math.max(0, r);
}

export function getMinorDelayMinutes(wakeCategory) {
  const [lo, hi] = MINOR_DELAY_RANGE[wakeCategory] || MINOR_DELAY_RANGE.M;
  return randInt(lo, hi);
}

export function getTurnaround(wakeCategory) {
  return TURNAROUND_BY_WAKE[wakeCategory] || TURNAROUND_BY_WAKE.M;
}

export function getMaintenanceCost(wakeCategory, condition) {
  const base = MAINT_BASE_COST[wakeCategory] ?? MAINT_BASE_COST.M;
  return Math.round(base * (2 - (condition ?? 100) / 100));
}

// Returns set of airport codes that count as "hubs" for medical-trigger eligibility:
// home_base, primary_hub, all secondary hubs (destination_type = 'hub').
export async function getAirlineHubCodes(airlineId) {
  const out = new Set();
  const ar = await pool.query(
    'SELECT home_airport_code, primary_hub_airport_code FROM airlines WHERE id = $1',
    [airlineId]
  );
  if (ar.rows[0]) {
    if (ar.rows[0].home_airport_code) out.add(ar.rows[0].home_airport_code);
    if (ar.rows[0].primary_hub_airport_code) out.add(ar.rows[0].primary_hub_airport_code);
  }
  const dr = await pool.query(
    "SELECT airport_code FROM airline_destinations WHERE airline_id = $1 AND destination_type = 'hub'",
    [airlineId]
  );
  for (const row of dr.rows) out.add(row.airport_code);
  return out;
}

// Ground handling is now an airline-wide setting (one level applies to all
// hubs). Kept as a function so existing callers don't break.
export async function getGroundHandlingLevel(airlineId) {
  const r = await pool.query(
    'SELECT ground_handling_level FROM airlines WHERE id = $1',
    [airlineId]
  );
  return r.rows[0]?.ground_handling_level || 'standard';
}

// ── Diversion airport finder ──────────────────────────────────────────────
// Returns the closest airport (great-circle) to a midpoint along the route
// that can accept the aircraft (runway_length_m >= min_runway_landing_m).
// Excludes the original departure and arrival airports.
function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export async function findDiversionAirport(depCode, arrCode, minRunwayM, fraction) {
  const apts = await pool.query(
    'SELECT iata_code, latitude, longitude, runway_length_m FROM airports WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
  );
  const dep = apts.rows.find(r => r.iata_code === depCode);
  const arr = apts.rows.find(r => r.iata_code === arrCode);
  if (!dep || !arr) return null;

  // Lerp to find target point at `fraction` of route
  const targetLat = dep.latitude + (arr.latitude - dep.latitude) * fraction;
  const targetLon = dep.longitude + (arr.longitude - dep.longitude) * fraction;

  let best = null;
  let bestDist = Infinity;
  for (const r of apts.rows) {
    if (r.iata_code === depCode || r.iata_code === arrCode) continue;
    if ((r.runway_length_m ?? 0) < (minRunwayM ?? 0)) continue;
    const d = haversineKm(targetLat, targetLon, r.latitude, r.longitude);
    if (d < bestDist) {
      bestDist = d;
      best = r.iata_code;
    }
  }
  return best;
}

// ── The roll function ──────────────────────────────────────────────────────
// Inputs: prepared flight context. Returns a decision object with what to do.
//
// Priority: cancel-events (weather > technical_air > medical) preempt minor
// delays. If no cancel-event triggers, minor delays are rolled (technical_ground,
// ground_ops, atc) — at most one minor outcome per flight.
//
// Returns:
//   { type: 'none' }
//   { type: 'minor', subtype: 'technical_ground'|'ground_ops'|'atc',
//     delayMinutes, technicalCost, satisfactionMalus }
//   { type: 'cancel', subtype: 'weather'|'technical_air'|'medical',
//     wetLeased, satisfactionMalus,
//     // if technical_air:
//     turnbackFraction
//     // if medical:
//     diversionAirport, diversionDelayMinutes, willCancelAtDest }
export async function rollDelaysForFlight(ctx) {
  const {
    airline,            // { id, wet_lease_contract, hotel_partnership }
    aircraft,           // { id, condition, maintenance_program, home_airport, wakeCategory, minRunwayLanding }
    departureAirport,   // { iata_code, category }
    arrivalAirport,     // { iata_code }
    distanceKm,
    isInboundToHub,     // bool — only inbound-to-hub legs are eligible for medical
  } = ctx;

  const wakeCat = aircraft.wakeCategory || 'M';

  // Airline-level maintenance program reduces technical_ground & technical_air
  const maintProg = MAINTENANCE_PROGRAMS[airline.maintenance_program] || MAINTENANCE_PROGRAMS.basic;
  const technicalReduction = maintProg.technicalReduction;

  // Airline-level ground handling reduces ground_ops at departure airport
  const ghCfg = GROUND_HANDLING_LEVELS[airline.ground_handling_level] || GROUND_HANDLING_LEVELS.standard;

  // Effective rates
  const rateTechGround = clampRate(BASE_RATES.technical_ground - technicalReduction);
  const rateGroundOps  = clampRate(BASE_RATES.ground_ops - ghCfg.groundOpsReduction);
  const rateAtc        = ATC_RATES_BY_CATEGORY[departureAirport.category] ?? ATC_RATE_DEFAULT;
  const rateWeather    = BASE_RATES.weather;
  const rateTechAir    = clampRate(BASE_RATES.technical_air - technicalReduction);
  const rateMedical    = BASE_RATES.medical;

  // ── Cancel-events (priority order) ───────────────────────────────────────
  if (rollChance(rateWeather)) {
    const hasContract = (airline.wet_lease_contract && airline.wet_lease_contract !== 'none');
    return {
      type: 'cancel',
      subtype: 'weather',
      wetLeased: !!hasContract,
      satisfactionMalus: hasContract ? 10 : 20,
    };
  }

  if (rollChance(rateTechAir)) {
    const turnbackFraction = rand(0.10, 0.50);
    return {
      type: 'cancel',
      subtype: 'technical_air',
      turnbackFraction,
      // The CURRENT flight aborts mid-air and returns to homebase.
      // The NEXT scheduled leg (cancel or wet-lease) is decided at landing time.
      satisfactionMalus: 10,
    };
  }

  if (isInboundToHub && rollChance(rateMedical)) {
    const fraction = rand(0.30, 0.70);
    const diversion = await findDiversionAirport(
      departureAirport.iata_code,
      arrivalAirport.iata_code,
      aircraft.minRunwayLanding ?? 0,
      fraction
    );
    const medMin = medicalDelayMinutes(distanceKm);
    const turnaround = TURNAROUND_BY_WAKE[wakeCat] || TURNAROUND_BY_WAKE.M;
    return {
      type: 'cancel',
      subtype: 'medical',
      diversionAirport: diversion,
      diversionDelayMinutes: medMin,
      willCancelAtDest: medMin > turnaround,
      satisfactionMalus: 5,
    };
  }

  // ── Minor delays — at most one event per flight ──────────────────────────
  // We probe in priority order; first hit wins. Rates are independent so
  // the cumulative chance of "any minor" stays close to sum-of-rates while
  // ensuring no double-counting.
  if (rollChance(rateTechGround)) {
    return {
      type: 'minor',
      subtype: 'technical_ground',
      delayMinutes: getMinorDelayMinutes(wakeCat),
      technicalCost: Math.round(getMaintenanceCost(wakeCat, aircraft.condition) * 0.30),
      satisfactionMalus: 10,
    };
  }
  if (rollChance(rateGroundOps)) {
    return {
      type: 'minor',
      subtype: 'ground_ops',
      delayMinutes: getMinorDelayMinutes(wakeCat),
      technicalCost: 0,
      satisfactionMalus: 10,
    };
  }
  if (rollChance(rateAtc)) {
    return {
      type: 'minor',
      subtype: 'atc',
      delayMinutes: getMinorDelayMinutes(wakeCat),
      technicalCost: 0,
      satisfactionMalus: 10,
    };
  }

  return { type: 'none' };
}

// ── Cancel cost calculator ─────────────────────────────────────────────────
// Used when a flight is cancelled WITHOUT wet-lease coverage.
// Returns { rebookingCost, hotelCost, totalCost, hotelPerPax }.
export function calcCancelCosts(seatsSold, hotelPartnership) {
  const hp = HOTEL_PARTNERSHIPS[hotelPartnership] || HOTEL_PARTNERSHIPS.none;
  const rebookingCost = seatsSold * REBOOKING_COST_PER_PAX;
  const hotelCost = seatsSold * hp.hotelCostPerPax;
  return {
    rebookingCost,
    hotelCost,
    totalCost: rebookingCost + hotelCost,
    hotelPerPax: hp.hotelCostPerPax,
  };
}

// Wet-lease revenue share for a contract type.
export function getWetLeaseShare(contract) {
  return WET_LEASE_CONTRACTS[contract]?.revenueShare ?? null;
}

// ── Persist a delay event for the weekly report ────────────────────────────
export async function logDelayEvent({
  flightId, airlineId, aircraftId, eventType, outcome,
  delayMinutes = 0, cost = 0, satisfactionMalus = 0,
  wetLeased = false, diversionAirport = null,
}) {
  try {
    await pool.query(
      `INSERT INTO flight_delay_events
       (flight_id, airline_id, aircraft_id, event_type, outcome,
        delay_minutes, cost, satisfaction_malus, wet_leased, diversion_airport)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [flightId, airlineId, aircraftId, eventType, outcome,
       Math.round(delayMinutes), Math.round(cost), Math.round(satisfactionMalus),
       wetLeased, diversionAirport]
    );
  } catch (err) {
    console.error('[delaySystem] logDelayEvent failed:', err.message);
  }
}
