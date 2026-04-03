// ── Passenger Satisfaction System ────────────────────────────────────────────
// Each cabin starts at 100. −8 per violated rule. Welcome Chocolate → +5 bonus.
// Final score = seat-weighted average across cabins, capped at 100.
// Aircraft condition < 40 → additional −15 to the final weighted score.

import pool from '../database/postgres.js';

const BEVERAGE_NAMES = ['Water', 'Soda & Juice', 'Beer & Wine', 'Cocktails'];
const FOOD_NAMES     = ['Snack', 'Meal 1 – Small Cold', 'Meal 2 – Large Cold', 'Meal 3 – Large Hot'];

// Seat-type sets for seat-minimum rules
const PRECO_TYPES    = new Set(['premium_economy', 'business', 'first', 'first_suite']);
const SUITE_ONLY     = new Set(['first_suite']);

// Highest luggage tier present in the item set
function getLuggageLevel(items) {
  if (items.has('Luggage 3 – Large'))  return 3;
  if (items.has('Luggage 2 – Medium')) return 2;
  if (items.has('Luggage 1 – Cabin'))  return 1;
  return 0;
}

function evalCabin(cabin, items, seatType, distKm) {
  let score = 100;

  if (items.has('Welcome Chocolate')) score += 5;

  const bevCount  = BEVERAGE_NAMES.filter(n => items.has(n)).length;
  const bevNeeded = distKm >= 4000 ? 3 : distKm >= 1500 ? 2 : 1;
  if (bevCount < 1)                    score -= 8;
  if (distKm >= 1500 && bevCount < 2)  score -= 8;
  if (distKm >= 4000 && bevCount < 3)  score -= 8;
  const bevViolation = bevCount < bevNeeded ? { have: bevCount } : null;

  const foodCount  = FOOD_NAMES.filter(n => items.has(n)).length;
  const foodNeeded = distKm >= 8000 ? 3 : distKm >= 4000 ? 2 : 1;
  if (foodCount < 1)                   score -= 8;
  if (distKm >= 4000 && foodCount < 2) score -= 8;
  if (distKm >= 8000 && foodCount < 3) score -= 8;
  const foodViolation = foodCount < foodNeeded ? { have: foodCount } : null;

  const amenityThresh   = cabin === 'economy' ? 6000 : cabin === 'business' ? 3000 : 2000;
  const amenityViolated = distKm >= amenityThresh && !items.has('Amenity Kit');
  if (amenityViolated) score -= 8;

  const sleepViolated = distKm >= 7000 && !items.has('Sleep Kit');
  if (sleepViolated) score -= 8;

  const entertainmentViolated = distKm >= 4000 && !items.has('Entertainment');
  if (entertainmentViolated) score -= 8;

  const lugLevel  = getLuggageLevel(items);
  const lugNeeded = distKm >= 4000 ? 3 : distKm >= 2000 ? 2 : 1;
  if (lugLevel < 1)                   score -= 8;
  if (distKm >= 2000 && lugLevel < 2) score -= 8;
  if (distKm >= 4000 && lugLevel < 3) score -= 8;
  const lugViolation = lugLevel < lugNeeded ? { have: lugLevel } : null;

  let seatViolation = null;
  if      (cabin === 'economy' && distKm >= 8000 && !PRECO_TYPES.has(seatType))  seatViolation = 'seat_eco';
  else if (cabin === 'first'   && distKm >= 5000 && !SUITE_ONLY.has(seatType))  seatViolation = 'seat_fir';
  if (seatViolation) score -= 8;

  return {
    score: Math.max(0, score),
    bevViolation, foodViolation, amenityViolated, sleepViolated,
    entertainmentViolated, lugViolation, seatViolation,
  };
}

/**
 * Calculate passenger satisfaction score and violations for a flight.
 * Now async — uses PostgreSQL pool directly.
 */
