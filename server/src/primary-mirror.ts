import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { env } from './env.js';
import { engineHome } from './engine.js';
import { appendRow } from './store.js';
import { hub } from './lib/hub.js';

db.exec('CREATE TABLE IF NOT EXISTS primary_mirror_messages (bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,message_id INTEGER NOT NULL,PRIMARY KEY(bot_id,message_id))');
type LinkedBot = { id: string; user_id: string; engine: string; hermes_platform: string | null };
const links = () => db.prepare("SELECT id,user_id,engine,hermes_platform FROM bots WHERE engine IN ('primary','linked')").all() as LinkedBot[];
const watchers = new Map<string, { home: fs.FSWatcher; memory?: fs.FSWatcher; timer?: NodeJS.Timeout }>();
function openState(home: string) {
  const file = path.join(home, 'state.db');
  try { return fs.existsSync(file) ? new Database(file, { readonly: true, fileMustExist: true }) : null; } catch { return null; }
}
export function primaryDiscordSessions(): number {
  const source = openState(env.hermesHome);
  try { return source ? Number((source.prepare("SELECT count(*) n FROM sessions WHERE source='discord'").get() as { n: number }).n) : 0; }
  catch { return 0; } finally { source?.close(); }
}
function recentConversation(bot: LinkedBot) {
  let home: string | null;
  try { home = engineHome(bot.id); } catch { return []; }
  if (!home) return [];
  const source = openState(home);
  if (!source) return [];
  const platform = bot.hermes_platform === 'telegram' ? 'telegram' : 'discord';
  try {
    let channel = '';
    try { channel = new RegExp('^' + platform.toUpperCase() + '_HOME_CHANNEL=(.*)$', 'm').exec(fs.readFileSync(path.join(home, '.env'), 'utf8'))?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''; } catch {}
    let session = channel ? source.prepare("SELECT id FROM sessions WHERE source=? AND (chat_id=? OR instr(COALESCE(session_key,''),?)>0) ORDER BY started_at DESC LIMIT 1").get(platform, channel, channel) as { id: string } | undefined : undefined;
    session ??= source.prepare("SELECT id FROM sessions WHERE source=? ORDER BY started_at DESC LIMIT 1").get(platform) as { id: string } | undefined;
    if (!session) return [];
    const rows = source.prepare("SELECT id,role,content FROM messages WHERE session_id=? AND role IN ('user','assistant') AND COALESCE(active,1)=1 ORDER BY id DESC LIMIT 200").all(session.id) as { id: number; role: 'user' | 'assistant'; content: string }[];
    return rows.reverse().map(row => {
      let text = row.content ?? '';
      try { const value = JSON.parse(text); if (Array.isArray(value)) text = value.filter(part => part.type === 'text').map(part => part.text).join('\n'); } catch {}
      return { ...row, text, sessionId: session.id, platform };
    }).filter(row => row.text.trim());
  } catch { return []; } finally { source.close(); }
}
export function primaryConversationContext(botId?: string): string {
  const bot = links().find(bot => botId ? bot.id === botId : bot.engine === 'primary');
  const rows = bot ? recentConversation(bot).slice(-12) : [];
  const name = bot?.hermes_platform === 'telegram' ? 'Telegram' : 'Discord';
  return rows.length ? `\n\nRecent ${name} conversation for continuity. Do not post duplicate replies to ${name}:\n` + rows.map(row => `${row.role === 'assistant' ? 'You' : name}: ${row.text.slice(0, 1500)}`).join('\n').slice(-12_000) : '';
}
function syncBot(bot: LinkedBot) {
  for (const row of recentConversation(bot)) {
    if (db.prepare('SELECT 1 FROM primary_mirror_messages WHERE bot_id=? AND message_id=?').get(bot.id, row.id)) continue;
    db.transaction(() => {
      const kind = row.platform === 'telegram' ? 'telegram' : 'discord';
      appendRow(bot.id, 'message', { type: 'message', role: row.role, text: row.text, ...(row.role === 'user' ? { from: { kind, id: row.sessionId, name: kind === 'telegram' ? 'Telegram' : 'Discord' } as const } : {}) });
      db.prepare('INSERT INTO primary_mirror_messages(bot_id,message_id) VALUES(?,?)').run(bot.id, row.id);
    })();
  }
}
export function syncPrimaryMessages() { for (const bot of links()) syncBot(bot); }
export function initPrimaryMirror() {
  for (const watcher of watchers.values()) { watcher.home.close(); watcher.memory?.close(); clearTimeout(watcher.timer); }
  watchers.clear();
  for (const bot of links()) {
    let home: string | null;
    try { home = engineHome(bot.id); } catch { continue; }
    if (!home || !fs.existsSync(home)) continue;
    syncBot(bot);
    const watcher = { home: fs.watch(home, (_, filename) => {
      if (!filename?.toString().startsWith('state.db')) return;
      const current = watchers.get(bot.id); if (!current) return;
      clearTimeout(current.timer); current.timer = setTimeout(() => syncBot(bot), 100); current.timer.unref();
    }) } as { home: fs.FSWatcher; memory?: fs.FSWatcher; timer?: NodeJS.Timeout };
    watcher.home.unref(); watchers.set(bot.id, watcher);
    const memory = path.join(home, 'memories');
    if (fs.existsSync(memory)) { watcher.memory = fs.watch(memory, () => hub.emit(bot.user_id, { type: 'memories', botId: bot.id })); watcher.memory.unref(); }
  }
}
