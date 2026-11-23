// Kick accounts younger than `min_age_days` when they join.

import { sql } from '../db.js';
import { getBool, getNum } from '../settings.js';
import { embed, fmtDuration, modlog } from '../util.js';

const hasBypass = async (g, u) => (await sql`select 1 from frostbot.age_bypass where guild_id = ${g} and user_id = ${u}`).length > 0;
export const addBypass = (g, u) => sql`insert into frostbot.age_bypass (guild_id, user_id) values (${g}, ${u}) on conflict do nothing`;
export const removeBypass = async (g, u) => (await sql`delete from frostbot.age_bypass where guild_id = ${g} and user_id = ${u}`).count > 0;

/** Returns true if the member was kicked. */
export async function checkNewAccount(member) {
  const g = member.guild;
  if (!getBool(g.id, 'newacct') || member.user.bot) return false;
  if (await hasBypass(g.id, member.id)) return false;

  const minMs = getNum(g.id, 'min_age_days') * 86_400_000;
  const age = Date.now() - member.user.createdTimestamp;
  if (age >= minMs) return false;

  const wait = fmtDuration(minMs - age);
  await member
    .send(`Hey! **${g.name}** doesn't allow accounts younger than ${getNum(g.id, 'min_age_days')} day(s). Yours is ${fmtDuration(age)} old, so you can rejoin in about **${wait}**.`)
    .catch(() => {});
  try {
    await member.kick(`Account too new (${fmtDuration(age)} old)`);
  } catch (e) {
    await modlog(g, embed('bad', `Couldn't kick new account ${member} (\`${member.id}\`): ${e.message}`));
    return false;
  }
  await modlog(
    g,
    embed('warn', `👶 Kicked **${member.user.tag}** (\`${member.id}\`): account created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>.\nIf they're legit: \`frst allow ${member.id}\``, 'New account kicked'),
  );
  return true;
}
