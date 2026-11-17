import { Hono } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { engineHome, refreshGeneratedPersonas } from './engine.js';
import { displayNameFor } from './user-profile.js';
import { getBotRow } from './store.js';
import type { AuthVars } from './lib/auth.js';

export const botSettingsApi = new Hono<AuthVars>();
botSettingsApi.get('/preferences', c => c.json({ preferences: { displayName: displayNameFor(c.get('user').id) } }));
botSettingsApi.post('/preferences', async c => {
  const body = await c.req.json();
  if (typeof body.displayName !== 'string' || body.displayName.length > 60 || /[\x00-\x1f\x7f]/.test(body.displayName)) return c.json({ error: 'Choose a name up to 60 characters' }, 400);
  const userId = c.get('user').id;
  const previous = displayNameFor(userId);
  const displayName = body.displayName.trim() || 'user';
  db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, userId);
  refreshGeneratedPersonas(userId, previous);
  return c.json({ preferences: { displayName } });
});

function soulFile(userId: string, botId: string) {
  if (getBotRow(botId)?.user_id !== userId) return null;
  const home = engineHome(botId);
  return home ? path.join(home, 'SOUL.md') : null;
}
function readSoul(file: string) {
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error('SOUL.md must be a regular file in the bot home');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { text, version: fs.existsSync(file) ? crypto.createHash('sha256').update(text).digest('hex') : null };
}
botSettingsApi.get('/bots/:id/soul', c => {
  const file = soulFile(c.get('user').id, c.req.param('id'));
  if (!file) return c.json({ error: 'not found' }, 404);
  try { return c.json({ soul: readSoul(file) }); }
  catch { return c.json({ error: 'Could not read this bot’s SOUL.md' }, 409); }
});
botSettingsApi.post('/bots/:id/soul', async c => {
  const file = soulFile(c.get('user').id, c.req.param('id'));
  if (!file) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json();
  if (typeof body.text !== 'string' || body.text.length > 100_000 || body.text.includes('\0') || !(body.version === null || typeof body.version === 'string')) return c.json({ error: 'SOUL.md must be text up to 100,000 characters' }, 400);
  try {
    const previous = readSoul(file);
    if (previous.version !== body.version) return c.json({ error: 'SOUL.md changed since you opened it. Reload the file before saving.' }, 409);
    if (previous.text !== body.text) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (previous.version) {
        const history = path.join(path.dirname(file), '.soul-history');
        fs.mkdirSync(history, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(history, `SOUL.${Date.now()}.${previous.version.slice(0, 12)}.md`), previous.text, { mode: 0o600 });
      }
      const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      fs.writeFileSync(temp, body.text, { mode: 0o600, flag: 'wx' });
      db.prepare('UPDATE bots SET soul_custom=1 WHERE id=?').run(c.req.param('id'));
      fs.renameSync(temp, file);
    }
    return c.json({ ok: true, soul: readSoul(file) });
  } catch { return c.json({ error: 'Could not save SOUL.md. Your draft is still in the editor.' }, 409); }
});
