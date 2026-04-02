import express from 'express';
import { getDatabase, saveDatabase } from '../database/db.js';
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
router.post('/', authMiddleware, (req, res) => {
  try {
    const { aircraft_id, day_of_week, start_time, type } = req.body;
    const db = getDatabase();

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

    const acStmt = db.prepare(`
      SELECT a.id, t.max_passengers, a.is_active, t.wake_turbulence_category, a.condition FROM aircraft a
      JOIN aircraft_types t ON a.aircraft_type_id = t.id
      WHERE a.id = ? AND a.airline_id = ?
    `);
    acStmt.bind([aircraft_id, airlineId]);
    if (!acStmt.step()) { acStmt.free(); return res.status(404).json({ error: 'Aircraft not found' }); }
    const acMaintRow = acStmt.get();
    const maxSeats = acMaintRow[1];
    const isOpForMaint = acMaintRow[2];
    const wakeCategory = acMaintRow[3] || 'M';
    const condition = acMaintRow[4] ?? 100;
    acStmt.free();

    const baseCost = MAINT_BASE_COST[wakeCategory] ?? MAINT_BASE_COST.M;
    const estimatedCost = Math.round(baseCost * (2 - condition / 100));

    if (isOpForMaint) {
      return res.status(400).json({ error: 'Aircraft must be inactive to edit schedule. Deactivate the aircraft first.' });
    }

    const durationMin = getMaintenanceDuration(maxSeats);
    const endMinutes = startMinutes + durationMin;

    // Check overlap with weekly_schedule on same day
    const schedStmt = db.prepare(`
      SELECT departure_time, arrival_time FROM weekly_schedule
      WHERE aircraft_id = ? AND day_of_week = ?
    `);
    schedStmt.bind([aircraft_id, dow]);
    while (schedStmt.step()) {
      const row = schedStmt.get();
      const [fDepH, fDepM] = row[0].split(':').map(Number);
      const [fArrH, fArrM] = row[1].split(':').map(Number);
      const fDepMin = fDepH * 60 + fDepM;
      const fArrMin = fArrH * 60 + fArrM;
      if (startMinutes < fArrMin && fDepMin < endMinutes) {
        schedStmt.free();
        return res.status(400).json({ error: 'Maintenance overlaps with a scheduled flight' });
      }
    }
    schedStmt.free();

    // Check overlap with existing maintenance on same day
    const maintStmt = db.prepare(`
      SELECT start_minutes, duration_minutes FROM maintenance_schedule
      WHERE aircraft_id = ? AND airline_id = ? AND day_of_week = ?
    `);
    maintStmt.bind([aircraft_id, airlineId, dow]);
    while (maintStmt.step()) {
      const row = maintStmt.get();
      const mStart = row[0], mEnd = row[0] + row[1];
      if (startMinutes < mEnd && mStart < endMinutes) {
        maintStmt.free();
        return res.status(400).json({ error: 'Maintenance overlaps with existing maintenance' });
      }
    }
    maintStmt.free();

    // Build HH:MM strings for storage
    const endH = Math.floor(endMinutes % 1440 / 60);
    const endMM = endMinutes % 60;
    const endTimeStr = `${String(endH).padStart(2, '0')}:${String(endMM).padStart(2, '0')}`;

    const insertStmt = db.prepare(`
      INSERT INTO maintenance_schedule
        (aircraft_id, airline_id, start_time, end_time, day_of_week, start_minutes, duration_minutes, type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
    `);
    insertStmt.bind([aircraft_id, airlineId, start_time, endTimeStr, dow, startMinutes, durationMin, type || 'routine']);
    insertStmt.step();
    insertStmt.free();

    const idStmt = db.prepare('SELECT last_insert_rowid()');
    idStmt.step();
    const maintId = idStmt.get()[0];
    idStmt.free();

    saveDatabase();

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
router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const maintId = parseInt(req.params.id);
    const db = getDatabase();

    // Get airline ID
    const airlineId = req.airlineId;
    if (!airlineId) return res.status(400).json({ error: 'No active airline' });

    // Verify ownership
    const maintStmt = db.prepare('SELECT id FROM maintenance_schedule WHERE id = ? AND airline_id = ?');
    maintStmt.bind([maintId, airlineId]);
    if (!maintStmt.step()) {
      maintStmt.free();
      return res.status(404).json({ error: 'Maintenance entry not found' });
    }
    maintStmt.free();

    const deleteStmt = db.prepare('DELETE FROM maintenance_schedule WHERE id = ?');
    deleteStmt.bind([maintId]);
    deleteStmt.step();
    deleteStmt.free();

    saveDatabase();

    res.json({ message: 'Maintenance cancelled successfully' });
  } catch (error) {
    console.error('Delete maintenance error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
