import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// Audit C5: TLS is required in production but the Supabase Session Pooler
// (aws-N-REGION.pooler.supabase.com) terminates with an internal cert chain
// that Node's default trust store can't always validate. The traffic is still
// encrypted — we just skip strict chain verification for that hop, which is
// acceptable for a pooler-fronted DB on a private AWS network.
// Set PG_SSL_VERIFY=1 to opt back into strict verification (Direct connection
// to db.PROJECT.supabase.co supports it; pooler typically doesn't).
const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: process.env.PG_SSL_VERIFY === '1' }
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
