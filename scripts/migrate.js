// Apply db/schema.sql (idempotent). Usage: pnpm migrate
import '../src/env.js';
import { readFileSync } from 'node:fs';
import { sql } from '../src/db.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
await sql.unsafe(schema);
const tables = await sql`select table_name from information_schema.tables where table_schema = 'frostbot' order by 1`;
console.log('frostbot schema ready:', tables.map((t) => t.table_name).join(', '));
await sql.end();
