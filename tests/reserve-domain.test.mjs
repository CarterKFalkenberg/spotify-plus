import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(approved = true) {
  const root = mkdtempSync(resolve(tmpdir(), 'tagger-domain-test-'));
  mkdirSync(resolve(root, 'scripts')); mkdirSync(resolve(root, '.local/bin'), { recursive: true });
  copyFileSync(new URL('../scripts/reserve-domain.mjs', import.meta.url), resolve(root, 'scripts/reserve-domain.mjs'));
  writeFileSync(resolve(root, '.local/config.json'), JSON.stringify({ railwayProjectId: 'test-project',
    railwayEnvironmentId: 'test-environment', railwayWebServiceId: 'test-web',
    authorization: { deployToThisRailwayProject: approved } }));
  writeFileSync(resolve(root, '.local/railway-token'), 'SYNTHETIC_PRIVATE_TOKEN');
  writeFileSync(resolve(root, '.local/bin/railway'), `#!/usr/bin/env node
const fs=require('node:fs');fs.appendFileSync(process.env.TAGGER_TEST_ROOT+'/.local/commands',JSON.stringify({args:process.argv.slice(2),hasToken:!!process.env.RAILWAY_TOKEN})+'\\n');`, { mode: 0o755 });
  const run = () => spawnSync(process.execPath, ['scripts/reserve-domain.mjs'], { cwd: root,
    env: { ...process.env, PATH: resolve(root, '.local/bin') + ':' + process.env.PATH, TAGGER_TEST_ROOT: root }, encoding: 'utf8' });
  return { root, run };
}

test('domain setup requires explicit project deployment authorization', () => {
  const f = fixture(false); const result = f.run();
  assert.equal(result.status, 1); assert.equal(existsSync(resolve(f.root, '.local/commands')), false);
});

test('setup upload has only the stub files and scopes every CLI command', () => {
  const f = fixture(); const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(resolve(f.root, '.local/commands'), 'utf8');
  const commands = log.trim().split('\n').map(JSON.parse); assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.ok(command.args.includes('test-project')); assert.ok(command.args.includes('test-environment'));
    assert.ok(command.args.includes('test-web')); assert.equal(command.hasToken, true);
  }
  assert.ok(!log.includes('SYNTHETIC_PRIVATE_TOKEN'));
});

test('unexpected stub files cannot be uploaded by the no-gitignore command', () => {
  const f = fixture(); mkdirSync(resolve(f.root, '.local/domain-stub'));
  writeFileSync(resolve(f.root, '.local/domain-stub/private.txt'), 'synthetic');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /unexpected files/);
  assert.equal(existsSync(resolve(f.root, '.local/commands')), false);
});

test('domain setup refuses to overwrite a build that has already started', () => {
  const f = fixture(); mkdirSync(resolve(f.root, '.local/build'));
  writeFileSync(resolve(f.root, '.local/build/state.json'), '{}');
  const result = f.run(); assert.equal(result.status, 1);
  assert.equal(existsSync(resolve(f.root, '.local/commands')), false);
});
