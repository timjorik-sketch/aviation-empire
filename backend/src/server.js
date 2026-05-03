import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
import leaderboardsRoutes from './routes/leaderboards.js';
import adminRoutes from './routes/admin.js';
import interestRoutes from './routes/interest.js';
import { globalLimiter, authLimiter, interestLimiter } from './middleware/rateLimiters.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's reverse proxy so req.ip reflects the real client IP.
// Railway's ingress sits behind multiple hops (edge LB + container router),
// so trust proxy: 1 only sees the innermost hop and req.ip drifts per
// request — which neutralises rate limiting. Use 'true' to walk the full
// X-Forwarded-For chain and pick the leftmost entry (real client). Spoofing
// would require bypassing Railway's edge, which isn't reachable directly.
app.set('trust proxy', true);

// Don't advertise the framework — small win, removes one fingerprinting hint.
app.disable('x-powered-by');

// Set baseline secure HTTP headers (HSTS, X-Content-Type-Options, frame deny, etc.)
app.use(helmet());

// CORS allowlist (security audit C4): origin: true reflected any browser-supplied
// Origin, which combined with credentials: true is unsafe. Lock down to known
// frontends. ADDITIONAL_CORS_ORIGINS (comma-separated) lets ops add custom
// domains via env without a code change.
// Static allowlist. Add any production frontend domain here. Preview/feature
// branches on Vercel get unique subdomains — use ADDITIONAL_CORS_ORIGINS env
// var (comma-separated) to allow them per-environment without a code change.
const allowedOrigins = [
  'https://apronempire.com',
  'https://www.apronempire.com',
  'https://aviation-empire.vercel.app',
  'https://apron-empire.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
];
if (process.env.ADDITIONAL_CORS_ORIGINS) {
  allowedOrigins.push(...process.env.ADDITIONAL_CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean));
}
app.use(cors({
  origin: (origin, callback) => {
    // Same-origin browser requests, curl, and server-to-server calls have no
    // Origin header — allow these through.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  credentials: true
}));

// Body size limit (audit H3): default 100kb is fine but we set it explicitly
// and tighter to reduce memory pressure from oversized payloads.
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting (audit C3, H6). Order matters: tighter limiters first so they
// take precedence on overlapping paths, then the generic global ceiling on
// everything under /api.
app.use('/api/auth', authLimiter);
app.use('/api/interest', interestLimiter);
app.use('/api', globalLimiter);

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
app.use('/api/leaderboards', leaderboardsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/interest', interestRoutes);

// Alias routes for convenience
app.use('/api/fleet', aircraftRoutes);
app.use('/api/aircraft-market', aircraftRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Apron Empire backend is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Apron Empire API',
    version: '1.0.0'
  });
});

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler (audit M4): always log full detail server-side, but
// don't echo internals to clients in production.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  // CORS rejections are user-facing config errors, not 500s.
  if (err && err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const isDev = process.env.NODE_ENV !== 'production';
  res.status(err.status || 500).json({
    error: isDev ? (err.message || 'Server error') : 'Server error'
  });
});

// Bind to PORT immediately so Railway health checks pass
app.listen(PORT, () => {
  console.log(`Apron Empire backend listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);

  // Init DB in background — don't block startup
  initDatabase().then(() => {
    startFlightProcessor();
    startMarketRefreshScheduler();
    startPayrollProcessor();
    startMarketAnalysesProcessor();
  }).catch(err => {
    console.error('DB init failed (server still running):', err);
  });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));

export default app;