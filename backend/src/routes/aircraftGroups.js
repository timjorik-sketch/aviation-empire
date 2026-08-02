import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';
import { calculateFlightDuration } from './flights.js';
import { validatePriceClamp } from '../utils/marketPricing.js';
import { planGroup } from '../utils/groupPlanner.js';
import {
  syncRoutePrices, flightsOverlapWeekly, flightOverlapsMaintenance,
  bankMaintenanceDuration, BANK_TURNAROUND, activateAircraft, deactivateAircraft,
} from './aircraft.js';

const router = express.Router();

// Aircraft groups: plan ONE round-trip route across SEVERAL aircraft so each
// selected bank is served every day. This is a stateless planning assistant —
// nothing is persisted until `/commit` writes the resulting weekly schedules.

const DAY = 1440;
const WEEK = 7 * DAY;
const mod = (v, m) => ((v % m) + m) % m;

const toHHMM = (min) => {
  const m = mod(Math.round(min), DAY);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const parseHHMM = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = parseInt(m[1]), mi = parseInt(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
};

// Shared setup for /plan and /commit: resolve and validate the aircraft, the two
// routes and the banks, and derive the timing constants the planner needs.
async function loadContext(airlineId, body) {
  const { forward_route_id, return_route_id, aircraft_ids } = body;

  if (!forward_route_id || !return_route_id) {
    return { error: 'forward_route_id and return_route_id are required' };
  }
  if (!Array.isArray(aircraft_ids) || aircraft_ids.length === 0) {
    return { error: 'Select at least one aircraft' };
  }
  const ids = [...new Set(aircraft_ids.map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return { error: 'Select at least one aircraft' };

  const routeResult = await pool.query(
    `SELECT id, flight_number, distance_km, departure_airport, arrival_airport
     FROM routes WHERE id = ANY($1) AND airline_id = $2`,
    [[forward_route_id, return_route_id], airlineId]
  );
  const fwd = routeResult.rows.find(r => r.id === forward_route_id);
  const ret = routeResult.rows.find(r => r.id === return_route_id);
  if (!fwd || !ret) return { error: 'Route not found' };
  if (fwd.departure_airport !== ret.arrival_airport || fwd.arrival_airport !== ret.departure_airport) {
    return { error: 'Return route must be the reverse of the outbound route' };
  }

  const acResult = await pool.query(`
    SELECT a.id, a.registration, a.name, a.is_active, a.airline_cabin_profile_id,
           t.wake_turbulence_category, t.range_km, t.full_name, t.max_passengers,
           t.min_runway_takeoff_m, t.min_runway_landing_m
    FROM aircraft a JOIN aircraft_types t ON a.aircraft_type_id = t.id
    WHERE a.id = ANY($1) AND a.airline_id = $2
  `, [ids, airlineId]);
  if (acResult.rows.length !== ids.length) return { error: 'One or more aircraft not found' };
  // Keep the caller's order so plan slots map back to the same aircraft on commit.
  const byId = new Map(acResult.rows.map(r => [r.id, r]));
  const aircraft = ids.map(id => byId.get(id));

  const apRes = await pool.query(
    'SELECT iata_code, runway_length_m, longitude FROM airports WHERE iata_code = ANY($1)',
    [[fwd.departure_airport, fwd.arrival_airport]]
  );
  const rwy = new Map(apRes.rows.map(r => [r.iata_code, r.runway_length_m]));
  const lon = new Map(apRes.rows.map(r => [r.iata_code, r.longitude]));

  // Every aircraft in the group flies the same route, so every one must be able to.
  const unfit = [];
  for (const ac of aircraft) {
    const reasons = [];
    if (ac.range_km && fwd.distance_km > ac.range_km) {
      reasons.push(`range ${ac.range_km}km < ${fwd.distance_km}km`);
    }
    for (const code of [fwd.departure_airport, fwd.arrival_airport]) {
      const len = rwy.get(code) ?? 0;
      if (ac.min_runway_takeoff_m && len < ac.min_runway_takeoff_m) reasons.push(`runway ${code} too short for takeoff`);
      else if (ac.min_runway_landing_m && len < ac.min_runway_landing_m) reasons.push(`runway ${code} too short for landing`);
    }
    if (reasons.length) unfit.push(`${ac.registration} (${reasons.join(', ')})`);
  }
  if (unfit.length) return { error: `Cannot fly this route: ${unfit.join('; ')}` };

  return {
    fwd, ret, aircraft, lon,
    oneWay: calculateFlightDuration(fwd.distance_km),
    // The whole group shares one timetable, so the strictest turnaround and the
    // longest maintenance block have to govern the plan.
    turnaround: Math.max(...aircraft.map(a => BANK_TURNAROUND[a.wake_turbulence_category] || 40)),
    maintDuration: Math.max(...aircraft.map(a => bankMaintenanceDuration(a.max_passengers))),
  };
}

// Banks are entered in HUB-LOCAL time (how a player thinks about waves) but the
// schedule runs on Berlin game time — same whole-hour longitude approximation the
// single-aircraft bank planner and the frontend clock use.
function hubOffsetMinutes(lon, hubCode) {
  const hubLon = lon.get(hubCode);
  return hubLon != null ? (Math.round(hubLon / 15) - 1) * 60 : 0;
}

async function loadBanks(airlineId, bankIds, hubCode) {
  if (!Array.isArray(bankIds) || bankIds.length === 0) return { error: 'Select at least one bank' };
  const result = await pool.query(
    `SELECT id, name, hub_airport_code, earliest_arrival, latest_arrival, earliest_departure, latest_departure
     FROM airline_banks WHERE id = ANY($1) AND airline_id = $2 ORDER BY earliest_departure, id`,
    [bankIds.map(Number).filter(Number.isInteger), airlineId]
  );
  const banks = result.rows.filter(b => b.hub_airport_code === hubCode);
  if (banks.length === 0) return { error: `Selected banks must belong to the hub ${hubCode}` };
  return { banks };
}

// One planner rotation → the two weekly_schedule legs it consists of.
function rotationLegs(rot, fwd, ret, oneWay, lon) {
  const outDep = rot.dep_wk;
  const inDep = rot.arr_wk - oneWay;
  const leg = (r, depWk, dir) => ({
    direction: dir,
    route_id: r.id, flight_number: r.flight_number,
    departure_airport: r.departure_airport, arrival_airport: r.arrival_airport,
    day_of_week: Math.floor(mod(depWk, WEEK) / DAY),
    departure_time: toHHMM(depWk),
    arrival_time: toHHMM(depWk + oneWay),
    dep_longitude: lon.get(r.departure_airport) ?? null,
    arr_longitude: lon.get(r.arrival_airport) ?? null,
    bank_id: rot.bank_id, bank_name: rot.bank_name, arr_bank_name: rot.arr_bank_name,
  });
  return [leg(fwd, outDep, 'out'), leg(ret, inDep, 'in')];
}

// ── POST /api/aircraft-groups/plan ───────────────────────────────────────────
// Preview only. Returns one assignment per REQUIRED aircraft; if the group needs
// more aircraft than were selected, the surplus slots come back with a null
// aircraft_id so the UI can show "2 more aircraft needed" instead of just failing.
router.post('/plan', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const ctx = await loadContext(airlineId, req.body);
    if (ctx.error) return res.status(400).json({ error: ctx.error });
    const { fwd, ret, aircraft, lon, oneWay, turnaround, maintDuration } = ctx;

    const bankLoad = await loadBanks(airlineId, req.body.bank_ids, fwd.departure_airport);
    if (bankLoad.error) return res.status(400).json({ error: bankLoad.error });

    // Optional wish departure times, keyed by bank id, in hub-local "HH:MM".
    const wishes = req.body.bank_departure_times || {};
    const offset = hubOffsetMinutes(lon, fwd.departure_airport);
    const toGame = (localMin) => mod(localMin - offset, DAY);
    const toLocal = (gameMin) => mod(gameMin + offset, DAY);

    const planBanksInput = [];
    for (const b of bankLoad.banks) {
      const raw = wishes[b.id] ?? wishes[String(b.id)];
      let pref = null;
      if (raw != null && String(raw).trim() !== '') {
        pref = parseHHMM(raw);
        if (pref == null) return res.status(400).json({ error: `Invalid departure time for bank “${b.name}” — use HH:MM` });
        pref = toGame(pref);
      }
      planBanksInput.push({
        id: b.id, name: b.name,
        earliest_arrival: toGame(b.earliest_arrival), latest_arrival: toGame(b.latest_arrival),
        earliest_departure: toGame(b.earliest_departure), latest_departure: toGame(b.latest_departure),
        preferred_departure: pref,
      });
    }

    const strategy = req.body.strategy === 'regular' ? 'regular' : 'fewest';
    const plan = planGroup({ oneWayMinutes: oneWay, turnaround, banks: planBanksInput, maintDuration, strategy });
    if (!plan.feasible) return res.status(400).json({ error: plan.note || 'No feasible plan', feasible: false });

    const assignments = plan.planes.map((p, slot) => {
      const ac = aircraft[slot] || null;
      const legs = p.rotations.flatMap(r => rotationLegs(r, fwd, ret, oneWay, lon));
      legs.sort((a, b) => (a.day_of_week * DAY + parseHHMM(a.departure_time)) - (b.day_of_week * DAY + parseHHMM(b.departure_time)));
      const maintenance = p.maint_start_wk != null ? {
        day_of_week: Math.floor(p.maint_start_wk / DAY),
        start_minutes: mod(p.maint_start_wk, DAY),
        start_time: toHHMM(p.maint_start_wk),
        // Each airframe services on its own schedule length; the plan reserved the
        // longest in the group, so the actual block can only be shorter.
        duration_minutes: ac ? bankMaintenanceDuration(ac.max_passengers) : p.maint_duration,
      } : null;
      return {
        slot,
        aircraft_id: ac?.id ?? null,
        registration: ac?.registration ?? null,
        aircraft_name: ac?.name ?? null,
        aircraft_type: ac?.full_name ?? null,
        is_active: ac?.is_active ?? 0,
        has_cabin_profile: ac ? !!ac.airline_cabin_profile_id : false,
        bank_ids: p.bank_ids,
        bank_names: p.bank_ids.map(id => bankLoad.banks.find(b => b.id === id)?.name).filter(Boolean),
        days: p.days,
        round_trips: p.round_trips,
        flight_hours: p.flight_hours,
        utilisation_pct: p.utilisation_pct,
        legs,
        maintenance,
      };
    });

    const required = plan.planes.length;
    res.json({
      preview: true,
      feasible: true,
      strategy,
      note: plan.note || '',
      required_aircraft: required,
      selected_aircraft: aircraft.length,
      missing_aircraft: Math.max(0, required - aircraft.length),
      spare_aircraft: aircraft.slice(required).map(a => ({
        id: a.id, registration: a.registration, name: a.name,
      })),
      assignments,
      hub: fwd.departure_airport,
      hub_offset_minutes: offset,
      // Bank timings are echoed back in HUB-LOCAL time so they line up with the
      // wish times the player typed in.
      banks: plan.banks.map(b => ({
        ...b,
        departure_local: toHHMM(toLocal(b.departure_minutes)),
        arrival_local: toHHMM(toLocal(b.arrival_minutes)),
      })),
      summary: {
        one_way_minutes: oneWay,
        round_trip_minutes: 2 * oneWay + turnaround,
        turnaround,
        maint_duration: maintDuration,
        departures_per_week: plan.planes.reduce((s, p) => s + p.round_trips, 0),
        total_flight_hours: +plan.planes.reduce((s, p) => s + p.flight_hours, 0).toFixed(1),
      },
    });
  } catch (error) {
    console.error('Group plan error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/aircraft-groups/commit ─────────────────────────────────────────
// Writes the (possibly edited) plan: for every aircraft, replace its weekly
// schedule and maintenance block. Aircraft are deactivated for the write and
// reactivated afterwards — the schedule tables are locked while an aircraft
// operates, so that round trip through inactive is the only way in.
router.post('/commit', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const { assignments, economy_price, business_price, first_price, service_profile_id } = req.body;
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return res.status(400).json({ error: 'No assignments to write' });
    }
    if (assignments.some(a => !a.aircraft_id)) {
      return res.status(400).json({ error: 'The plan needs more aircraft than selected — add aircraft or reduce banks' });
    }
    // Two assignments for one aircraft would silently overwrite each other, since
    // every write replaces that aircraft's whole weekly schedule.
    if (new Set(assignments.map(a => a.aircraft_id)).size !== assignments.length) {
      return res.status(400).json({ error: 'An aircraft appears twice in the plan' });
    }

    const ctx = await loadContext(airlineId, { ...req.body, aircraft_ids: assignments.map(a => a.aircraft_id) });
    if (ctx.error) return res.status(400).json({ error: ctx.error });
    const { fwd, ret, aircraft, oneWay } = ctx;

    const priceErr = validatePriceClamp({ eco: economy_price, biz: business_price, first: first_price });
    if (priceErr) return res.status(400).json({ error: priceErr.error });
    if (!economy_price) return res.status(400).json({ error: 'Economy price is required' });

    const eco = parseFloat(economy_price);
    const biz = business_price != null && business_price !== '' ? parseFloat(business_price) : null;
    const fir = first_price != null && first_price !== '' ? parseFloat(first_price) : null;
    const sp = service_profile_id || null;

    const routeById = new Map([[fwd.id, fwd], [ret.id, ret]]);
    const acById = new Map(aircraft.map(a => [a.id, a]));

    // Rebuild each aircraft's legs from the two known routes (arrival recomputed,
    // never trusted from the client) and re-run the same overlap rules the
    // schedule endpoints enforce, so an edited plan cannot persist a conflict.
    const writes = [];
    for (const a of assignments) {
      const ac = acById.get(a.aircraft_id);
      const pad = BANK_TURNAROUND[ac.wake_turbulence_category] || 40;
      if (!Array.isArray(a.legs) || a.legs.length === 0) {
        return res.status(400).json({ error: `${ac.registration} has no flights in the plan` });
      }

      const legs = [];
      for (const l of a.legs) {
        const r = routeById.get(l.route_id);
        if (!r) return res.status(400).json({ error: 'A leg references a route outside this group' });
        const dow = parseInt(l.day_of_week);
        const depMin = parseHHMM(l.departure_time);
        if (!(dow >= 0 && dow <= 6) || depMin == null) {
          return res.status(400).json({ error: `Invalid day or departure time on ${ac.registration}` });
        }
        const dur = calculateFlightDuration(r.distance_km);
        legs.push({
          route_id: r.id, flight_number: r.flight_number,
          departure_airport: r.departure_airport, arrival_airport: r.arrival_airport,
          day_of_week: dow, departure_time: toHHMM(depMin), arrival_time: toHHMM(depMin + dur),
          dep_wk: dow * DAY + depMin, arr_wk: dow * DAY + depMin + dur,
        });
      }

      for (let i = 0; i < legs.length; i++) {
        for (let j = i + 1; j < legs.length; j++) {
          if (flightsOverlapWeekly(legs[i].dep_wk, legs[i].arr_wk, legs[j].dep_wk, legs[j].arr_wk, pad)) {
            return res.status(400).json({ error: `${ac.registration}: two flights overlap — adjust the plan and retry` });
          }
        }
      }

      let maint = null;
      if (a.maintenance && a.maintenance.day_of_week != null) {
        const mDow = parseInt(a.maintenance.day_of_week);
        const mStart = parseInt(a.maintenance.start_minutes);
        if (!(mDow >= 0 && mDow <= 6) || !(mStart >= 0 && mStart < DAY)) {
          return res.status(400).json({ error: `Invalid maintenance slot on ${ac.registration}` });
        }
        // Duration is the aircraft's own service length, never the client's value.
        const duration = bankMaintenanceDuration(ac.max_passengers);
        const mS = mDow * DAY + mStart;
        for (const l of legs) {
          if (flightOverlapsMaintenance(l.dep_wk, l.arr_wk, pad, mS, mS + duration)) {
            return res.status(400).json({ error: `${ac.registration}: maintenance overlaps a flight — adjust the plan and retry` });
          }
        }
        maint = { day_of_week: mDow, start_minutes: mStart, duration_minutes: duration };
      }

      const newName = typeof a.aircraft_name === 'string' && a.aircraft_name.trim()
        ? a.aircraft_name.trim().slice(0, 60)
        : null;
      // Remember whether the player had this aircraft operating: the write has to
      // ground it to unlock the schedule tables, and only aircraft that were
      // already flying may be put back into service afterwards.
      writes.push({ ac, legs, maint, newName, wasActive: !!ac.is_active });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const w of writes) {
        // Deactivate first: weekly_schedule and maintenance_schedule are locked
        // while an aircraft is operating. This also cancels the flights already
        // generated from the OLD schedule — otherwise they keep running next to
        // the new plan.
        await deactivateAircraft(w.ac.id, client);
        // flights.weekly_schedule_id is ON DELETE NO ACTION, so the template rows
        // can't be dropped while any flight still points at them.
        await client.query('UPDATE flights SET weekly_schedule_id = NULL WHERE aircraft_id = $1', [w.ac.id]);
        await client.query('DELETE FROM weekly_schedule WHERE aircraft_id = $1', [w.ac.id]);
        await client.query('DELETE FROM maintenance_schedule WHERE aircraft_id = $1 AND airline_id = $2', [w.ac.id, airlineId]);

        const values = [];
        const placeholders = [];
        let idx = 1;
        for (const l of w.legs) {
          placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
          values.push(w.ac.id, l.day_of_week, l.flight_number, l.departure_airport, l.arrival_airport,
            l.departure_time, l.arrival_time, eco, biz, fir, l.route_id, sp);
        }
        await client.query(`
          INSERT INTO weekly_schedule
            (aircraft_id, day_of_week, flight_number, departure_airport, arrival_airport,
             departure_time, arrival_time, economy_price, business_price, first_price, route_id, service_profile_id)
          VALUES ${placeholders.join(', ')}
        `, values);

        if (w.maint) {
          // Mirror maintenance.js: if this week's slot already passed, pre-mark it
          // as completed so the processor bills it next week instead of instantly.
          const now = new Date();
          const jsDay = now.getDay();
          const currentDow = jsDay === 0 ? 6 : jsDay - 1;
          const currentWeekMin = currentDow * DAY + now.getHours() * 60 + now.getMinutes();
          const trigger = w.maint.day_of_week * DAY + w.maint.start_minutes;
          await client.query(`
            INSERT INTO maintenance_schedule
              (aircraft_id, airline_id, day_of_week, start_minutes, duration_minutes, type, status, last_completed_at)
            VALUES ($1, $2, $3, $4, $5, 'routine', 'scheduled', $6)
          `, [w.ac.id, airlineId, w.maint.day_of_week, w.maint.start_minutes, w.maint.duration_minutes,
              currentWeekMin >= trigger ? now.toISOString() : null]);
        }

        if (w.newName) {
          await client.query('UPDATE aircraft SET name = $1 WHERE id = $2', [w.newName, w.ac.id]);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    await syncRoutePrices(fwd.id, eco, biz, fir, sp);
    await syncRoutePrices(ret.id, eco, biz, fir, sp);

    // Restore the previous operating state — ONLY aircraft that were already
    // flying go back into service. Committing a plan must never put a grounded
    // aircraft into the air behind the player's back; one that was parked stays
    // parked with its new schedule written, ready to be flipped green manually.
    // The schedules are already committed, so an aircraft that cannot be
    // reactivated (no crew, expansion capacity) is reported rather than rolled
    // back — the player fixes the cause and activates it themselves.
    const activation = [];
    for (const w of writes) {
      if (!w.wasActive) {
        activation.push({
          aircraft_id: w.ac.id,
          registration: w.ac.registration,
          activated: false,
          left_grounded: true,
          error: null,
        });
        continue;
      }
      const result = await activateAircraft(airlineId, w.ac.id);
      activation.push({
        aircraft_id: w.ac.id,
        registration: w.ac.registration,
        activated: result.ok,
        left_grounded: false,
        error: result.ok ? null : (result.message || result.error),
      });
    }

    const legCount = writes.reduce((s, w) => s + w.legs.length, 0);
    const grounded = activation.filter(a => a.left_grounded);
    const failed = activation.filter(a => !a.activated && !a.left_grounded);
    const notes = [];
    if (failed.length) notes.push(`${failed.length} could not be reactivated`);
    if (grounded.length) notes.push(`${grounded.length} left grounded (were not operating before)`);
    res.status(201).json({
      message: `Group plan written: ${writes.length} aircraft, ${legCount} flights`
        + (notes.length ? ` — ${notes.join(', ')}` : ' — all aircraft operating'),
      aircraft_count: writes.length,
      leg_count: legCount,
      activation,
    });
  } catch (error) {
    console.error('Group commit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
