// Provider-free integration test: real HTTP/auth/SQLite + Python bridge + Unix RFB socket.
// The Hermes desktop runtime is a fixture, so this needs no X server or model/API calls.
// Run after npm run build: node --test tests/local-desktop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test('browser temporary directories remain private and fit Chrome Unix sockets for deeply nested bots', async () => {
  const { desktopTempEnv } = await import('../server/dist/desktop-temp.js');
  const home = '/home/example/.t3-bots/bot-hq/engines/bot_' + 'a'.repeat(70);
  const first = desktopTempEnv(home);
  const second = desktopTempEnv(home + 'b');
  assert.equal(first.TMPDIR, desktopTempEnv(home).TMPDIR);
  assert.notEqual(first.TMPDIR, second.TMPDIR);
  assert.ok(first.TMPDIR.length <= 50);
  assert.equal((await fs.stat(first.TMPDIR)).mode & 0o777, 0o700);
  await fs.rm(first.TMPDIR, { recursive: true });
  await fs.rm(second.TMPDIR, { recursive: true });
});
async function until(fn) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await delay(25); }
  throw new Error('Timed out');
}

for (const sandbox of [false, true]) test(`local ${sandbox ? 'Docker stream' : 'Unix socket'} viewer authenticates and honours watch/control`, { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-hq-local-'));
  const source = path.join(root, 'source');
  const pkg = path.join(source, 'tools', 'bot_desktop');
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(source, 'tools', '__init__.py'), '');
  await fs.writeFile(path.join(pkg, '__init__.py'), '');
  await fs.writeFile(path.join(pkg, 'placement.py'), 'GATEWAY="gateway"\ndef resolve():\n return type("Placement", (), {"where": GATEWAY})()\n');
  await fs.writeFile(path.join(pkg, 'runtime.py'), `
import os, subprocess, sys
from pathlib import Path
class State:
 running=True
 socket=None if os.path.exists(os.environ['HERMES_HOME']+'/sandbox') else os.environ['HERMES_HOME']+'/test.sock'
 def as_dict(self):
  return dict(supported=True, installed=True, running=True, display=':25', socket=self.socket, geometry='640x480', missing=[], install_command=None)
def status(): return State()
def start(): return State()
def stop(): pass
def _owned_sandbox_env(): return True
def open_rfb_stream():
 code = "import socket,os,selectors; s=socket.socket(socket.AF_UNIX); s.connect(os.environ['HERMES_HOME']+'/test.sock'); p=selectors.DefaultSelector(); p.register(s,1); p.register(0,1)\\nwhile True:\\n for key,_ in p.select():\\n  data=s.recv(65536) if key.fileobj is s else os.read(0,65536)\\n  if not data: raise SystemExit(0)\\n  if key.fileobj is s: os.write(1,data)\\n  else: s.sendall(data)"
 return subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def touch_activity(): Path(os.environ['HERMES_HOME']+'/activity').touch()
`);
  await fs.writeFile(path.join(pkg, 'lease.py'), `
import os, json
from pathlib import Path
HUMAN='human'
def file(): return Path(os.environ['HERMES_HOME'])/'lease.json'
def read(): return json.loads(file().read_text()) if file().exists() else {'holder':'agent','viewer_id':None}
def write(state):
 tmp=file().with_suffix('.'+str(os.getpid())+'.tmp'); tmp.write_text(json.dumps(state)); os.replace(tmp,file())
def acquire(viewer_id, **kwargs): write({'holder':HUMAN,'viewer_id':viewer_id})
def release(viewer_id=None, **kwargs):
 state=read()
 if not (kwargs.get('unless_human') and state['holder']==HUMAN) and (viewer_id is None or state['viewer_id']==viewer_id):
  state={'holder':'agent','viewer_id':None}; write(state)
 return type('Lease', (), state)()
def viewer_may_send_input(viewer_id): return read()['viewer_id']==viewer_id
`);
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const child = spawn(process.execPath, ['server/dist/index.js'], { env: {
    ...process.env, COMPUTER_BACKEND: 'hermes', USE_PRIMARY_ENGINE: '0',
    HOST: '127.0.0.1', PORT: String(port), DEV_LOGIN: '1', SESSION_SECRET: 'integration-test-only',
    XAI_API_KEY: '', ORGO_API_KEY: '', COMPOSIO_API_KEY: '', GROKBOT_NO_SCHEDULER: '1',
    DB_PATH: path.join(root, 'app.db'), ENGINES_DIR: path.join(root, 'engines'),
    LIBRARY_ROOT: path.join(root, 'files'), HERMES_HOME_PRIMARY: path.join(root, 'primary'),
    HERMES_BIN: '/bin/false', HERMES_PYTHON: process.env.TEST_PYTHON ?? '/usr/bin/python3', HERMES_SOURCE_DIR: source,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const sockets = new Set(); const viewers = new Set(); const servers = [];
  async function request(url, method = 'GET', body) {
    return fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  }
  try {
    await until(async () => fetch(base + '/api/health').then((r) => r.ok, () => false));
    assert.equal((await request('/api/computer')).status, 401);
    const login = await request('/api/auth/dev', 'POST', { email: 'local@example.test' });
    assert.equal(login.status, 200, logs); cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await (await request('/api/bots')).json();
    const bot = response.bots[0];
    assert.equal((await (await request('/api/computer')).json()).computer.status, 'running');
    assert.equal((await request('/api/voice/session', 'POST', { botId: bot.id })).status, 503);
    assert.equal((await request('/api/apps')).status, 200);
    assert.equal((await (await request(`/api/bots/${bot.id}/files`)).json()).status, 'ok');
    const home = path.join(root, 'engines', bot.id);
    await fs.mkdir(home, { recursive: true });
    if (sandbox) await fs.writeFile(path.join(home, 'sandbox'), '1');
    const received = [];
    const upstream = net.createServer((sock) => {
      sockets.add(sock); sock.on('close', () => sockets.delete(sock));
      sock.write('RFB 003.008\n'); let pending = Buffer.alloc(0); let stage = 0;
      sock.on('data', (data) => {
        pending = Buffer.concat([pending, data]);
        if (stage === 0 && pending.length >= 12) { pending = pending.subarray(12); stage++; sock.write(Buffer.from([1, 1])); }
        if (stage === 1 && pending.length >= 1) { pending = pending.subarray(1); stage++; sock.write(Buffer.alloc(4)); }
        if (stage === 2 && pending.length >= 1) {
          pending = pending.subarray(1); stage++;
          const init = Buffer.alloc(24); init.writeUInt16BE(640); init.writeUInt16BE(480, 2); sock.write(init);
        }
        if (stage === 3 && pending.length) { received.push(pending); pending = Buffer.alloc(0); }
      });
    });
    upstream.listen(path.join(home, 'test.sock')); servers.push(upstream); await once(upstream, 'listening');
    async function connect(mode) {
      const ws = new WebSocket(base.replace('http:', 'ws:') + `/api/bots/${bot.id}/screen?mode=${mode}`, ['binary'], { headers: { Cookie: cookie } });
      viewers.add(ws); let stage = 0;
      const ready = new Promise((resolve, reject) => {
        ws.on('error', reject); ws.on('message', () => {
          if (stage === 0) ws.send('RFB 003.008\n');
          else if (stage === 1) ws.send(Buffer.from([1]));
          else if (stage === 2) ws.send(Buffer.from([1]));
          else if (stage === 3) resolve(ws);
          stage++;
        });
      });
      return ready;
    }
    const frame = Buffer.from([3, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
    const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const watch = await connect('watch');
    watch.send(Buffer.concat([key, frame]));
    await until(() => received.length); assert.deepEqual(Buffer.concat(received), frame);
    watch.close(); await once(watch, 'close'); received.length = 0;
    const control = await connect('control');
    const leaseFile = path.join(home, 'lease.json');
    assert.equal(JSON.parse(await fs.readFile(leaseFile)).holder, 'human');
    control.send(key); await until(() => received.length); assert.deepEqual(Buffer.concat(received), key);
    control.close(); await once(control, 'close');
    await until(async () => JSON.parse(await fs.readFile(leaseFile)).holder === 'agent');
    // Concurrent viewers: a new controller owns the lease; the old viewer exits without releasing it.
    const old = await connect('control'); const oldClosed = once(old, 'close');
    const newer = await connect('control'); await oldClosed;
    assert.equal(JSON.parse(await fs.readFile(leaseFile)).holder, 'human');
    newer.close(); await once(newer, 'close');
    await until(async () => JSON.parse(await fs.readFile(leaseFile)).holder === 'agent');
  } catch (error) { error.message += '\nServer log:\n' + logs; throw error; }
  finally {
    for (const ws of viewers) ws.terminate();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
