import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineHome } from './engine.js';
import { db, now } from './db.js';
import { env } from './env.js';
import { desktopTempEnv } from './desktop-temp.js';

const bridge = fileURLToPath(new URL('../box/hermes-desktop.py', import.meta.url));
export interface DesktopStatus {
  supported: boolean; installed: boolean; running: boolean; display: string | null;
  socket: string | null; geometry: string; missing: string[]; install_command: string | null;
}

export function localHome(botId: string): string {
  const bot = db.prepare('SELECT engine FROM bots WHERE id=?').get(botId) as { engine: string } | undefined;
  if (!bot) throw new Error('Bot not found');
  if (bot.engine === 'primary' || bot.engine === 'linked') { const home = engineHome(botId); if (!home) throw new Error('The linked Hermes profile is unavailable'); return home; }
  if (!/^bot_[\w-]+$/.test(botId)) throw new Error('Invalid bot ID');
  return path.join(env.enginesDir, botId);
}

function childEnv(botId: string): NodeJS.ProcessEnv {
  const home = localHome(botId);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Hermes loads this bot's own model settings; do not inherit Bot HQ API keys.
  return { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER,
    LANG: process.env.LANG ?? 'C.UTF-8', HERMES_HOME: home, HERMES_SOURCE_DIR: env.hermesSourceDir,
    ...desktopTempEnv(home) };
}

let python: Promise<string> | undefined;
function pythonExecutable(): Promise<string> {
  if (env.hermesPython) return Promise.resolve(env.hermesPython);
  return python ??= new Promise((resolve, reject) => {
    execFile(env.hermesBin, ['--print-runtime-command'], { timeout: 15_000 }, (err, stdout) => {
      try {
        if (err) throw err;
        const command = JSON.parse(stdout.trim());
        if (!Array.isArray(command) || typeof command[0] !== 'string') throw new Error('Invalid runtime command');
        resolve(command[0]);
      } catch {
        reject(new Error('Cannot locate Hermes Python. Set HERMES_PYTHON to the Python executable used by Hermes, and HERMES_SOURCE_DIR to its source checkout.'));
      }
    });
  });
}
const argsFor = (action: string, args: string[]) => ['-I', bridge, action, ...args];

export async function desktopCommand<T = DesktopStatus>(botId: string, action: string, args: string[] = []): Promise<T> {
  const executable = await pythonExecutable();
  return new Promise((resolve, reject) => {
    execFile(executable, argsFor(action, args), { env: childEnv(botId), timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).trim().slice(-1500)));
      try { resolve(JSON.parse(stdout.trim().split('\n').at(-1)!)); }
      catch { reject(new Error(`Hermes did not return desktop status: ${stdout.slice(-300)}`)); }
    });
  });
}

export async function desktopRelay(botId: string, mode: 'watch' | 'control', viewerId: string) {
  return spawn(await pythonExecutable(), argsFor('relay', [mode, viewerId]), { env: childEnv(botId), stdio: ['pipe', 'pipe', 'pipe'] });
}

const starting = new Map<string, Promise<DesktopStatus>>();
function repairBrowserLauncher(botId: string) {
  // Existing desktops keep their session environment across app updates. Repair the dock too,
  // so they gain the socket-safe temp directory without stopping the user's open applications.
  const panel = path.join(localHome(botId), 'bot-desktop/xdg/xfce4/panel');
  if (!fs.existsSync(panel)) return;
  const temp = desktopTempEnv(localHome(botId));
  const prefix = 'env ' + Object.entries(temp).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ') + ' ';
  for (const entry of fs.readdirSync(panel, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('launcher-')) continue;
    const file = path.join(panel, entry.name, 'hermes.desktop');
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!/^Name=Browser$/m.test(text) || /^Exec=env TMPDIR=/m.test(text)) continue;
    fs.writeFileSync(file, text.replace(/^Exec=(.*)$/m, (_, command) => 'Exec=' + prefix + command));
  }
}
export function ensureLocalDesktop(userId: string, botId: string): Promise<DesktopStatus> {
  const pending = starting.get(botId);
  if (pending) return pending;
  const work = (async () => {
    const state = await desktopCommand(botId, 'start');
    if (!state.running || !state.display) throw new Error('Hermes desktop did not start');
    if (state.socket) repairBrowserLauncher(botId);
    const [width, height] = state.geometry.split('x').map(Number);
    db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at,width,height) VALUES (?,?,?,?,?,?)')
      .run(botId, userId, `hermes-${botId}`, now(), width || null, height || null);
    return state;
  })().finally(() => starting.delete(botId));
  starting.set(botId, work);
  return work;
}
