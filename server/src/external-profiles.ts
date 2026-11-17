import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { env } from './env.js';

export function profileNames(): string[] {
  const root = path.join(env.hermesHome, 'profiles');
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && /^[a-z][a-z0-9_-]{0,39}$/.test(item.name)).map(item => item.name); }
  catch { return []; }
}
export function externalProfile(profile: string) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(profile) || profile === 'default') throw new Error('Choose an existing named Hermes profile');
  const root = fs.realpathSync(path.join(env.hermesHome, 'profiles'));
  const home = fs.realpathSync(path.join(root, profile));
  if (!home.startsWith(root + path.sep)) throw new Error('The Hermes profile must stay inside the profiles directory');
  const config = YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')) ?? {};
  const vars: Record<string, string> = {};
  for (const line of fs.readFileSync(path.join(home, '.env'), 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line);
    if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const port = Number(vars.API_SERVER_PORT ?? '8642');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !vars.API_SERVER_KEY) throw new Error('Enable this profile’s authenticated Hermes API first');
  const url = config.gateway?.standalone ? `http://127.0.0.1:${port}` : `${env.hermesUrl}/p/${encodeURIComponent(profile)}`;
  return { home, url, key: vars.API_SERVER_KEY, platform: vars.TELEGRAM_BOT_TOKEN ? 'telegram' as const : 'discord' as const };
}
