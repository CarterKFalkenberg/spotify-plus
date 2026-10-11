import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { validateConfig, validateResult, validateReceipt, runtimeEnv } from '../scripts/build.mjs';
import { sameState, bindAccount, SCOPES } from '../scripts/connect-spotify.mjs';

const example = JSON.parse(readFileSync(new URL('../.build/config.example.json', import.meta.url), 'utf8'));
export function validConfig() {
  const config = structuredClone(example);
  for (const key of ['spotifyClientId', 'spotifyExpectedUserId', 'supabaseProjectRef',
    'cloudflareAccountId', 'cloudflareWorkerName']) config[key] = `test-${key}`;
  config.appUrl = 'https://tagger.example.test';
  for (const key of Object.keys(config.authorization)) config.authorization[key] = true;
  return config;
}

test('accepted product defaults do not authorize deployment or unresolved setup', () => {
  const errors = validateConfig(example);
  assert.equal(example.authorization.productDecisionsAccepted, true);
  assert.ok(errors.some(e => e.includes('deployToConfiguredFreeHosting')));
  assert.ok(errors.some(e => e.includes('spotifyClientId')));
  assert.deepEqual(validateConfig(validConfig()), []);
});

test('zero budget accepts only the selected free plans and rejects stale paid setup', () => {
  const config = validConfig(); assert.equal(config.budgetMonthlyUsd, 0);
  for (const budget of [20, -1, '0', null]) {
    assert.ok(validateConfig({ ...config, budgetMonthlyUsd: budget }).some(e => e.includes('budgetMonthlyUsd')));
  }
  for (const key of ['supabasePlan', 'cloudflarePlan']) {
    assert.ok(validateConfig({ ...config, hosting: { ...config.hosting, [key]: 'paid' } }).some(e => e.includes('paid upgrades')));
  }
  assert.ok(validateConfig({ ...config, railwayProjectId: 'old' }).some(e => e.includes('obsolete Railway')));
});

test('hosting credentials stay in the child environment and obsolete provider credentials are dropped', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tagger-env-test-'));
  writeFileSync(resolve(directory, 'supabase-access-token'), 'SYNTHETIC_TOKEN\n');
  writeFileSync(resolve(directory, 'supabase-db-password'), 'SYNTHETIC_PASSWORD\n');
  writeFileSync(resolve(directory, 'config.json'), JSON.stringify({ cloudflareAccountId: 'configured-account' }));
  const env = runtimeEnv(directory, { RAILWAY_TOKEN: 'obsolete', RAILWAY_API_TOKEN: 'obsolete', CLOUDFLARE_ACCOUNT_ID: 'other-account' });
  assert.equal(env.SUPABASE_ACCESS_TOKEN, 'SYNTHETIC_TOKEN');
  assert.equal(env.SUPABASE_DB_PASSWORD, 'SYNTHETIC_PASSWORD');
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'configured-account');
  assert.equal(env.RAILWAY_TOKEN, undefined); assert.equal(env.RAILWAY_API_TOKEN, undefined);
});

test('invalid product settings and insecure hosted URLs are rejected', () => {
  const config = validConfig(); config.product.letterShortcuts = 'plain'; config.appUrl = 'http://example.test';
  assert.ok(validateConfig(config).some(e => e.includes('letterShortcuts')));
  assert.ok(validateConfig(config).some(e => e.includes('HTTPS')));
});

test('saying ready without evidence or with blockers never completes a stage', () => {
  assert.throws(() => validateResult({ status: 'ready', summary: 'done', evidence: [], blockers: [] }));
  assert.throws(() => validateResult({ status: 'ready', summary: 'done', evidence: ['test'], blockers: ['login'] }));
  assert.throws(() => validateResult({ status: 'done', summary: 'done', evidence: ['test'], blockers: [] }));
});

test('verification rejects stale deployment, simulated live status and mismatched host', () => {
  const config = validConfig();
  const receipt = { passed: true, live: true, buildSha: 'abc', deploymentUrl: config.appUrl,
    deployments: { frontend: 'abc', api: 'abc', jobs: 'abc' }, hostingPlans: { supabase: 'free', cloudflare: 'free' }, evidence: ['assertion passed'] };
  assert.doesNotThrow(() => validateReceipt(receipt, config, 'abc'));
  assert.throws(() => validateReceipt({ ...receipt, live: false }, config, 'abc'));
  assert.throws(() => validateReceipt(receipt, config, 'def'));
  assert.throws(() => validateReceipt({ ...receipt, deploymentUrl: 'https://other.example.test' }, config, 'abc'));
  assert.throws(() => validateReceipt({ ...receipt, deployments: { ...receipt.deployments, jobs: 'old' } }, config, 'abc'));
  assert.throws(() => validateReceipt({ ...receipt, hostingPlans: { supabase: 'pro', cloudflare: 'free' } }, config, 'abc'));
});

test('OAuth state and owner binding reject mismatches and missing immutable identity', () => {
  assert.equal(sameState('test-state', 'test-state'), true);
  assert.equal(sameState('wrong', 'test-state'), false);
  assert.equal(sameState(null, 'test-state'), false);
  assert.throws(() => bindAccount({ id: 'other', account_id: 'immutable' }, 'owner'), /Wrong Spotify/);
  assert.throws(() => bindAccount({ id: 'owner' }, 'owner'), /account_id/);
  assert.equal(bindAccount({ id: 'owner', account_id: 'immutable' }, 'owner'), 'immutable');
});

test('bootstrap scope set excludes profile, playback and follow permissions', () => {
  assert.equal(SCOPES.length, 5);
  assert.ok(SCOPES.every(x => !x.startsWith('user-read') && !x.includes('playback') && !x.includes('follow')));
});
