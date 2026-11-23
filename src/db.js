import './env.js';
// Supabase Postgres connection (session pooler, port 5432).
// Message content is never stored; see db/schema.sql.
import postgres from 'postgres';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');

export const sql = postgres(process.env.DATABASE_URL, {
  ssl: 'require',
  prepare: false,
  max: Number(process.env.DB_POOL ?? 4),
  idle_timeout: 60,
  onnotice: () => {},
});
