-- ─────────────────────────────────────────────────────────────────────────────
-- Market Price Rebalance: Step → Linear Interpolation
-- ─────────────────────────────────────────────────────────────────────────────
-- Adjusts existing route / weekly_schedule / flight prices proportionally so
-- the actual/market ratio stays the same after the formula change.
--
-- Run in Supabase SQL Editor in this order:
--   1. STEP 1 (helper function)         — always
--   2. STEP 2 (preview SELECT)          — inspect the planned changes
--   3. STEP 3 (BEGIN ... UPDATEs)       — wrapped in a transaction
--   4. STEP 4 (verification SELECT)     — inside the open transaction
--   5. COMMIT;  (or ROLLBACK; to abort)
--
-- IMPORTANT: NOT idempotent. Run exactly once per database.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── STEP 1 — Helper function (session-temp; auto-dropped on session end) ─────

CREATE OR REPLACE FUNCTION pg_temp.price_migration_ratio(d REAL)
RETURNS TABLE(eco_ratio REAL, biz_ratio REAL, first_ratio REAL) AS $$
DECLARE
  old_base  REAL; new_base  REAL;
  old_biz   REAL; new_biz   REAL;
  old_first REAL; new_first REAL;
BEGIN
  -- Old base rate (step function — pre-change)
  old_base := CASE WHEN d <= 500  THEN 0.22
                   WHEN d <= 1500 THEN 0.15
                   WHEN d <= 3000 THEN 0.10
                   WHEN d <= 6000 THEN 0.065
                   ELSE 0.055 END;

  -- New base rate (linear interpolation between anchors)
  new_base := CASE WHEN d <= 500   THEN 0.22
                   WHEN d <= 1500  THEN 0.22  + (d - 500)   / 1000.0 * (0.13  - 0.22)
                   WHEN d <= 3000  THEN 0.13  + (d - 1500)  / 1500.0 * (0.085 - 0.13)
                   WHEN d <= 6000  THEN 0.085 + (d - 3000)  / 3000.0 * (0.068 - 0.085)
                   WHEN d <= 10000 THEN 0.068 + (d - 6000)  / 4000.0 * (0.060 - 0.068)
                   WHEN d <= 15000 THEN 0.060 + (d - 10000) / 5000.0 * (0.050 - 0.060)
                   ELSE 0.050 END;

  -- Old / new business multipliers
  old_biz := CASE WHEN d < 1000 THEN 2.5 WHEN d < 3000 THEN 3.0 ELSE 4.0 END;
  new_biz := CASE WHEN d <= 1000 THEN 2.5
                  WHEN d <= 3000 THEN 2.5 + (d - 1000) / 2000.0 * (3.0 - 2.5)
                  WHEN d <= 6000 THEN 3.0 + (d - 3000) / 3000.0 * (4.0 - 3.0)
                  ELSE 4.0 END;

  -- Old / new first multipliers
  old_first := CASE WHEN d < 1000 THEN 5.0 WHEN d < 3000 THEN 7.0 ELSE 10.0 END;
  new_first := CASE WHEN d <= 1000 THEN 5.0
                    WHEN d <= 3000 THEN 5.0 + (d - 1000) / 2000.0 * (7.0  - 5.0)
                    WHEN d <= 6000 THEN 7.0 + (d - 3000) / 3000.0 * (10.0 - 7.0)
                    ELSE 10.0 END;

  eco_ratio   := new_base / old_base;
  biz_ratio   := eco_ratio * (new_biz   / old_biz);
  first_ratio := eco_ratio * (new_first / old_first);
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ── STEP 2 — Preview: inspect planned route changes (no DB writes) ───────────

SELECT
  r.id,
  r.flight_number,
  r.distance_km,
  r.economy_price        AS eco_old,
  ROUND((r.economy_price  * pr.eco_ratio)::numeric,   2) AS eco_new,
  r.business_price       AS biz_old,
  ROUND((r.business_price * pr.biz_ratio)::numeric,   2) AS biz_new,
  r.first_price          AS first_old,
  ROUND((r.first_price    * pr.first_ratio)::numeric, 2) AS first_new,
  ROUND(pr.eco_ratio::numeric,   4) AS eco_ratio,
  ROUND(pr.biz_ratio::numeric,   4) AS biz_ratio,
  ROUND(pr.first_ratio::numeric, 4) AS first_ratio
FROM routes r
CROSS JOIN LATERAL pg_temp.price_migration_ratio(r.distance_km::real) pr
ORDER BY r.distance_km;


-- ── STEP 3 — Apply (transactional). Verify in STEP 4 before committing. ──────

BEGIN;

WITH route_ratios AS (
  SELECT r.id, pr.eco_ratio, pr.biz_ratio, pr.first_ratio
  FROM routes r
  CROSS JOIN LATERAL pg_temp.price_migration_ratio(r.distance_km::real) pr
)
UPDATE routes
SET economy_price  = economy_price  * rr.eco_ratio,
    business_price = business_price * rr.biz_ratio,
    first_price    = first_price    * rr.first_ratio
FROM route_ratios rr
WHERE routes.id = rr.id;

WITH ws_ratios AS (
  SELECT ws.id, pr.eco_ratio, pr.biz_ratio, pr.first_ratio
  FROM weekly_schedule ws
  JOIN routes r ON r.id = ws.route_id
  CROSS JOIN LATERAL pg_temp.price_migration_ratio(r.distance_km::real) pr
)
UPDATE weekly_schedule
SET economy_price  = economy_price  * wr.eco_ratio,
    business_price = business_price * wr.biz_ratio,
    first_price    = first_price    * wr.first_ratio
FROM ws_ratios wr
WHERE weekly_schedule.id = wr.id;

-- Only unbooked, not-yet-departed flights. Booked passengers paid the old price.
WITH flight_ratios AS (
  SELECT f.id, pr.eco_ratio, pr.biz_ratio, pr.first_ratio
  FROM flights f
  JOIN weekly_schedule ws ON ws.id = f.weekly_schedule_id
  JOIN routes r           ON r.id  = ws.route_id
  CROSS JOIN LATERAL pg_temp.price_migration_ratio(r.distance_km::real) pr
  WHERE f.status IN ('scheduled', 'boarding')
    AND COALESCE(f.booked_economy,  0) = 0
    AND COALESCE(f.booked_business, 0) = 0
    AND COALESCE(f.booked_first,    0) = 0
)
UPDATE flights
SET economy_price  = economy_price  * fr.eco_ratio,
    business_price = business_price * fr.biz_ratio,
    first_price    = first_price    * fr.first_ratio
FROM flight_ratios fr
WHERE flights.id = fr.id;


-- ── STEP 4 — Verification (still inside the open transaction) ────────────────

SELECT 'routes'           AS tbl, COUNT(*) AS rows_total FROM routes
UNION ALL
SELECT 'weekly_schedule',         COUNT(*) FROM weekly_schedule
UNION ALL
SELECT 'flights_unbooked_sched',  COUNT(*) FROM flights
  WHERE status IN ('scheduled', 'boarding')
    AND COALESCE(booked_economy,  0) = 0
    AND COALESCE(booked_business, 0) = 0
    AND COALESCE(booked_first,    0) = 0;

-- If the numbers look right:
--   COMMIT;
-- Otherwise:
--   ROLLBACK;
