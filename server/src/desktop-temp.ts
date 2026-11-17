import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function desktopTempEnv(home: string): Record<string, string> {
  const id = crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 12);
  const cached = path.join(os.homedir(), '.cache', 'hq', id);
  const root = cached.length <= 50 ? cached : path.join('/tmp', `hq-${process.getuid?.() ?? 'local'}-${id}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('The bot browser temporary directory is not private');
  fs.chmodSync(root, 0o700);
  return { TMPDIR: root, TMP: root, TEMP: root };
}
