import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = process.env.LOCAL_VOICE_HOME ?? path.join(os.homedir(), '.t3-bots/voice');
await fs.mkdir(path.join(root, 'models'), { recursive: true, mode: 0o700 });
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Local voice setup failed (${code})`)));
});
const python = path.join(root, 'venv/bin/python');
try { await fs.access(python); } catch { await run(process.env.UV_BIN ?? 'uv', ['venv', '--python', '3.12', path.join(root, 'venv')]); }
await run(process.env.UV_BIN ?? 'uv', ['pip', 'install', '--python', python, '-r', fileURLToPath(new URL('./local-voice-requirements.txt', import.meta.url))]);
for (const [name, digest] of [
  ['kokoro-v1.0.int8.onnx', 'ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c'],
  ['voices-v1.0.bin', 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'],
]) {
  const file = path.join(root, 'models', name);
  const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  if (await hash(file).then(value => value === digest, () => false)) continue;
  process.stdout.write(`Downloading ${name}\n`);
  const response = await fetch('https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/' + name);
  if (!response.ok || !response.body) throw new Error(`Could not download ${name}`);
  const temp = file + '.part';
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { mode: 0o600 }));
  if (await hash(temp) !== digest) { await fs.unlink(temp); throw new Error(`Checksum mismatch for ${name}`); }
  await fs.rename(temp, file);
}
await run(python, ['-c', "from faster_whisper.utils import download_model; import os; download_model('base.en', output_dir=os.path.join(os.environ['LOCAL_VOICE_HOME'],'models','whisper-base.en'))"]);
process.stdout.write('Local voice models are ready.\n');
