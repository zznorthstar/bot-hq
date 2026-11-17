import { Hono } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { emitBot, getBot, getBotRow } from './store.js';
import type { AuthVars } from './lib/auth.js';
import type { ChatAttachment } from './types.js';

const MAX_FILE = 10 * 1024 * 1024;
type StoredAttachment = ChatAttachment & { bot_id: string; path: string };
export const chatMediaApi = new Hono<AuthVars>();
const owns = (userId: string, botId: string) => getBotRow(botId)?.user_id === userId;
const decode = (data: unknown, max: number) => {
  if (typeof data !== 'string' || data.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid file data');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== data) throw new Error('Invalid file data');
  return bytes;
};
const publicAttachment = (file: StoredAttachment): ChatAttachment => ({ id: file.id, name: file.name, mime: file.mime, size: file.size });

export function messageAttachments(botId: string, ids: unknown): StoredAttachment[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string')) throw new Error('Choose at most 10 attachments');
  return [...new Set(ids)].map(id => {
    const file = db.prepare('SELECT * FROM chat_attachments WHERE id=? AND bot_id=?').get(id, botId) as StoredAttachment | undefined;
    if (!file) throw new Error('An attachment is not available for this bot');
    return file;
  });
}

export function attachmentInput(text: string, files: StoredAttachment[]) {
  if (!files.length) return text;
  const note = files.map(file => `${file.name} (${file.mime}, ${file.size} bytes): ${file.path}`).join('\n');
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: `${text}\n\nAttached files in your library:\n${note}` }];
  for (const file of files) {
    if (/^image\/(png|jpeg|webp)$/.test(file.mime)) content.push({ type: 'input_image', image_url: `data:${file.mime};base64,${fs.readFileSync(file.path).toString('base64')}` });
    else if (file.mime.startsWith('text/') || /\.(md|txt|csv|json|yaml|yml|log|ts|js|py)$/i.test(file.name)) {
      content.push({ type: 'input_text', text: `Contents of ${file.name}:\n${fs.readFileSync(file.path).subarray(0, 100_000).toString('utf8')}` });
    }
  }
  return [{ role: 'user', content }];
}

chatMediaApi.post('/bots/:id/attachments', async c => {
  const botId = c.req.param('id');
  if (!owns(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  if (!env.localBox) return c.json({ error: 'Uploads require the local computer backend' }, 409);
  try {
    const body = await c.req.json();
    const data = decode(body.data, MAX_FILE);
    const name = typeof body.name === 'string' ? path.basename(body.name).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) : '';
    if (!name || name === '.' || name === '..') return c.json({ error: 'Choose a file with a name' }, 400);
    const mime = typeof body.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.mime) ? body.mime : 'application/octet-stream';
    const id = newId('file');
    const directory = path.join(env.libraryRoot, botId, 'uploads');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `${id}-${name}`);
    fs.writeFileSync(filePath, data, { flag: 'wx', mode: 0o600 });
    db.prepare('INSERT INTO chat_attachments(id,bot_id,name,mime,size,path,created_at) VALUES(?,?,?,?,?,?,?)').run(id, botId, name, mime, data.length, filePath, now());
    return c.json({ attachment: { id, name, mime, size: data.length } });
  } catch { return c.json({ error: 'Could not upload this file. The limit is 10 MB per file.' }, 400); }
});

chatMediaApi.get('/bots/:id/attachments/:fileId', c => {
  const botId = c.req.param('id');
  if (!owns(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  const file = db.prepare('SELECT * FROM chat_attachments WHERE id=? AND bot_id=?').get(c.req.param('fileId'), botId) as StoredAttachment | undefined;
  if (!file) return c.json({ error: 'not found' }, 404);
  try { return c.json({ file: { ...publicAttachment(file), data: fs.readFileSync(file.path).toString('base64') } }); }
  catch { return c.json({ error: 'File no longer available' }, 404); }
});

chatMediaApi.get('/bots/:id/avatar', c => {
  const botId = c.req.param('id');
  if (!owns(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  return c.json({ avatar: getBotRow(botId).avatar_data ?? null });
});

chatMediaApi.post('/bots/:id/avatar', async c => {
  const botId = c.req.param('id');
  if (!owns(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  try {
    const { dataUrl } = await c.req.json();
    if (dataUrl === null) {
      db.prepare('UPDATE bots SET avatar_data=NULL,avatar_version=NULL WHERE id=?').run(botId);
    } else {
      const match = typeof dataUrl === 'string' ? /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl) : null;
      if (!match) return c.json({ error: 'Choose a PNG, JPEG or WebP image' }, 400);
      const bytes = decode(match[2], 256_000);
      const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
      if (!valid) return c.json({ error: 'This file is not a supported image' }, 400);
      db.prepare('UPDATE bots SET avatar_data=?,avatar_version=? WHERE id=?').run(dataUrl, crypto.createHash('sha256').update(bytes).digest('hex'), botId);
    }
    emitBot(botId);
    return c.json({ bot: getBot(botId) });
  } catch { return c.json({ error: 'Could not save this avatar' }, 400); }
});
