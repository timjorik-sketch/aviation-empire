import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './database/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import authRoutes from './routes/auth.js';
import airlineRoutes from './routes/airline.js';
import aircraftRoutes, { startMarketRefreshScheduler } from './routes/aircraft.js';
import routesRoutes from './routes/routes.js';
import flightsRoutes, { startFlightProcessor } from './routes/flights.js';
import financesRoutes from './routes/finances.js';
import serviceProfilesRoutes from './routes/serviceProfiles.js';
import maintenanceRoutes from './routes/maintenance.js';
import airportsRoutes from './routes/airports.js';
import cabinProfilesRoutes from './routes/cabinProfiles.js';
import destinationsRoutes from './routes/destinations.js';
import personnelRoutes, { startPayrollProcessor } from './routes/personnel.js';
import expansionsRoutes from './routes/expansions.js';
import marketAnalysesRouter, { startMarketAnalysesProcessor } from './routes/marketAnalyses.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api/auth', authRoutes);
app.use('/api/airline', airlineRoutes);
app.use('/api/aircraft', aircraftRoutes);
app.use('/api/routes', routesRoutes);
app.use('/api/flights', flightsRoutes);
app.use('/api/finances', financesRoutes);
app.use('/api/service-profiles', serviceProfilesRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/airports', airportsRoutes);
app.use('/api/cabin-profiles', cabinProfilesRoutes);
app.use('/api/destinations', destinationsRoutes);
app.use('/api/personnel', personnelRoutes);
app.use('/api/expansions', expansionsRoutes);
app.use('/api/market-analyses', marketAnalysesRouter);

// Alias routes for convenience
app.use('/api/fleet', aircraftRoutes);
app.use('/api/aircraft-market', aircraftRoutes);

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Aviation Empire Backend is running!',
    timestamp: new Date().toISOString() 
  });
});

app.get('/', (req, res) => {
  res.json({ 
    message: '✈️ Welcome to Aviation Empire API!',
    version: '1.0.0'
  });
});

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Aviation Empire Backend running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    console.log(`🔗 API: http://localhost:${PORT}`);

    // Start flight processor for auto-completing flights
    startFlightProcessor();
    console.log('✈️ Flight processor started');

    // Start used aircraft market refresh scheduler
    startMarketRefreshScheduler();
    console.log('🛒 Used aircraft market scheduler started');

    // Start weekly payroll processor
    startPayrollProcessor();
    console.log('💰 Payroll processor started');

    // Start market analyses processor
    startMarketAnalysesProcessor();
    console.log('📊 Market analyses processor started');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));

export default app;