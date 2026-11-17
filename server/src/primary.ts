import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import type { AuthVars } from './lib/auth.js';
import { externalProfile, profileNames } from './external-profiles.js';
import { getBot } from './store.js';
import { initPrimaryMirror, primaryDiscordSessions } from './primary-mirror.js';

export const primaryApi = new Hono<AuthVars>();
const linked = () => db.prepare("SELECT id,user_id FROM bots WHERE engine='primary'").get() as { id: string; user_id: string } | undefined;
primaryApi.get('/status', async c => {
  let available = false;
  let key = env.hermesKey;
  try { key ||= /^API_SERVER_KEY=(.*)$/m.exec(fs.readFileSync(path.join(env.hermesHome, '.env'), 'utf8'))?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''; } catch {}
  if (key) { try { available = (await fetch(env.hermesUrl + '/v1/models', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(2000) })).ok; } catch {} }
  const bot = linked();
  const profiles = await Promise.all(profileNames().map(async profile => {
    try {
      const info = externalProfile(profile);
      const bot = db.prepare("SELECT id,name,user_id FROM bots WHERE engine='linked' AND hermes_profile=?").get(profile) as { id: string; name: string; user_id: string } | undefined;
      let available = false;
      try { available = (await fetch(info.url + '/v1/models', { headers: { authorization: 'Bearer ' + info.key }, signal: AbortSignal.timeout(2000) })).ok; } catch {}
      return { profile, name: bot?.user_id === c.get('user').id ? bot.name : profile[0].toUpperCase() + profile.slice(1), available, platform: info.platform, linkedBotId: bot?.user_id === c.get('user').id ? bot.id : null };
    } catch { return null; }
  }));
  return c.json({ primary: { available, name: bot?.user_id === c.get('user').id ? getBot(bot.id)?.name ?? 'Hermes' : 'Hermes', linkedBotId: bot?.user_id === c.get('user').id ? bot.id : null, discordSessions: primaryDiscordSessions() }, profiles: profiles.filter(profile => profile !== null) });
});
primaryApi.post('/connect', async c => {
  const body = await c.req.json().catch(() => ({}));
  if (body.profile !== undefined) {
    let info;
    try { info = externalProfile(body.profile); } catch { return c.json({ error: 'Choose an existing Hermes profile with its API enabled' }, 400); }
    const previous = db.prepare("SELECT id,user_id FROM bots WHERE engine='linked' AND hermes_profile=?").get(body.profile) as { id: string; user_id: string } | undefined;
    if (previous) return previous.user_id === c.get('user').id ? c.json({ bot: getBot(previous.id) }) : c.json({ error: 'not available' }, 409);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : body.profile;
    if (!name) return c.json({ error: 'Choose a name' }, 400);
    const id = newId('bot');
    db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,engine,hermes_profile,hermes_platform,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, c.get('user').id, name, 'Hermes · ' + (info.platform === 'telegram' ? 'Telegram' : 'Discord'), 'Your existing Hermes profile, connected to this team.', '', 'blob', 'cyan', 'personal', 'linked', body.profile, info.platform, now(), now());
    initPrimaryMirror(); hub.emit(c.get('user').id, { type: 'roster' });
    return c.json({ bot: getBot(id) });
  }
  const previous = linked();
  if (previous) return previous.user_id === c.get('user').id ? c.json({ bot: getBot(previous.id) }) : c.json({ error: 'not available' }, 409);
  if (!fs.existsSync(path.join(env.hermesHome, 'config.yaml'))) return c.json({ error: 'An existing Hermes installation was not found on this PC' }, 409);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : 'Hermes';
  if (!name) return c.json({ error: 'Choose a name' }, 400);
  const id = newId('bot');
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,engine,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, c.get('user').id, name, 'Hermes · Discord', 'Your existing Hermes agent, connected to this team.', '', 'blob', 'cyan', 'personal', 'primary', now(), now());
  initPrimaryMirror(); hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ bot: getBot(id) });
});