async function calcFlightSatisfaction({
  distKm, serviceProfileId, condition,
  ecoSeats, bizSeats, firstSeats,
  ecoSeatType, bizSeatType, firstSeatType,
}) {
  const totalSeats = (ecoSeats || 0) + (bizSeats || 0) + (firstSeats || 0);
  if (totalSeats === 0) return { score: 100, violations: [] };

  const profileItems = { economy: new Set(), business: new Set(), first: new Set() };
  if (serviceProfileId) {
    try {
      const { rows } = await pool.query(`
        SELECT i.cabin_class, t.item_name
        FROM service_profile_items i
        JOIN service_item_types t ON i.item_type_id = t.id
        WHERE i.profile_id = $1
      `, [serviceProfileId]);
      for (const row of rows) {
        if (profileItems[row.cabin_class]) profileItems[row.cabin_class].add(row.item_name);
      }
    } catch (e) { /* no items */ }
  }

  const cabinSeats = { economy: ecoSeats || 0, business: bizSeats || 0, first: firstSeats || 0 };
  const seatTypes  = {
    economy:  ecoSeatType   || 'economy',
    business: bizSeatType   || 'business',
    first:    firstSeatType || 'first',
  };

  let weightedScore = 0;
  let worstBev = null, worstFood = null, worstLug = null;
  const bevCabins=[], foodCabins=[], amenityCabins=[], sleepCabins=[], entCabins=[], lugCabins=[];
  const seatViolSet = new Set();

  for (const cabin of ['economy', 'business', 'first']) {
    const seats = cabinSeats[cabin];
    if (seats === 0) continue;
    const res = evalCabin(cabin, profileItems[cabin], seatTypes[cabin], distKm);
    weightedScore += res.score * seats;
    if (res.bevViolation) { bevCabins.push(cabin); if (!worstBev || res.bevViolation.have < worstBev.have) worstBev = res.bevViolation; }
    if (res.foodViolation) { foodCabins.push(cabin); if (!worstFood || res.foodViolation.have < worstFood.have) worstFood = res.foodViolation; }
    if (res.amenityViolated) amenityCabins.push(cabin);
    if (res.sleepViolated) sleepCabins.push(cabin);
    if (res.entertainmentViolated) entCabins.push(cabin);
    if (res.lugViolation) { lugCabins.push(cabin); if (!worstLug || res.lugViolation.have < worstLug.have) worstLug = res.lugViolation; }
    if (res.seatViolation) seatViolSet.add(res.seatViolation);
  }

  let score = Math.min(100, Math.round(weightedScore / totalSeats));
  const maintenancePenalty = (condition ?? 100) < 40;
  if (maintenancePenalty) score = Math.max(0, score - 15);

  const violations = [];
  if (worstBev) violations.push({ rule: 'bev', have: Math.min(worstBev.have, 2), cabins: bevCabins });
  if (worstFood) violations.push({ rule: 'food', have: Math.min(worstFood.have, 2), cabins: foodCabins });
  if (amenityCabins.length) violations.push({ rule: 'amenity', cabins: amenityCabins });
  if (sleepCabins.length)   violations.push({ rule: 'sleep',   cabins: sleepCabins });
  if (entCabins.length)     violations.push({ rule: 'ent',     cabins: entCabins });
  if (worstLug) violations.push({ rule: 'lug', have: Math.min(Math.max(worstLug.have, 1), 2), cabins: lugCabins });
  for (const sv of ['seat_eco', 'seat_biz', 'seat_fir']) {
    if (seatViolSet.has(sv)) violations.push({ rule: sv });
  }
  if (maintenancePenalty) violations.push({ rule: 'maint' });

  return { score, violations };
}

/**
 * Airline average satisfaction score from up to 100 recent non-cancelled flights.
 */
async function getAirlineSatisfactionScore(airlineId) {
  try {
    const { rows } = await pool.query(`
      SELECT satisfaction_score FROM flights
      WHERE airline_id = $1
        AND satisfaction_score IS NOT NULL
        AND status != 'cancelled'
      ORDER BY departure_time DESC
      LIMIT 100
    `, [airlineId]);
    if (!rows.length) return 100;
    const scores = rows.map(r => r.satisfaction_score);
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  } catch (e) {
    return 100;
  }
}

function getSatisfactionMultiplier(score) {
  if (score >= 85) return 1.00;
  if (score >= 70) return 0.92;
  if (score >= 55) return 0.80;
  if (score >= 40) return 0.65;
  return 0.50;
}

export { calcFlightSatisfaction, getAirlineSatisfactionScore, getSatisfactionMultiplier };
