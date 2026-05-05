-- ─────────────────────────────────────────────────────────────────────────────
-- Cleanup: G-DSUS duplicate scheduled flights after schedule clear+replace
-- ─────────────────────────────────────────────────────────────────────────────
-- Context: a bug let generateFlights() create new flight instances that
-- overlapped with old orphaned ones (weekly_schedule_id = NULL) after the
-- user cleared and re-entered the schedule. The fix in flights.js prevents
-- this going forward, but the existing duplicates need to be cleaned up.
--
-- Strategy: keep the originally-booked old flights (orphans, NULL template),
-- delete only the newer overlapping ones (non-NULL template). Restricted to
-- G-DSUS and to flights still in pre-departure status (scheduled/boarding).
--
-- Run in Supabase SQL Editor:
--   1. STEP 1 (preview SELECT)        — inspect what will be deleted
--   2. STEP 2 (BEGIN ... DELETE)      — wrapped in a transaction
--   3. STEP 3 (verification SELECT)   — inside the open transaction
--   4. COMMIT;  (or ROLLBACK; to abort)
--
-- IMPORTANT: NOT idempotent. Run exactly once.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── STEP 1 — Preview the duplicate set ───────────────────────────────────────
-- Returns the newer flights (non-NULL weekly_schedule_id) that overlap an
-- older orphan flight (NULL weekly_schedule_id) on G-DSUS. These are the
-- rows STEP 2 will delete.

SELECT new_f.id          AS delete_id,
       new_f.flight_number,
       new_f.departure_time AS new_dep,
       new_f.arrival_time   AS new_arr,
       new_f.status         AS new_status,
       new_f.booked_economy + new_f.booked_business + new_f.booked_first AS new_booked,
       old_f.id             AS keep_id,
       old_f.departure_time AS old_dep,
       old_f.arrival_time   AS old_arr,
       old_f.booked_economy + old_f.booked_business + old_f.booked_first AS old_booked
FROM flights new_f
JOIN aircraft a       ON new_f.aircraft_id = a.id
JOIN flights  old_f   ON old_f.aircraft_id = new_f.aircraft_id
                      AND old_f.id         <> new_f.id
                      AND old_f.weekly_schedule_id IS NULL
                      AND old_f.status IN ('scheduled', 'boarding', 'in_flight')
                      AND old_f.departure_time < new_f.arrival_time
                      AND old_f.arrival_time   > new_f.departure_time
WHERE a.registration = 'G-DSUS'
  AND new_f.weekly_schedule_id IS NOT NULL
  AND new_f.status IN ('scheduled', 'boarding')
ORDER BY new_f.departure_time;


-- ── STEP 2 — Delete the duplicates (transactional) ───────────────────────────

BEGIN;

DELETE FROM flights
WHERE id IN (
  SELECT new_f.id
  FROM flights new_f
  JOIN aircraft a     ON new_f.aircraft_id = a.id
  JOIN flights  old_f ON old_f.aircraft_id = new_f.aircraft_id
                      AND old_f.id         <> new_f.id
                      AND old_f.weekly_schedule_id IS NULL
                      AND old_f.status IN ('scheduled', 'boarding', 'in_flight')
                      AND old_f.departure_time < new_f.arrival_time
                      AND old_f.arrival_time   > new_f.departure_time
  WHERE a.registration = 'G-DSUS'
    AND new_f.weekly_schedule_id IS NOT NULL
    AND new_f.status IN ('scheduled', 'boarding')
);


-- ── STEP 3 — Verify (still inside the transaction) ───────────────────────────
-- Should return zero rows: no remaining overlapping pairs on G-DSUS.

SELECT new_f.id, new_f.departure_time, old_f.id AS overlaps_with, old_f.departure_time
FROM flights new_f
JOIN aircraft a     ON new_f.aircraft_id = a.id
JOIN flights  old_f ON old_f.aircraft_id = new_f.aircraft_id
                    AND old_f.id         <> new_f.id
                    AND old_f.status IN ('scheduled', 'boarding', 'in_flight')
                    AND old_f.departure_time < new_f.arrival_time
                    AND old_f.arrival_time   > new_f.departure_time
WHERE a.registration = 'G-DSUS'
  AND new_f.status IN ('scheduled', 'boarding');

-- COMMIT;  -- run this once the verification looks right
-- ROLLBACK;  -- or this to abort
