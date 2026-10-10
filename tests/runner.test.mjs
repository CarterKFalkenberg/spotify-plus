import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('..', import.meta.url));
const template = JSON.parse(readFileSync(resolve(source, '.build/config.example.json'), 'utf8'));

function fixture(mode = 'ready') {
  const root = mkdtempSync(resolve(tmpdir(), 'tagger-runner-test-'));
  for (const entry of ['scripts', '.build', '.gitignore']) cpSync(resolve(source, entry), resolve(root, entry), { recursive: true });
  mkdirSync(resolve(root, '.local'), { mode: 0o700 });
  const config = structuredClone(template);
  for (const key of ['spotifyClientId', 'spotifyExpectedUserId', 'railwayProjectId',
    'railwayEnvironmentId', 'railwayWebServiceId', 'railwayWorkerServiceId']) config[key] = `test-${key}`;
  config.appUrl = 'https://tagger.example.test';
  for (const key of Object.keys(config.authorization)) config.authorization[key] = true;
  writeFileSync(resolve(root, '.local/config.json'), JSON.stringify(config));
  writeFileSync(resolve(root, '.local/runtime-keys.json'), '{}');
  writeFileSync(resolve(root, '.local/spotify-bootstrap.json'), JSON.stringify({
    clientId: config.spotifyClientId, userId: config.spotifyExpectedUserId, accountId: 'synthetic',
    refreshToken: 'SYNTHETIC_TEST_TOKEN', authorizedAt: '2026-10-10T00:00:00Z'
  }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Runner Test']); git(['config', 'user.email', 'runner@example.test']);
  git(['add', '.']); git(['commit', '-m', 'fixture']);
  const base = git(['rev-parse', 'HEAD']);
  const bin = resolve(root, '.local/bin'); mkdirSync(bin);
  const fake = `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2), root = process.env.TAGGER_TEST_ROOT;
if (!args.includes('exec')) { console.log('authenticated test tool'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
const id = input.match(/\"id\": \"([^\"]+)\"/)[1];
const log = path.join(root, '.local/calls'); fs.appendFileSync(log, id + '\\n');
const out = args[args.indexOf('-o') + 1];
if (process.env.TAGGER_TEST_MODE === 'blocked') {
 fs.writeFileSync(out, JSON.stringify({status:'needs_user',summary:'Browser consent required',evidence:[],blockers:['Complete consent']})); process.exit(0);
}
const cwd = args[args.indexOf('-C') + 1];
fs.writeFileSync(path.join(cwd, 'implemented.txt'), fs.readFileSync(log, 'utf8'));
fs.writeFileSync(path.join(cwd, 'scripts/check'), '#!/bin/sh\\nexit 0\\n');
fs.writeFileSync(path.join(cwd, 'scripts/verify-stage.mjs'), \`import fs from 'node:fs'; import cp from 'node:child_process'; const config=JSON.parse(fs.readFileSync('.local/config.json')); const sha=cp.execFileSync('git',['rev-parse','HEAD']).toString().trim(); console.log(JSON.stringify({passed:process.env.TAGGER_TEST_MODE!=='fail',live:true,buildSha:sha,deploymentUrl:config.appUrl,evidence:['synthetic fixture assertion']}));\`);
cp.execFileSync('git', ['add', '.'], {cwd}); cp.execFileSync('git',['commit','-m','synthetic '+id], {cwd});
fs.writeFileSync(out, JSON.stringify({status:'ready',summary:'synthetic stage',evidence:['synthetic assertion'],blockers:[]}));
`;
  for (const exe of ['codex', 'gh', 'railway', 'docker']) writeFileSync(resolve(bin, exe), fake, { mode: 0o755 });
  const preload = resolve(root, '.local/mock-fetch.mjs');
  writeFileSync(preload, `import cp from 'node:child_process'; globalThis.fetch=async()=>({ok:true,json:async()=>({buildSha:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:process.env.TAGGER_TEST_ROOT+'/.worktrees/build'}).toString().trim()})});`);
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TAGGER_TEST_ROOT: root,
    TAGGER_TEST_MODE: mode, NODE_OPTIONS: `--import=${preload}` };
  const run = args => spawnSync(process.execPath, ['scripts/build.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  return { root, base, git, run };
}

test('runner completes stages, preserves main, ignores secrets, and resumes without extra work', () => {
  const f = fixture();
  const first = f.run([]); assert.equal(first.status, 0, first.stderr);
  const state = JSON.parse(readFileSync(resolve(f.root, '.local/build/state.json')));
  assert.equal(state.completed.length, 4);
  assert.equal(f.git(['rev-parse', 'main']), f.base);
  assert.equal(f.git(['status', '--porcelain']), '');
  const tracked = execFileSync('git', ['ls-files'], { cwd: resolve(f.root, '.worktrees/build') }).toString();
  assert.ok(!tracked.includes('.local'));
  const calls = readFileSync(resolve(f.root, '.local/calls'), 'utf8');
  const again = f.run([]); assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(resolve(f.root, '.local/calls'), 'utf8'), calls);
});

test('needs-user results preserve unfinished state and release the lock', () => {
  const f = fixture('blocked'); const result = f.run([]);
  assert.equal(result.status, 2, result.stderr);
  const state = JSON.parse(readFileSync(resolve(f.root, '.local/build/state.json')));
  assert.equal(state.completed.length, 0);
  assert.equal(state.lastResult.status, 'needs_user');
  assert.equal(existsSync(resolve(f.root, '.local/build/lock')), false);
});

test('independent verification failures trigger three repairs and never advance', () => {
  const f = fixture('fail'); const result = f.run([]);
  assert.equal(result.status, 1);
  const state = JSON.parse(readFileSync(resolve(f.root, '.local/build/state.json')));
  assert.equal(state.completed.length, 0);
  assert.equal(state.lastResult.status, 'blocked');
  assert.equal(readFileSync(resolve(f.root, '.local/calls'), 'utf8').trim().split('\n').length, 3);
  assert.equal(existsSync(resolve(f.root, '.local/build/lock')), false);
});

test('--one stops after a verified stage; --status does not invoke Codex', () => {
  const f = fixture(); const result = f.run(['--one']); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(resolve(f.root, '.local/build/state.json'))).completed.length, 1);
  const calls = readFileSync(resolve(f.root, '.local/calls'), 'utf8');
  const status = f.run(['--status']); assert.equal(status.status, 0);
  assert.equal(readFileSync(resolve(f.root, '.local/calls'), 'utf8'), calls);
});

test('a concurrent-run lock prevents a second Codex build', () => {
  const f = fixture(); mkdirSync(resolve(f.root, '.local/build/lock'), { recursive: true });
  const result = f.run([]);
  assert.equal(result.status, 1); assert.match(result.stderr, /Another build/);
  assert.equal(existsSync(resolve(f.root, '.local/calls')), false);
});

test('local initialization is private and never overwrites keys or decisions', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tagger-init-test-'));
  cpSync(resolve(source, 'scripts'), resolve(root, 'scripts'), { recursive: true });
  cpSync(resolve(source, '.build'), resolve(root, '.build'), { recursive: true });
  execFileSync(process.execPath, ['scripts/init-local.mjs'], { cwd: root });
  const keyPath = resolve(root, '.local/runtime-keys.json'); const oldKeys = readFileSync(keyPath, 'utf8');
  const configPath = resolve(root, '.local/config.json'); writeFileSync(configPath, '{"custom":"preserved"}');
  execFileSync(process.execPath, ['scripts/init-local.mjs'], { cwd: root });
  assert.equal(readFileSync(keyPath, 'utf8'), oldKeys);
  assert.equal(readFileSync(configPath, 'utf8'), '{"custom":"preserved"}');
});
