import { mkdirSync, existsSync, copyFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local');
mkdirSync(local, { recursive: true, mode: 0o700 });
chmodSync(local, 0o700);
const config = resolve(local, 'config.json');
if (!existsSync(config)) copyFileSync(resolve(root, '.build/config.example.json'), config);
chmodSync(config, 0o600);
const keys = resolve(local, 'runtime-keys.json');
if (!existsSync(keys)) {
  writeFileSync(keys, JSON.stringify({
    sessionSecret: randomBytes(32).toString('base64'),
    tokenEncryptionKey: randomBytes(32).toString('base64'),
    annotationKey: randomBytes(32).toString('base64')
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
console.log('Prepared ignored .local/config.json and runtime keys without overwriting existing values.');
console.log('Edit config.json using docs/SETUP.md, then run node scripts/connect-spotify.mjs.');
