// Explicit local setup command. Keeps the existing gateway, persona and Discord credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import YAML from 'yaml';

const home = process.env.HERMES_HOME_PRIMARY ?? path.join(os.homedir(), '.hermes');
const state = path.join(process.env.T3CODE_BOTS_HOME ?? path.join(os.homedir(), '.t3-bots'), 'bot-hq');
const secret = fs.readFileSync(path.join(state, 'session-secret'), 'utf8').trim();
const port = Number(fs.readFileSync(path.join(state, 'runtime-port'), 'utf8'));
if (!secret || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Start T3 + Bots once before linking Hermes.');
const envFile = path.join(home, '.env');
const configFile = path.join(home, 'config.yaml');
let text = fs.readFileSync(envFile, 'utf8');
const document = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'));
if (document.errors.length) throw new Error('Hermes configuration could not be read.');
const stamp = Date.now();
for (const file of [envFile, configFile]) {
  fs.copyFileSync(file, `${file}.before-t3-bots-${stamp}`);
  fs.chmodSync(`${file}.before-t3-bots-${stamp}`, 0o600);
}
const currentKey = /^API_SERVER_KEY=(.*)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
const values = { API_SERVER_ENABLED: 'true', API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: '8642', API_SERVER_KEY: currentKey && currentKey.length >= 16 ? currentKey : crypto.randomBytes(32).toString('hex') };
for (const [name, value] of Object.entries(values)) {
  const line = new RegExp('^' + name + '=.*$', 'm');
  text = line.test(text) ? text.replace(line, name + '=' + value) : text.trimEnd() + '\n' + name + '=' + value + '\n';
}
const token = crypto.createHmac('sha256', secret).update('mcp:primary').digest('hex');
document.setIn(['mcp_servers', 'hq'], { url: `http://127.0.0.1:${port}/mcp/primary`, headers: { Authorization: `Bearer ${token}` }, timeout: 1800, connect_timeout: 30 });
const write = (file, content) => { const tmp = file + '.t3-bots.tmp'; fs.writeFileSync(tmp, content, { mode: 0o600 }); fs.renameSync(tmp, file); fs.chmodSync(file, 0o600); };
write(envFile, text);
write(configFile, document.toString());
console.log('Hermes API and team tools configured. Private backups saved beside config.yaml and .env. Restart the Hermes gateway, then connect the existing agent in T3 + Bots.');
