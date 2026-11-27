// Create (or rotate the password of) the restricted Postgres login the Matchbox Minecraft
// plugin uses, and write its connection file straight to the plugin folder. The password is
// never printed. Re-run to rotate it.
//
// Usage: node scripts/mc-role.js <path/to/server/plugins/Matchbox/bridge.properties>
import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { sql } from '../src/db.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/mc-role.js <path/to/plugins/Matchbox/bridge.properties>');
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
// Supabase pooler logins look like "<role>.<project-ref>"
const projectRef = decodeURIComponent(url.username).split('.')[1];
if (!projectRef) throw new Error('DATABASE_URL user is not "<role>.<project-ref>" (expected the Supabase pooler URL)');

const password = randomBytes(24).toString('base64url');
const [{ exists }] = await sql`select exists(select 1 from pg_roles where rolname = 'matchbox_plugin') as exists`;
// Identifiers/passwords can't be bound parameters in CREATE/ALTER ROLE; the password is
// base64url (no quotes), so inlining it is safe.
await sql.unsafe(exists
  ? `alter role matchbox_plugin with login password '${password}'`
  : `create role matchbox_plugin with login noinherit connection limit 4 password '${password}'`);

// Re-apply the grants block from the schema now that the role exists.
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
await sql.unsafe(schema);

const jdbc = `jdbc:postgresql://${url.hostname}:${url.port || 5432}${url.pathname}?sslmode=require`;
writeFileSync(out, [
  '# Matchbox <-> Frostbot bridge (written by frostbot/scripts/mc-role.js). Keep private.',
  'enabled=true',
  `jdbc-url=${jdbc}`,
  `user=matchbox_plugin.${projectRef}`,
  `password=${password}`,
  '',
].join('\n'), { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`${exists ? 'rotated' : 'created'} role matchbox_plugin; wrote ${out}`);
await sql.end();
