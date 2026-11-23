// One-off: copy roles (no permissions) + channels/categories (+ order) from the main
// server into the mirror server, then exit. Only READS the main server.
// Usage: npm run mirror:sync
import '../src/env.js';
import { Client, GatewayIntentBits as I, Events } from 'discord.js';
import { MAIN_GUILD_ID, MIRROR_GUILD_ID } from '../src/config.js';
import { sql } from '../src/db.js';
import { loadSettings } from '../src/settings.js';
import * as mirror from '../src/features/mirror.js';

const client = new Client({ intents: [I.Guilds] });
client.once(Events.ClientReady, async () => {
  try {
    await loadSettings();
    await mirror.initMirror(client);
    const main = client.guilds.cache.get(MAIN_GUILD_ID);
    const mg = client.guilds.cache.get(MIRROR_GUILD_ID);
    if (!main || !mg) throw new Error('bot must be in both servers');
    console.log(`main: ${main.name} → mirror: ${mg.name}`);
    const log = (l) => console.log('  ', l);
    console.log('roles…');
    console.log('roles done:', await mirror.syncRoles(main, log));
    console.log('channels…');
    console.log('channels done:', await mirror.syncStructure(main, log));
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await client.destroy();
    await sql.end();
  }
});
client.login(process.env.DISCORD_TOKEN);
