import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfig, validateResult, validateReceipt } from '../scripts/build.mjs';
import { sameState, bindAccount, SCOPES } from '../scripts/connect-spotify.mjs';

const example = JSON.parse(readFileSync(new URL('../.build/config.example.json', import.meta.url), 'utf8'));
export function validConfig() {
  const config = structuredClone(example);
  for (const key of ['spotifyClientId', 'spotifyExpectedUserId', 'railwayProjectId',
    'railwayEnvironmentId', 'railwayWebServiceId', 'railwayWorkerServiceId']) config[key] = `test-${key}`;
  config.appUrl = 'https://tagger.example.test';
  for (const key of Object.keys(config.authorization)) config.authorization[key] = true;
  return config;
}

test('setup cannot silently accept placeholders or unratified authorization', () => {
  const errors = validateConfig(example);
  assert.ok(errors.some(e => e.includes('productDecisionsAccepted')));
  assert.ok(errors.some(e => e.includes('spotifyClientId')));
  assert.deepEqual(validateConfig(validConfig()), []);
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
  const receipt = { passed: true, live: true, buildSha: 'abc', deploymentUrl: config.appUrl, evidence: ['assertion passed'] };
  assert.doesNotThrow(() => validateReceipt(receipt, config, 'abc'));
  assert.throws(() => validateReceipt({ ...receipt, live: false }, config, 'abc'));
  assert.throws(() => validateReceipt(receipt, config, 'def'));
  assert.throws(() => validateReceipt({ ...receipt, deploymentUrl: 'https://other.example.test' }, config, 'abc'));
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
