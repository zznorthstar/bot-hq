#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const envFile = new URL('../.env', import.meta.url);
const template = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
const content = template.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`);
try {
  await fs.writeFile(envFile, content, { flag: 'wx', mode: 0o600 });
  console.log('Created private .env for local Hermes desktops. Read docs/LOCAL_SETUP.md for prerequisites and voice choices.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('.env already exists; left it unchanged. Set COMPUTER_BACKEND=hermes there to use local desktops.');
  process.exitCode = 1;
}
