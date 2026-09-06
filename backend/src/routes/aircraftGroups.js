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
    SELECT a.id, a.registration, a.name, a.is_active, a.airline_cabin_profile_id, a.home_airport,
           t.wake_turbulence_category, t.range_km, t.full_name, t.max_passengers,
           t.min_runway_takeoff_m, t.min_runway_landing_m
    FROM aircraft a JOIN aircraft_types t ON a.aircraft_type_id = t.id
    WHERE a.id = ANY($1) AND a.airline_id = $2
  `, [ids, airlineId]);
  if (acResult.rows.length !== ids.length) return { error: 'One or more aircraft not found' };
  // Keep the caller's order so plan slots map back to the same aircraft on commit.
  const byId = new Map(acResult.rows.map(r => [r.id, r]));
  const aircraft = ids.map(id => byId.get(id));

  // Route airports for the range/runway checks, plus every home base in the group
  // so each aircraft's week can be shown in its own local time.
  const apRes = await pool.query(
    'SELECT iata_code, runway_length_m, longitude FROM airports WHERE iata_code = ANY($1)',
    [[...new Set([fwd.departure_airport, fwd.arrival_airport,
                  ...aircraft.map(a => a.home_airport).filter(Boolean)])]]
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
      // A player reads an aircraft's week in the time zone it lives in, so the
      // client needs its home base offset. Falls back to the hub — which is where
      // the aircraft flies from either way — when the base has no coordinates.
      const homeCode = ac?.home_airport || null;
      const homeOffset = homeCode && lon.get(homeCode) != null
        ? hubOffsetMinutes(lon, homeCode)
        : offset;

      return {
        slot,
        aircraft_id: ac?.id ?? null,
        registration: ac?.registration ?? null,
        aircraft_name: ac?.name ?? null,
        aircraft_type: ac?.full_name ?? null,
        home_airport: homeCode,
        home_offset_minutes: homeOffset,
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

// ── Copy Schedule ─────────────────────────────────────────────────────────────
// Clone ONE aircraft's whole weekly plan onto SEVERAL others, each with its own
// offset. Same idea as the copy on the schedule page, but many targets at once:
// the offsets are what turn a single week into a staggered group rotation.
//
// Offsets are signed minutes and always roll across the week — a +6 h shift on a
// 22:00 departure genuinely lands at 04:00 the next day, and a group is built by
// moving aircraft into the days the source does not cover.
function shiftWeek(dayOfWeek, minuteOfDay, shiftMin) {
  const total = mod(dayOfWeek * DAY + minuteOfDay + shiftMin, WEEK);
  return { day: Math.floor(total / DAY), minuteOfDay: total % DAY };
}

// Everything both /copy-plan and /copy-commit need: the source week, the targets,
// and each target's shifted result with its own conflicts already resolved.
// Per-target problems are reported on the target (`error`), never thrown — one
// unfit aircraft must not cost the player the whole plan.
async function buildCopy(airlineId, body) {
  const { source_aircraft_id, targets } = body;

  const srcId = parseInt(source_aircraft_id);
  if (!Number.isInteger(srcId)) return { error: 'Select a source aircraft' };
  if (!Array.isArray(targets) || targets.length === 0) {
    return { error: 'Select at least one aircraft to copy onto' };
  }

  const seen = new Set();
  const wanted = [];
  for (const t of targets) {
    const id = parseInt(t?.aircraft_id);
    if (!Number.isInteger(id)) return { error: 'A target aircraft is missing its id' };
    if (id === srcId) return { error: 'The source aircraft cannot also be a target' };
    // Two entries for one aircraft would silently overwrite each other, since every
    // write replaces that aircraft's whole weekly schedule.
    if (seen.has(id)) return { error: 'An aircraft appears twice in the copy list' };
    seen.add(id);
    // Kept signed and un-normalised so the preview can echo back the offset the
    // player typed; shiftWeek wraps it into the week where it is applied.
    const shift = Math.round(Number(t?.shift_minutes ?? 0));
    if (!Number.isFinite(shift) || Math.abs(shift) > 8 * WEEK) {
      return { error: 'Invalid offset on a target aircraft' };
    }
    // The name field shows what the aircraft will be called, so an empty one is a
    // deliberate erase; only an absent field leaves the current name alone.
    const rename = typeof t?.aircraft_name === 'string'
      ? { name: t.aircraft_name.trim().slice(0, 60) || null }
      : null;
    wanted.push({ id, shift, rename });
  }

  const acResult = await pool.query(`
    SELECT a.id, a.registration, a.name, a.is_active, a.home_airport,
           a.airline_cabin_profile_id, a.crew_assigned,
           t.wake_turbulence_category, t.range_km, t.full_name, t.max_passengers,
           t.min_runway_takeoff_m, t.min_runway_landing_m
    FROM aircraft a JOIN aircraft_types t ON a.aircraft_type_id = t.id
    WHERE a.id = ANY($1) AND a.airline_id = $2
  `, [[srcId, ...wanted.map(w => w.id)], airlineId]);
  const byId = new Map(acResult.rows.map(r => [r.id, r]));

  const source = byId.get(srcId);
  if (!source) return { error: 'Source aircraft not found' };
  if (wanted.some(w => !byId.get(w.id))) return { error: 'One or more target aircraft not found' };

  const schedResult = await pool.query(`
    SELECT ws.day_of_week, ws.flight_number, ws.departure_airport, ws.arrival_airport,
           ws.departure_time, ws.arrival_time, ws.economy_price, ws.business_price,
           ws.first_price, ws.route_id, ws.service_profile_id,
           COALESCE(ws.is_transfer, 0) AS is_transfer,
           COALESCE(ws.distance_km, r.distance_km) AS distance_km
    FROM weekly_schedule ws
    LEFT JOIN routes r ON r.id = ws.route_id
    WHERE ws.aircraft_id = $1
    ORDER BY ws.day_of_week, ws.departure_time
  `, [srcId]);
  const maintResult = await pool.query(
    `SELECT day_of_week, start_minutes, duration_minutes, type
     FROM maintenance_schedule
     WHERE aircraft_id = $1 AND airline_id = $2 AND day_of_week IS NOT NULL
     ORDER BY day_of_week, start_minutes`,
    [srcId, airlineId]
  );
  if (schedResult.rows.length === 0 && maintResult.rows.length === 0) {
    return { error: `${source.registration} has no weekly schedule to copy` };
  }

  // Runways for every airport the source week touches, so each target can be
  // checked against the same route set the source flies.
  const codes = [...new Set(schedResult.rows.flatMap(r => [r.departure_airport, r.arrival_airport]))];
  const apRes = codes.length
    ? await pool.query('SELECT iata_code, runway_length_m, longitude FROM airports WHERE iata_code = ANY($1)', [codes])
    : { rows: [] };
  const rwy = new Map(apRes.rows.map(r => [r.iata_code, r.runway_length_m ?? 0]));
  const lon = new Map(apRes.rows.map(r => [r.iata_code, r.longitude]));

  const srcLegs = schedResult.rows.map(r => {
    const depMin = parseHHMM(r.departure_time) ?? 0;
    const dist = r.distance_km ?? 0;
    return {
      day_of_week: r.day_of_week,
      departure_time: r.departure_time,
      dep_minutes: depMin,
      arrival_time: r.arrival_time,
      flight_number: r.flight_number,
      departure_airport: r.departure_airport,
      arrival_airport: r.arrival_airport,
      economy_price: r.economy_price, business_price: r.business_price, first_price: r.first_price,
      route_id: r.route_id, service_profile_id: r.service_profile_id,
      is_transfer: !!r.is_transfer,
      distance_km: dist,
      // Block time is a property of the distance, not of the row it was written
      // from — recomputed so a copy can never inherit a stale arrival time.
      duration: calculateFlightDuration(dist),
      dep_longitude: lon.get(r.departure_airport) ?? null,
      arr_longitude: lon.get(r.arrival_airport) ?? null,
    };
  });
  const srcMaint = maintResult.rows[0] || null;

  const results = wanted.map(({ id, shift, rename }) => {
    const ac = byId.get(id);
    const pad = BANK_TURNAROUND[ac.wake_turbulence_category] || 40;
    const warnings = [];

    // Can this aircraft fly what the source flies? Checked per airport pair so the
    // message names the leg that fails rather than just refusing the aircraft.
    const reasons = new Set();
    for (const l of srcLegs) {
      if (ac.range_km && l.distance_km > ac.range_km) {
        reasons.add(`range ${ac.range_km}km < ${l.departure_airport}–${l.arrival_airport} ${Math.round(l.distance_km)}km`);
      }
      if (ac.min_runway_takeoff_m && (rwy.get(l.departure_airport) ?? 0) < ac.min_runway_takeoff_m) {
        reasons.add(`runway ${l.departure_airport} too short for takeoff`);
      }
      if (ac.min_runway_landing_m && (rwy.get(l.arrival_airport) ?? 0) < ac.min_runway_landing_m) {
        reasons.add(`runway ${l.arrival_airport} too short for landing`);
      }
    }
    const base = {
      aircraft_id: id, registration: ac.registration,
      // What it will be called after the write, so the preview and the fleet list
      // agree the moment the copy lands.
      name: rename ? rename.name : ac.name,
      rename: !!rename,
      full_name: ac.full_name, home_airport: ac.home_airport,
      was_active: !!ac.is_active, shift_minutes: shift,
      // Two of the three operating prerequisites; the third (a non-empty weekly
      // schedule) is what this copy is about to give it. Expansion capacity is
      // only knowable at activation time, so it stays the server's answer.
      has_cabin_profile: !!ac.airline_cabin_profile_id,
      has_crew: !!ac.crew_assigned,
    };
    if (reasons.size) {
      return { ...base, legs: [], maintenance: null, warnings: [], error: `Cannot fly this schedule: ${[...reasons].join(', ')}` };
    }

    const legs = srcLegs.map(l => {
      const s = shiftWeek(l.day_of_week, l.dep_minutes, shift);
      const depWk = s.day * DAY + s.minuteOfDay;
      return {
        ...l,
        day_of_week: s.day,
        departure_time: toHHMM(s.minuteOfDay),
        arrival_time: toHHMM(s.minuteOfDay + l.duration),
        dep_wk: depWk, arr_wk: depWk + l.duration,
      };
    });

    // A uniform shift keeps the legs' relative spacing, so this can only bite when
    // the target's turnaround is longer than the source's — exactly the case worth
    // catching before anything is written.
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        if (flightsOverlapWeekly(legs[i].dep_wk, legs[i].arr_wk, legs[j].dep_wk, legs[j].arr_wk, pad)) {
          return {
            ...base, legs: [], maintenance: null, warnings: [],
            error: `Two flights overlap on this aircraft (${pad} min turnaround) — ${legs[i].flight_number} and ${legs[j].flight_number}`,
          };
        }
      }
    }

    // Maintenance keeps the source's slot but takes the TARGET's service length,
    // which is derived from its seat count. A longer block that no longer fits is
    // dropped with a warning instead of failing the copy — the flights are the
    // point, and the block can be re-placed on the schedule page.
    let maintenance = null;
    if (srcMaint) {
      const s = shiftWeek(srcMaint.day_of_week, srcMaint.start_minutes, shift);
      const duration = bankMaintenanceDuration(ac.max_passengers);
      const mStart = s.day * DAY + s.minuteOfDay;
      const clash = legs.find(l => flightOverlapsMaintenance(l.dep_wk, l.arr_wk, pad, mStart, mStart + duration));
      if (clash) {
        warnings.push(`Maintenance skipped — ${duration} min at ${toHHMM(s.minuteOfDay)} would overlap ${clash.flight_number}`);
      } else {
        maintenance = {
          day_of_week: s.day, start_minutes: s.minuteOfDay,
          start_time: toHHMM(s.minuteOfDay), duration_minutes: duration,
          type: srcMaint.type || 'routine',
        };
        if (duration !== srcMaint.duration_minutes) {
          warnings.push(`Maintenance runs ${duration} min here (source: ${srcMaint.duration_minutes} min) — it follows this aircraft's seat count`);
        }
      }
    }

    return { ...base, legs, maintenance, warnings, error: null };
  });

  return {
    source: {
      aircraft_id: source.id, registration: source.registration, name: source.name,
      full_name: source.full_name, home_airport: source.home_airport,
      leg_count: srcLegs.length, has_maintenance: !!srcMaint,
    },
    source_legs: srcLegs.map(l => ({
      day_of_week: l.day_of_week, departure_time: l.departure_time, arrival_time: l.arrival_time,
      flight_number: l.flight_number, departure_airport: l.departure_airport,
      arrival_airport: l.arrival_airport, is_transfer: l.is_transfer,
      dep_longitude: l.dep_longitude, arr_longitude: l.arr_longitude,
    })),
    source_maintenance: srcMaint
      ? { ...srcMaint, start_time: toHHMM(srcMaint.start_minutes) }
      : null,
    targets: results,
  };
}

