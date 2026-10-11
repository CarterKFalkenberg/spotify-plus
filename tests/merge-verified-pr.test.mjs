import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMergeable, mergeVerifiedPR } from '../scripts/merge-verified-pr.mjs';

const sha = 'verified-head';
const branch = 'codex/build-mvp';
const ready = () => ({ number: 1, url: 'https://github.com/CarterKFalkenberg/spotify-plus/pull/1',
  headRefOid: sha, headRefName: branch, baseRefName: 'main', isCrossRepository: false,
  state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', reviewDecision: '',
  statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }] });

test('merge gate rejects unverified heads, drafts, wrong targets and blocked reviews', () => {
  for (const change of [{ headRefOid: 'new-head' }, { headRefName: 'other' }, { baseRefName: 'other' },
    { isCrossRepository: true }, { isDraft: true }, { mergeStateStatus: 'BEHIND' },
    { reviewDecision: 'CHANGES_REQUESTED' }, { reviewDecision: 'REVIEW_REQUIRED' }]) {
    assert.throws(() => assertMergeable({ ...ready(), ...change }, sha, branch));
  }
  assert.doesNotThrow(() => assertMergeable(ready(), sha, branch));
});

test('merge gate requires successful verify and rejects pending or failed checks', () => {
  for (const checks of [[], [{ name: 'verify', status: 'IN_PROGRESS' }],
    [{ name: 'verify', status: 'COMPLETED', conclusion: 'SKIPPED' }],
    [...ready().statusCheckRollup, { name: 'integration', status: 'COMPLETED', conclusion: 'FAILURE' }],
    [...ready().statusCheckRollup, { __typename: 'StatusContext', context: 'external', state: 'PENDING' }]]) {
    assert.throws(() => assertMergeable({ ...ready(), statusCheckRollup: checks }, sha, branch));
  }
});

test('merge uses an expected head and reconciles a lost successful response', () => {
  let merged = false; const calls = [];
  const result = mergeVerifiedPR(branch, sha, args => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify([ready()]);
    if (args[1] === 'view') return JSON.stringify(merged ? { ...ready(), state: 'MERGED', mergeCommit: { oid: 'merge-sha' } } : ready());
    assert.equal(args[1], 'merge'); merged = true; throw new Error('Lost response');
  });
  assert.equal(result.mergeSha, 'merge-sha');
  const command = calls.find(args => args[1] === 'merge');
  assert.equal(command.at(-1), sha);
  assert.ok(command.includes('--match-head-commit'));
  assert.ok(!command.includes('--admin'));
});

test('merge failure cannot record a completed milestone', () => {
  assert.throws(() => mergeVerifiedPR(branch, sha, args => {
    if (args[1] === 'list') return JSON.stringify([ready()]);
    if (args[1] === 'view') return JSON.stringify(ready());
    throw new Error('Permission denied');
  }), /Permission denied/);
});

test('an already merged verified head resumes without a second merge', () => {
  const result = mergeVerifiedPR(branch, sha, args => {
    if (args[1] === 'list') return JSON.stringify([{ ...ready(), state: 'MERGED' }]);
    assert.equal(args[1], 'view');
    return JSON.stringify({ ...ready(), state: 'MERGED', mergeCommit: { oid: 'merge-sha' } });
  });
  assert.equal(result.mergeSha, 'merge-sha');
});
