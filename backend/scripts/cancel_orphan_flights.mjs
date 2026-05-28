// One-off cleanup for orphan future flights left behind by the pre-fix schedule-edit path.
// An "orphan" here = a flight in status 'scheduled' or 'boarding' with weekly_schedule_id IS NULL
// (i.e. the template row that produced it was deleted, but the flight wasn't cancelled).
//
// Usage:
//   node backend/scripts/cancel_orphan_flights.mjs G-MHPS              # dry-run, lists matches
//   node backend/scripts/cancel_orphan_flights.mjs G-MHPS --apply      # actually cancel
//   node backend/scripts/cancel_orphan_flights.mjs --all                # dry-run, every aircraft
//   node backend/scripts/cancel_orphan_flights.mjs --all --apply        # cancel everywhere

import pool from '../src/database/postgres.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const all   = args.includes('--all');
const reg   = args.find(a => !a.startsWith('--')) || null;

if (!all && !reg) {
  console.error('Specify an aircraft registration (e.g. G-MHPS) or pass --all.');
  process.exit(1);
}

try {
  const params = [];
  let whereAircraft = '';
  if (!all) {
    params.push(reg);
    whereAircraft = `AND a.registration = $${params.length}`;
  }

  const listResult = await pool.query(`
    SELECT f.id, f.flight_number, f.status,
           r.departure_airport, r.arrival_airport,
           f.departure_time, f.arrival_time,
           a.registration
    FROM flights f
    JOIN aircraft a ON a.id = f.aircraft_id
    LEFT JOIN routes r ON r.id = f.route_id
    WHERE f.status IN ('scheduled', 'boarding')
      AND f.weekly_schedule_id IS NULL
      AND f.departure_time > NOW()
      ${whereAircraft}
    ORDER BY a.registration, f.departure_time
  `, params);

  if (listResult.rows.length === 0) {
    console.log('No orphan future flights found.');
    process.exit(0);
  }

  console.log(`Found ${listResult.rows.length} orphan future flight(s):`);
  for (const r of listResult.rows) {
    console.log(`  [${r.id}] ${r.registration}  ${r.flight_number}  ${r.departure_airport}→${r.arrival_airport}  ${new Date(r.departure_time).toISOString()}  (${r.status})`);
  }

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to cancel these flights.');
    process.exit(0);
  }

  const ids = listResult.rows.map(r => r.id);
  const updateResult = await pool.query(
    `UPDATE flights SET status = 'cancelled' WHERE id = ANY($1::int[])`,
    [ids]
  );
  console.log(`\nCancelled ${updateResult.rowCount} flight(s).`);
} catch (err) {
  console.error('Cleanup failed:', err);
  process.exit(1);
} finally {
  await pool.end();
}