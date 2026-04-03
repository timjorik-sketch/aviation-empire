import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Calculate maintenance duration based on aircraft seat count
function getMaintenanceDuration(seats) {
  if (seats <= 100) return 90;   // 90 minutes
  if (seats <= 250) return 150;  // 150 minutes
  return 240;                     // 240 minutes
}

const MAINT_BASE_COST = { L: 2000, M: 8000, H: 15000 };

// POST / - Schedule maintenance (weekly template: day_of_week + start_time HH:MM)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { aircraft_id, day_of_week, start_time, type } = req.body;

    if (!aircraft_id || day_of_week === undefined || !start_time) {
      return res.status(400).json({ error: 'aircraft_id, day_of_week (0=Mon..6=Sun) and start_time (HH:MM) are required' });
    }

    const dow = parseInt(day_of_week);
    if (dow < 0 || dow > 6) return res.status(400).json({ error: 'day_of_week must be 0–6' });

    const [startH, startM] = start_time.split(':').map(Number);
    if (isNaN(startH) || isNaN(startM)) return res.status(400).json({ error: 'start_time must be HH:MM' });
    const startMinutes = startH * 60 + startM;

    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    const acResult = await pool.query(`
      SELECT a.id, t.max_passengers, a.is_active, t.wake_turbulence_category, a.condition FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.id = $1 AND a.airline_id = $2
    `, [aircraft_id, airlineId]);

    if (!acResult.rows[0]) return res.status(404).json({ error: 'Aircraft not found' });
    const acRow = acResult.rows[0];
    const maxSeats = acRow.max_passengers;
    const isOpForMaint = acRow.is_active;
    const wakeCategory = acRow.wake_turbulence_category || 'M';
    const condition = acRow.condition ?? 100;

    const baseCost = MAINT_BASE_COST[wakeCategory] ?? MAINT_BASE_COST.M;
    const estimatedCost = Math.round(baseCost * (2 - condition / 100));

    if (isOpForMaint) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    const durationMin = getMaintenanceDuration(maxSeats);
    const endMinutes = startMinutes + durationMin;

    // Check overlap with weekly_schedule on same day
    const schedResult = await pool.query(`
      SELECT departure_time, arrival_time FROM weekly_schedule
      WHERE aircraft_id = $1 AND day_of_week = $2
    `, [aircraft_id, dow]);

    for (const row of schedResult.rows) {
      const [fDepH, fDepM] = row.departure_time.split(':').map(Number);
      const [fArrH, fArrM] = row.arrival_time.split(':').map(Number);
      const fDepMin = fDepH * 60 + fDepM;
      const fArrMin = fArrH * 60 + fArrM;
      if (startMinutes < fArrMin && fDepMin < endMinutes) {
        return res.status(400).json({ error: 'Maintenance overlaps with a scheduled flight' });
      }
    }

    // Check overlap with existing maintenance on same day
    const maintResult = await pool.query(`
      SELECT start_minutes, duration_minutes FROM maintenance_schedule
      WHERE aircraft_id = $1 AND airline_id = $2 AND day_of_week = $3
    `, [aircraft_id, airlineId, dow]);

    for (const row of maintResult.rows) {
      const mStart = row.start_minutes;
      const mEnd = row.start_minutes + row.duration_minutes;
      if (startMinutes < mEnd && mStart < endMinutes) {
        return res.status(400).json({ error: 'Maintenance overlaps with existing maintenance' });
      }
    }

    // Build HH:MM strings for storage
    const endH = Math.floor(endMinutes % 1440 / 60);
    const endMM = endMinutes % 60;
    const endTimeStr = `${String(endH).padStart(2, '0')}:${String(endMM).padStart(2, '0')}`;

    const insertResult = await pool.query(`
      INSERT INTO maintenance_schedule
        (aircraft_id, airline_id, day_of_week, start_minutes, duration_minutes, type, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
      RETURNING id
    `, [aircraft_id, airlineId, dow, startMinutes, durationMin, type || 'routine']);

    const maintId = insertResult.rows[0].id;

    res.status(201).json({
      message: 'Maintenance scheduled successfully',
      maintenance: {
        id: maintId, aircraft_id, day_of_week: dow,
        start_time, end_time: endTimeStr,
        start_minutes: startMinutes, duration_minutes: durationMin,
        type: type || 'routine', status: 'scheduled',
        estimated_cost: estimatedCost,
        base_cost: baseCost
      }
    });
  } catch (error) {
    console.error('Schedule maintenance error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - Cancel maintenance
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const maintId = parseInt(req.params.id);
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Verify ownership
    const maintResult = await pool.query(
      'SELECT id FROM maintenance_schedule WHERE id = $1 AND airline_id = $2',
      [maintId, airlineId]
    );
    if (!maintResult.rows[0]) {
      return res.status(404).json({ error: 'Maintenance entry not found' });
    }

    await pool.query('DELETE FROM maintenance_schedule WHERE id = $1', [maintId]);

    res.json({ message: 'Maintenance cancelled successfully' });
  } catch (error) {
    console.error('Delete maintenance error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
