import { Hono } from 'hono';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getBotRow } from './store.js';
import type { AuthVars } from './lib/auth.js';

export const localVoiceApi = new Hono<AuthVars>();
const root = process.env.LOCAL_VOICE_HOME ?? path.join(process.env.T3CODE_HOME ?? path.join(os.homedir(), '.t3-bots'), 'voice');
const python = path.join(root, 'venv/bin/python');
const workerFile = fileURLToPath(new URL('../box/local-voice.py', import.meta.url));
let worker: ChildProcessWithoutNullStreams | null = null;
let sequence = 0;
let warmed = false;
let setup: Promise<void> | null = null;
const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const installed = () => fs.existsSync(python) && ['kokoro-v1.0.int8.onnx', 'voices-v1.0.bin', 'whisper-base.en/model.bin'].every(file => fs.existsSync(path.join(root, 'models', file)));

function start() {
  if (worker) return worker;
  if (!installed()) throw new Error('Install the local voice models in Bot settings first');
  const child = spawn(python, ['-u', workerFile], { env: { PATH: process.env.PATH, HOME: os.homedir(), LOCAL_VOICE_HOME: root, OMP_NUM_THREADS: '4', HF_HUB_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  worker = child;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try {
      const result = JSON.parse(line);
      const item = pending.get(result.id);
      if (!item) return;
      clearTimeout(item.timer); pending.delete(result.id);
      if (result.ok) item.resolve(result); else item.reject(new Error(result.error || 'Local speech failed'));
    } catch {}
  });
  child.stderr.on('data', () => {});
  const stopped = () => {
    if (worker !== child) return;
    worker = null; warmed = false;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Local speech stopped. Retry the call.')); }
    pending.clear();
  };
  child.stdin.on('error', stopped);
  child.once('error', stopped); child.once('exit', stopped);
  return child;
}

export function localSpeech(action: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (pending.size >= 12) return Promise.reject(new Error('Local speech is busy. Retry shortly.'));
  const child = start();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Local speech timed out. Retry the call.')); }, 90_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ ...input, id, action }) + '\n');
  });
}

process.on('exit', () => worker?.kill('SIGTERM'));
localVoiceApi.get('/status', c => c.json({ voice: { installed: installed(), ready: warmed, provider: 'local', voices: ['af_heart', 'af_bella', 'af_nicole', 'am_adam', 'am_michael', 'bf_emma', 'bm_george'] } }));
localVoiceApi.post('/setup', async c => {
  if (!setup) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    setup = new Promise<void>((resolve, reject) => {
      const fd = fs.openSync(path.join(root, 'setup.log'), 'a', 0o600);
      const child = spawn(process.execPath, [fileURLToPath(new URL('../box/setup-local-voice.mjs', import.meta.url))], { env: { PATH: process.env.PATH, HOME: os.homedir(), LOCAL_VOICE_HOME: root }, stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Local voice setup failed. See the voice setup log.')));
    }).finally(() => { setup = null; });
  }
  try { await setup; return c.json({ ready: installed() }); }
  catch { return c.json({ error: 'Could not prepare local voice. Check the voice setup log and retry.' }, 503); }
});
localVoiceApi.post('/warm', async c => {
  try { const result = await localSpeech('warm'); warmed = true; return c.json({ ready: true, voices: result.voices }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Local voice is unavailable' }, 503); }
});
for (const action of ['transcribe', 'speak'] as const) {
  localVoiceApi.post('/' + action, async c => {
    const body = await c.req.json();
    if (getBotRow(body.botId)?.user_id !== c.get('user').id) return c.json({ error: 'not found' }, 404);
    if (action === 'transcribe' && (typeof body.data !== 'string' || body.data.length > 5_400_000)) return c.json({ error: 'Recordings are limited to one minute' }, 400);
    if (action === 'speak' && (typeof body.text !== 'string' || body.text.length > 1200)) return c.json({ error: 'Speech text is too long' }, 400);
    try { return c.json(await localSpeech(action, body)); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Local speech failed' }, 503); }
  });
}
