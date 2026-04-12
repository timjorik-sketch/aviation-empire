import express from 'express';
import pool from '../database/postgres.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// GET /api/leaderboards — all leaderboard categories
router.get('/', authMiddleware, async (req, res) => {
  try {
    const airlineId = req.airlineId;

    // 1) Passengers — total seats_sold from completed flights
    const passengersRes = await pool.query(`
      SELECT a.id AS airline_id, a.name, a.airline_code, a.home_airport_code,
             COALESCE(SUM(f.seats_sold), 0)::INTEGER AS total_passengers
      FROM airlines a
      LEFT JOIN flights f ON f.airline_id = a.id AND f.status = 'completed'
      GROUP BY a.id, a.name, a.airline_code, a.home_airport_code
      ORDER BY total_passengers DESC
    `);

    // 2) Destinations — count of airline_destinations
    const destinationsRes = await pool.query(`
      SELECT a.id AS airline_id, a.name, a.airline_code, a.home_airport_code,
             COUNT(ad.id)::INTEGER AS destination_count
      FROM airlines a
      LEFT JOIN airline_destinations ad ON ad.airline_id = a.id
      GROUP BY a.id, a.name, a.airline_code, a.home_airport_code
      ORDER BY destination_count DESC
    `);

    // 3) Fleet size — count of aircraft
    const fleetRes = await pool.query(`
      SELECT a.id AS airline_id, a.name, a.airline_code, a.home_airport_code,
             COUNT(ac.id)::INTEGER AS fleet_size
      FROM airlines a
      LEFT JOIN aircraft ac ON ac.airline_id = a.id
      GROUP BY a.id, a.name, a.airline_code, a.home_airport_code
      ORDER BY fleet_size DESC
    `);

    // 4) Weekly flights — count of weekly_schedule entries
    const weeklyFlightsRes = await pool.query(`
      SELECT a.id AS airline_id, a.name, a.airline_code, a.home_airport_code,
             COUNT(ws.id)::INTEGER AS weekly_flights
      FROM airlines a
      LEFT JOIN aircraft ac ON ac.airline_id = a.id
      LEFT JOIN weekly_schedule ws ON ws.aircraft_id = ac.id
      GROUP BY a.id, a.name, a.airline_code, a.home_airport_code
      ORDER BY weekly_flights DESC
    `);

    res.json({
      passengers: passengersRes.rows,
      destinations: destinationsRes.rows,
      fleet: fleetRes.rows,
      weekly_flights: weeklyFlightsRes.rows,
      my_airline_id: airlineId,
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
