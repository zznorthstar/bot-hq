// Real isolated SQLite and Hono routes; no provider calls, Discord posts or model downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-chat-features-'));
Object.assign(process.env, { SESSION_SECRET: 'private-test-secret', COMPUTER_BACKEND: 'hermes', USE_PRIMARY_ENGINE: '0', DB_PATH: path.join(root, 'hq.db'), LIBRARY_ROOT: path.join(root, 'files'), HERMES_HOME_PRIMARY: path.join(root, 'hermes'), LOCAL_VOICE_HOME: path.join(root, 'voice'), HERMES_URL: 'http://127.0.0.1:1', HERMES_KEY: '' });
const { db } = await import('../server/dist/db.js');
const { chatMediaApi, messageAttachments, attachmentInput } = await import('../server/dist/chat-media.js');
const { localVoiceApi } = await import('../server/dist/local-voice.js');
const { primaryApi } = await import('../server/dist/primary.js');
const { syncPrimaryMessages } = await import('../server/dist/primary-mirror.js');
const app = new Hono();
app.use('*', async (c, next) => { c.set('user', { id: c.req.header('test-user') ?? 'u1', name: 'Human', email: 'test@localhost' }); await next(); });
app.route('/', chatMediaApi); app.route('/voice', localVoiceApi); app.route('/primary', primaryApi);
const request = (url, body, user = 'u1') => app.request(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'test-user': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
for (const id of ['u1', 'u2']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,1)').run(id, id + '@localhost', id);
for (const [id, user] of [['bot_one', 'u1'], ['bot_two', 'u2']]) db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at,engine) VALUES(?,?,?,1,1,?)').run(id, user, id, 'managed');

test.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
test('file uploads preserve content, sanitize names and enforce bot ownership', async () => {
  const response = await request('/bots/bot_one/attachments', { name: '../../notes.txt', mime: 'text/plain', data: Buffer.from('hello local file').toString('base64') });
  assert.equal(response.status, 200);
  const { attachment } = await response.json();
  assert.equal(attachment.name, 'notes.txt');
  assert.equal(attachment.size, 16);
  const files = messageAttachments('bot_one', [attachment.id]);
  assert.equal(fs.statSync(files[0].path).mode & 0o777, 0o600);
  assert.match(JSON.stringify(attachmentInput('Read this', files)), /hello local file/);
  assert.throws(() => messageAttachments('bot_two', [attachment.id]), /not available/);
  assert.equal((await request(`/bots/bot_one/attachments/${attachment.id}`, undefined, 'u2')).status, 404);
  const download = await (await request(`/bots/bot_one/attachments/${attachment.id}`)).json();
  assert.equal(Buffer.from(download.file.data, 'base64').toString(), 'hello local file');
  assert.equal((await request('/bots/bot_one/attachments', { name: 'bad', data: '!!!!' })).status, 400);
});
test('uploaded avatars stay out of roster payloads and can be removed', async () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII=';
  const result = await (await request('/bots/bot_one/avatar', { dataUrl })).json();
  assert.ok(result.bot.avatarVersion);
  assert.equal(result.bot.avatar_data, undefined);
  assert.equal((await (await request('/bots/bot_one/avatar')).json()).avatar, dataUrl);
  assert.equal((await request('/bots/bot_one/avatar', { dataUrl }, 'u2')).status, 404);
  assert.equal((await request('/bots/bot_one/avatar', { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })).status, 400);
  await request('/bots/bot_one/avatar', { dataUrl: null });
  assert.equal((await (await request('/bots/bot_one/avatar')).json()).avatar, null);
});
test('local voice status works without xAI; missing models fail clearly', async () => {
  const result = await (await request('/voice/status')).json();
  assert.equal(result.voice.provider, 'local'); assert.equal(result.voice.installed, false);
  assert.equal((await request('/voice/warm', {})).status, 503);
  assert.equal((await request('/voice/speak', { botId: 'bot_one', text: 'hi' }, 'u2')).status, 404);
});
test('linking imports Discord history once and never writes to Hermes state or persona', async () => {
  const home = process.env.HERMES_HOME_PRIMARY;
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'config.yaml'), 'terminal:\n  backend: docker\n');
  fs.writeFileSync(path.join(home, 'SOUL.md'), 'The existing persona.');
  const state = new Database(path.join(home, 'state.db'));
  state.exec("CREATE TABLE sessions(id TEXT,source TEXT,chat_id TEXT,session_key TEXT,started_at INTEGER); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,active INTEGER); INSERT INTO sessions VALUES('discord-test','discord','channel','discord:channel',1); INSERT INTO messages VALUES(1,'discord-test','user','Hi C4my',1),(2,'discord-test','assistant','Hello!',1);");
  state.close();
  const before = fs.readFileSync(path.join(home, 'state.db'));
  const result = await (await request('/primary/connect', { name: 'C4my' })).json();
  assert.equal(result.bot.name, 'C4my'); assert.equal(result.bot.engineKind, 'primary');
  syncPrimaryMessages(); syncPrimaryMessages();
  const rows = db.prepare('SELECT body FROM rows WHERE bot_id=? ORDER BY seq').all(result.bot.id).map(row => JSON.parse(row.body));
  assert.equal(rows.length, 2); assert.equal(rows[0].from.kind, 'discord'); assert.equal(rows[1].role, 'assistant');
  assert.deepEqual(fs.readFileSync(path.join(home, 'state.db')), before);
  assert.equal(fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8'), 'The existing persona.');
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), 'terminal:\n  backend: docker\n');
  assert.equal((await (await request('/primary/connect', { name: 'other' })).json()).bot.id, result.bot.id);
  assert.equal((await request('/primary/connect', { name: 'other' }, 'u2')).status, 409);
});

test('mounted local speech routes require auth and bypass the hosted voice key guard', async () => {
  const { api } = await import('../server/dist/routes.js');
  const mounted = new Hono().route('/api', api);
  assert.equal((await mounted.request('/api/voice/local/status')).status, 401);
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run('test-cookie', 'u1', Date.now(), Date.now() + 60000);
  const response = await mounted.request('/api/voice/local/status', { headers: { cookie: 'grokbot_session=test-cookie' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).voice.provider, 'local');
});