// ── POST /api/aircraft-groups/copy-plan ──────────────────────────────────────
// Preview only — nothing is written. Every target comes back with its shifted
// week, its warnings and, when it cannot take the schedule, its own error.
router.post('/copy-plan', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const built = await buildCopy(airlineId, req.body);
    if (built.error) return res.status(400).json({ error: built.error });

    res.json(built);
  } catch (error) {
    console.error('Group copy plan error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/aircraft-groups/copy-commit ────────────────────────────────────
// Writes the copy. The plan is rebuilt from the database rather than taken from
// the client, so what is written is what the preview computed — the request only
// says which aircraft and by how much.
router.post('/copy-commit', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const built = await buildCopy(airlineId, req.body);
    if (built.error) return res.status(400).json({ error: built.error });

    const writable = built.targets.filter(t => !t.error);
    const blocked = built.targets.filter(t => t.error);
    if (writable.length === 0) {
      return res.status(400).json({ error: `No aircraft can take this schedule: ${blocked.map(b => `${b.registration} — ${b.error}`).join('; ')}` });
    }
    // Refuse a partial write the player did not ask for: they saw the blocked rows
    // in the preview and have to drop them before the copy runs.
    if (blocked.length > 0) {
      return res.status(400).json({
        error: `${blocked.length} selected aircraft cannot take this schedule — remove them and retry: `
          + blocked.map(b => `${b.registration} (${b.error})`).join('; '),
      });
    }

    const now = new Date();
    const jsDay = now.getDay();
    const currentDow = jsDay === 0 ? 6 : jsDay - 1;
    const currentWeekMin = currentDow * DAY + now.getHours() * 60 + now.getMinutes();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of writable) {
        // Same order the group commit uses: ground the aircraft to unlock the
        // schedule tables (which also cancels the flights generated from the old
        // plan), release the flight rows still pointing at the templates, then
        // replace the week.
        await deactivateAircraft(t.aircraft_id, client);
        await client.query('UPDATE flights SET weekly_schedule_id = NULL WHERE aircraft_id = $1', [t.aircraft_id]);
        await client.query('DELETE FROM weekly_schedule WHERE aircraft_id = $1', [t.aircraft_id]);
        await client.query('DELETE FROM maintenance_schedule WHERE aircraft_id = $1 AND airline_id = $2', [t.aircraft_id, airlineId]);

        if (t.legs.length) {
          const values = [];
          const placeholders = [];
          let idx = 1;
          for (const l of t.legs) {
            placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
            values.push(t.aircraft_id, l.day_of_week, l.flight_number, l.departure_airport, l.arrival_airport,
              l.departure_time, l.arrival_time,
              l.is_transfer ? null : l.economy_price,
              l.is_transfer ? null : l.business_price,
              l.is_transfer ? null : l.first_price,
              l.is_transfer ? null : l.route_id,
              l.is_transfer ? null : l.service_profile_id,
              l.distance_km || null,
              l.is_transfer ? 1 : 0);
          }
          await client.query(`
            INSERT INTO weekly_schedule
              (aircraft_id, day_of_week, flight_number, departure_airport, arrival_airport,
               departure_time, arrival_time, economy_price, business_price, first_price,
               route_id, service_profile_id, distance_km, is_transfer)
            VALUES ${placeholders.join(', ')}
          `, values);
        }

        if (t.rename) {
          await client.query('UPDATE aircraft SET name = $1 WHERE id = $2 AND airline_id = $3',
            [t.name, t.aircraft_id, airlineId]);
        }

        if (t.maintenance) {
          // Mirror maintenance.js: a slot that already passed this week is marked
          // completed so the processor bills it next week instead of instantly.
          const trigger = t.maintenance.day_of_week * DAY + t.maintenance.start_minutes;
          await client.query(`
            INSERT INTO maintenance_schedule
              (aircraft_id, airline_id, day_of_week, start_minutes, duration_minutes, type, status, last_completed_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7)
          `, [t.aircraft_id, airlineId, t.maintenance.day_of_week, t.maintenance.start_minutes,
              t.maintenance.duration_minutes, t.maintenance.type,
              currentWeekMin >= trigger ? now.toISOString() : null]);
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // By default the previous operating state is restored: an aircraft that was
    // parked stays parked with its new schedule written, because copying must
    // never put one into the air behind the player's back. `activate` is that
    // decision made explicitly, and then every aircraft in the copy goes into
    // service. The write is already committed either way, so an aircraft that
    // cannot be activated (no crew, no cabin profile, expansion capacity) is
    // reported rather than rolled back — the player fixes the cause and flips it
    // themselves.
    const activateAll = req.body.activate === true;
    const activation = [];
    for (const t of writable) {
      if (!activateAll && !t.was_active) {
        activation.push({ aircraft_id: t.aircraft_id, registration: t.registration, activated: false, left_grounded: true, error: null });
        continue;
      }
      const result = await activateAircraft(airlineId, t.aircraft_id);
      activation.push({
        aircraft_id: t.aircraft_id, registration: t.registration,
        activated: result.ok, left_grounded: false,
        error: result.ok ? null : (result.message || result.error),
      });
    }

    const legCount = writable.reduce((s, t) => s + t.legs.length, 0);
    const grounded = activation.filter(a => a.left_grounded);
    const failed = activation.filter(a => !a.activated && !a.left_grounded);
    const notes = [];
    if (failed.length) notes.push(`${failed.length} could not be reactivated`);
    if (grounded.length) notes.push(`${grounded.length} left grounded (were not operating before)`);
    res.status(201).json({
      message: `Schedule copied from ${built.source.registration}: ${writable.length} aircraft, ${legCount} flights`
        + (notes.length ? ` — ${notes.join(', ')}` : ''),
      aircraft_count: writable.length,
      leg_count: legCount,
      activation,
    });
  } catch (error) {
    console.error('Group copy commit error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
