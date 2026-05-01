import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// Audit C5: previously rejectUnauthorized was false in production, which
// silently accepted any cert presented by the DB and defeated SSL's MITM
// protection. Supabase serves a CA-signed cert, so verification works without
// extra config. If you ever need to connect to a self-signed endpoint, set
// PG_SSL_NO_VERIFY=1 in the environment for that deploy only.
const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: process.env.PG_SSL_NO_VERIFY !== '1' }
  : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

export async function query(text, params) {
  return pool.query(text, params);
}

export default pool;
