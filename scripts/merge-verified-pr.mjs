const repository = 'CarterKFalkenberg/spotify-plus';

export function assertMergeable(pr, sha, branch) {
  if (pr.headRefOid !== sha || pr.headRefName !== branch || pr.baseRefName !== 'main' || pr.isCrossRepository) {
    throw new Error('PR does not match the verified head, branch and repository base.');
  }
  if (pr.state === 'MERGED' && pr.mergeCommit?.oid) return;
  if (pr.state !== 'OPEN' || pr.isDraft || pr.mergeStateStatus !== 'CLEAN' ||
      ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision)) {
    throw new Error('PR is not ready to merge under the repository rules.');
  }
  const checks = pr.statusCheckRollup ?? [];
  const success = check => check.__typename === 'StatusContext' ? check.state === 'SUCCESS' :
    check.status === 'COMPLETED' && check.conclusion === 'SUCCESS';
  if (!checks.some(check => (check.name ?? check.context) === 'verify' && success(check)) ||
      checks.some(check => !success(check) && !['SKIPPED', 'NEUTRAL'].includes(check.conclusion))) {
    throw new Error('The verify check and all other blocking checks must pass on this PR head.');
  }
}

// The caller runs local/live verification first. This final gate checks GitHub's
// current state and binds the merge to the same head SHA. It never uses --admin.
export function mergeVerifiedPR(branch, sha, run) {
  const list = JSON.parse(run(['pr', 'list', '--repo', repository, '--head', branch, '--base', 'main',
    '--state', 'all', '--limit', '100', '--json', 'number,headRefOid,state']));
  const matches = list.filter(pr => pr.headRefOid === sha && ['OPEN', 'MERGED'].includes(pr.state));
  if (matches.length !== 1) throw new Error('Expected one PR for this verified milestone head.');
  const number = String(matches[0].number);
  const read = () => JSON.parse(run(['pr', 'view', number, '--repo', repository, '--json',
    'number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,mergeCommit']));
  let pr = read();
  assertMergeable(pr, sha, branch);
  if (pr.state !== 'MERGED') {
    let mergeError;
    try { run(['pr', 'merge', number, '--repo', repository, '--merge', '--match-head-commit', sha]); }
    catch (error) { mergeError = error; }
    // Resolve a lost merge response by reading reality before retrying.
    pr = read();
    assertMergeable(pr, sha, branch);
    if (pr.state !== 'MERGED' || !pr.mergeCommit?.oid) throw mergeError ?? new Error('GitHub has not confirmed the merge.');
  }
  return { number: pr.number, url: pr.url, headSha: sha, mergeSha: pr.mergeCommit.oid };
}
