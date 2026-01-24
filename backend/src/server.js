import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase } from './database/db.js';
import authRoutes from './routes/auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use('/api/auth', authRoutes);

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
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

export default app;