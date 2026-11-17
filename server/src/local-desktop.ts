import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now } from './db.js';
import { env } from './env.js';

const bridge = fileURLToPath(new URL('../box/hermes-desktop.py', import.meta.url));
export interface DesktopStatus {
  supported: boolean; installed: boolean; running: boolean; display: string | null;
  socket: string | null; geometry: string; missing: string[]; install_command: string | null;
}

export function localHome(botId: string): string {
  const bot = db.prepare('SELECT engine FROM bots WHERE id=?').get(botId) as { engine: string } | undefined;
  if (!bot) throw new Error('Bot not found');
  if (bot.engine === 'primary') return env.hermesHome;
  if (!/^bot_[\w-]+$/.test(botId)) throw new Error('Invalid bot ID');
  return path.join(env.enginesDir, botId);
}

function childEnv(botId: string): NodeJS.ProcessEnv {
  const home = localHome(botId);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Hermes loads this bot's own model settings; do not inherit Bot HQ API keys.
  return { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER,
    LANG: process.env.LANG ?? 'C.UTF-8', HERMES_HOME: home, HERMES_SOURCE_DIR: env.hermesSourceDir };
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
export function ensureLocalDesktop(userId: string, botId: string): Promise<DesktopStatus> {
  const pending = starting.get(botId);
  if (pending) return pending;
  const work = (async () => {
    const state = await desktopCommand(botId, 'start');
    if (!state.running || !state.socket || !state.display) throw new Error('Hermes desktop did not start');
    const [width, height] = state.geometry.split('x').map(Number);
    db.prepare('INSERT OR REPLACE INTO screens(bot_id,user_id,screen_id,last_used_at,width,height) VALUES (?,?,?,?,?,?)')
      .run(botId, userId, `hermes-${botId}`, now(), width || null, height || null);
    return state;
  })().finally(() => starting.delete(botId));
  starting.set(botId, work);
  return work;
}
