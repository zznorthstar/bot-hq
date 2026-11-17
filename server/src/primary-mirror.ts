import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { env } from './env.js';
import { appendRow } from './store.js';
import { hub } from './lib/hub.js';

db.exec('CREATE TABLE IF NOT EXISTS primary_mirror_messages (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,message_id INTEGER NOT NULL,PRIMARY KEY(bot_id,message_id))');
let watcher: fs.FSWatcher | null = null;
let memoryWatcher: fs.FSWatcher | null = null;
let timer: NodeJS.Timeout | undefined;
const linked = () => db.prepare("SELECT id,user_id FROM bots WHERE engine='primary'").get() as { id: string; user_id: string } | undefined;
function openState() {
  const file = path.join(env.hermesHome, 'state.db');
  try { return fs.existsSync(file) ? new Database(file, { readonly: true, fileMustExist: true }) : null; } catch { return null; }
}
export function primaryDiscordSessions(): number {
  const source = openState();
  try { return source ? Number((source.prepare("SELECT count(*) n FROM sessions WHERE source='discord'").get() as { n: number }).n) : 0; }
  catch { return 0; } finally { source?.close(); }
}
function recentDiscord() {
  const source = openState();
  if (!source) return [];
  try {
    let channel = '';
    try { channel = /^DISCORD_HOME_CHANNEL=(.*)$/m.exec(fs.readFileSync(path.join(env.hermesHome, '.env'), 'utf8'))?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''; } catch {}
    let session = channel ? source.prepare("SELECT id FROM sessions WHERE source='discord' AND (chat_id=? OR instr(COALESCE(session_key,''),?)>0) ORDER BY started_at DESC LIMIT 1").get(channel, channel) as { id: string } | undefined : undefined;
    session ??= source.prepare("SELECT id FROM sessions WHERE source='discord' ORDER BY started_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (!session) return [];
    const rows = source.prepare("SELECT id,role,content FROM messages WHERE session_id=? AND role IN ('user','assistant') AND COALESCE(active,1)=1 ORDER BY id DESC LIMIT 200").all(session.id) as { id: number; role: 'user' | 'assistant'; content: string }[];
    return rows.reverse().map(row => {
      let text = row.content ?? '';
      try { const value = JSON.parse(text); if (Array.isArray(value)) text = value.filter(part => part.type === 'text').map(part => part.text).join('\n'); } catch {}
      return { ...row, text, sessionId: session.id };
    }).filter(row => row.text.trim());
  } catch { return []; } finally { source.close(); }
}
export function primaryConversationContext(): string {
  const rows = recentDiscord().slice(-12);
  return rows.length ? '\n\nRecent Discord conversation for continuity. Do not post duplicate replies to Discord:\n' + rows.map(row => `${row.role === 'assistant' ? 'You' : 'Discord'}: ${row.text.slice(0, 1500)}`).join('\n').slice(-12_000) : '';
}
export function syncPrimaryMessages() {
  const bot = linked();
  if (!bot) return;
  for (const row of recentDiscord()) {
    if (db.prepare('SELECT 1 FROM primary_mirror_messages WHERE bot_id=? AND message_id=?').get(bot.id, row.id)) continue;
    db.transaction(() => {
      appendRow(bot.id, 'message', { type: 'message', role: row.role, text: row.text, ...(row.role === 'user' ? { from: { kind: 'discord', id: row.sessionId, name: 'Discord' } as const } : {}) });
      db.prepare('INSERT INTO primary_mirror_messages(bot_id,message_id) VALUES(?,?)').run(bot.id, row.id);
    })();
  }
}
export function initPrimaryMirror() {
  watcher?.close(); memoryWatcher?.close();
  if (!linked() || !fs.existsSync(env.hermesHome)) return;
  syncPrimaryMessages();
  watcher = fs.watch(env.hermesHome, (_, filename) => {
    if (!filename?.toString().startsWith('state.db')) return;
    clearTimeout(timer); timer = setTimeout(syncPrimaryMessages, 100); timer.unref();
  }); watcher.unref();
  const memory = path.join(env.hermesHome, 'memories');
  if (fs.existsSync(memory)) {
    memoryWatcher = fs.watch(memory, () => { const bot = linked(); if (bot) hub.emit(bot.user_id, { type: 'memories', botId: bot.id }); });
    memoryWatcher.unref();
  }
}
