import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import type { AuthVars } from './lib/auth.js';
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
  return c.json({ primary: { available, name: bot?.user_id === c.get('user').id ? getBot(bot.id)?.name ?? 'Hermes' : 'Hermes', linkedBotId: bot?.user_id === c.get('user').id ? bot.id : null, discordSessions: primaryDiscordSessions() } });
});
primaryApi.post('/connect', async c => {
  const previous = linked();
  if (previous) return previous.user_id === c.get('user').id ? c.json({ bot: getBot(previous.id) }) : c.json({ error: 'not available' }, 409);
  if (!fs.existsSync(path.join(env.hermesHome, 'config.yaml'))) return c.json({ error: 'An existing Hermes installation was not found on this PC' }, 409);
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : 'Hermes';
  if (!name) return c.json({ error: 'Choose a name' }, 400);
  const id = newId('bot');
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,engine,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, c.get('user').id, name, 'Hermes · Discord', 'Your existing Hermes agent, connected to this team.', '', 'blob', 'cyan', 'personal', 'primary', now(), now());
  initPrimaryMirror(); hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ bot: getBot(id) });
});
