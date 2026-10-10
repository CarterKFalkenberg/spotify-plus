import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync,
  symlinkSync, rmSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = resolve(root, '.local');
const buildDir = resolve(local, 'build');
const worktree = resolve(root, '.worktrees/build');
const branch = 'codex/build-mvp';
const tasks = JSON.parse(readFileSync(resolve(root, '.build/tasks.json'), 'utf8'));

function command(executable, args, cwd = root, options = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 30000,
    maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed${result.status === null ? ' or timed out' : ` (exit ${result.status})`}. See the private run log when present.`);
  return result.stdout?.trim() ?? '';
}

export function validateConfig(config) {
  const errors = [];
  for (const key of ['spotifyClientId', 'spotifyExpectedUserId', 'railwayProjectId',
    'railwayEnvironmentId', 'railwayWebServiceId', 'railwayWorkerServiceId', 'appUrl']) {
    if (typeof config[key] !== 'string' || !config[key] || config[key].includes('REPLACE')) errors.push(`Set ${key}`);
  }
  try { if (new URL(config.appUrl).protocol !== 'https:') errors.push('appUrl must use HTTPS'); }
  catch { errors.push('appUrl must be a valid HTTPS URL'); }
  if (!Number.isFinite(config.budgetMonthlyUsd) || config.budgetMonthlyUsd <= 0) errors.push('Set a positive budgetMonthlyUsd');
  const product = config.product ?? {};
  const enums = { playlistRetention: ['1_week', '1_month', '3_months', 'pinned'],
    returningDesktopHome: ['queue', 'groups_over_100'], disconnectPlaylists: ['keep', 'remove_unpinned', 'remove_all'],
    letterShortcuts: ['modified', 'escape_mode'] };
  for (const [key, values] of Object.entries(enums)) if (!values.includes(product[key])) errors.push(`Choose product.${key}`);
  if (!Number.isInteger(product.removedMetadataRetentionDays) || product.removedMetadataRetentionDays < 1) errors.push('Choose a positive metadata retention');
  for (const key of ['retainTagAssignments', 'regeneratePreservesSpotifyName']) if (typeof product[key] !== 'boolean') errors.push(`Choose product.${key}`);
  for (const key of ['productDecisionsAccepted', 'installDependencies', 'pushFeatureBranchesAndCreateDraftPR',
    'deployToThisRailwayProject', 'createAndRemoveDisposableTestPlaylists']) {
    if (config.authorization?.[key] !== true) errors.push(`Authorize ${key} to run the complete unattended build`);
  }
  return errors;
}

export function validateResult(result) {
  if (!['ready', 'blocked', 'needs_user'].includes(result.status) || typeof result.summary !== 'string' ||
    !Array.isArray(result.evidence) || !result.evidence.every(x => typeof x === 'string') ||
    !Array.isArray(result.blockers) || !result.blockers.every(x => typeof x === 'string')) {
    throw new Error('Invalid structured Codex result. Stage remains incomplete.');
  }
  if (result.status === 'ready' && (result.blockers.length || !result.evidence.length)) {
    throw new Error('A ready stage must have evidence and no unresolved blockers.');
  }
  return result;
}

export function validateReceipt(receipt, config, sha) {
  if (receipt.passed !== true || receipt.live !== true || receipt.buildSha !== sha ||
    receipt.deploymentUrl !== config.appUrl || !Array.isArray(receipt.evidence) || !receipt.evidence.length) {
    throw new Error('Stage verification did not prove local checks, live API behavior and the expected deployment.');
  }
}

function saveState(state) {
  const destination = resolve(buildDir, 'state.json');
  writeFileSync(`${destination}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${destination}.tmp`, destination);
}

function preflight() {
  if (!existsSync(resolve(local, 'config.json'))) return { errors: ['Run node scripts/init-local.mjs, then follow docs/SETUP.md'] };
  const config = JSON.parse(readFileSync(resolve(local, 'config.json'), 'utf8'));
  const errors = validateConfig(config);
  for (const [exe, args] of [['git', ['--version']], ['codex', ['--version']],
    ['gh', ['auth', 'status']], ['railway', ['status', '--json']], ['docker', ['info']]]) {
    try { command(exe, args, root, { env: runtimeEnv() }); }
    catch { errors.push(`Install/authenticate/configure ${exe} (see docs/SETUP.md)`); }
  }
  try { command('codex', ['login', 'status']); } catch { errors.push('Authenticate Codex CLI with codex login'); }
  if (Number(process.versions.node.split('.')[0]) < 22) errors.push('Node 22+ is needed for setup; use Node 24 LTS for the application');
  const grantPath = existsSync(resolve(local, 'spotify-bootstrap.json')) ? resolve(local, 'spotify-bootstrap.json') : resolve(local, 'spotify-bootstrap-consumed.json');
  if (!existsSync(grantPath)) errors.push('Run node scripts/connect-spotify.mjs for the one-time grant');
  else {
    const grant = JSON.parse(readFileSync(grantPath, 'utf8'));
    if (grant.clientId !== config.spotifyClientId || grant.userId !== config.spotifyExpectedUserId ||
      !grant.accountId || (!grant.refreshToken && !grant.consumedAt) || !grant.authorizedAt) errors.push('Bootstrap grant does not match this configuration; reconnect');
  }
  if (!existsSync(resolve(local, 'runtime-keys.json'))) errors.push('Run node scripts/init-local.mjs to generate runtime keys');
  return { config, errors };
}

function runtimeEnv() {
  const env = { ...process.env };
  const tokenFile = resolve(local, 'railway-token');
  if (existsSync(tokenFile)) { env.RAILWAY_TOKEN = readFileSync(tokenFile, 'utf8').trim(); delete env.RAILWAY_API_TOKEN; }
  return env;
}

async function run() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('scripts/build [--check | --status | --one]\nDefault: resume all stages. --check performs setup checks without building. --one stops after one verified stage.'); return;
  }
  if (args.some(arg => !['--check', '--status', '--one'].includes(arg))) throw new Error('Unknown flag; run scripts/build --help');
  if (args.includes('--status')) {
    console.log(existsSync(resolve(buildDir, 'state.json')) ? readFileSync(resolve(buildDir, 'state.json'), 'utf8') : 'No build has started.'); return;
  }
  const { config, errors } = preflight();
  if (errors.length) throw new Error('Setup is incomplete:\n' + errors.map(e => `- ${e}`).join('\n'));
  if (args.includes('--check')) { console.log('Local setup checks passed. Live Spotify/deployment behavior is still the first build stage.'); return; }
  if (command('git', ['status', '--porcelain'])) throw new Error('Commit or preserve changes in the source checkout before launching. Main will not be modified.');
  mkdirSync(buildDir, { recursive: true, mode: 0o700 });
  const lock = resolve(buildDir, 'lock');
  try { mkdirSync(lock); }
  catch { throw new Error('Another build may be running. See docs/AUTONOMY.md for interrupted-run recovery.'); }
  writeFileSync(resolve(lock, 'pid'), String(process.pid));
  try {
    if (!existsSync(worktree)) {
      mkdirSync(dirname(worktree), { recursive: true });
      const refs = command('git', ['branch', '--list', branch]);
      command('git', refs ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
    }
    if (command('git', ['branch', '--show-current'], worktree) !== branch) throw new Error('Build worktree is not on codex/build-mvp.');
    const sharedLocal = resolve(worktree, '.local');
    if (!existsSync(sharedLocal)) symlinkSync(local, sharedLocal, 'dir');
    if (realpathSync(sharedLocal) !== realpathSync(local)) throw new Error('Build worktree .local points to different configuration.');
    const stateFile = resolve(buildDir, 'state.json');
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) :
      { baseSha: command('git', ['rev-parse', 'HEAD'], worktree), completed: [], lastResult: null };
    command('git', ['merge-base', '--is-ancestor', state.baseSha, 'HEAD'], worktree);
    for (const done of state.completed) command('git', ['merge-base', '--is-ancestor', done.sha, 'HEAD'], worktree);
    for (const task of tasks.filter(t => !state.completed.some(done => done.id === t.id))) {
      let finished = false;
      let repair = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`Building ${task.title} (attempt ${attempt}/3).`);
        const runId = `${Date.now()}-${task.id}-${attempt}`;
        const resultFile = resolve(buildDir, `${runId}.json`);
        const prompt = `Work through the current milestone completely in this worktree. Read AGENTS.md and the docs first.\n` +
          `This is the human's configured build run. Read .local/config.json for ratified product decisions and scoped authorizations. Never print secret files.\n` +
          `Current milestone:\n${JSON.stringify(task, null, 2)}\n` +
          `Prior result:\n${JSON.stringify(state.lastResult)}\n${repair}\n` +
          `Implement and run appropriate checks; repair failures. Commit on ${branch}, deploy that exact commit, and verify live behavior. ` +
          `Create scripts/check and scripts/verify-stage.mjs if absent. The latter takes the stage ID as its argument and emits only JSON: ` +
          `{passed:true,live:true,buildSha:<git HEAD>,deploymentUrl:<config appUrl>,evidence:[<redacted assertions>]}. ` +
          `It must run assertions, not echo a saved success file. /healthz must report the deployed buildSha. ` +
          `Keep real Spotify content out of model outputs and browser screenshots. Read API data inside assertion scripts only. ` +
          `Use Railway CLI from this project only; no account changes or unrelated resources. ` +
          `No merge to main. No subagents. Return ready only with a clean committed tree, passing checks and live deployment. ` +
          `Use blocked/needs_user for unresolved credentials, review denials, platform behavior or required manual actions; do not claim MVP acceptance before the real phone test.`;
        const logFile = resolve(buildDir, `${runId}.log`);
        const result = spawnSync('codex', ['--search', '--approve-for-me', 'exec', '-C', worktree, '--add-dir', local,
          '--output-schema', resolve(root, '.build/result.schema.json'), '-o', resultFile, '-'],
          { input: prompt, encoding: 'utf8', env: runtimeEnv(), timeout: 4 * 60 * 60 * 1000,
            maxBuffer: 32 * 1024 * 1024 });
        writeFileSync(logFile, `${result.stdout ?? ''}\n${result.stderr ?? ''}`, { mode: 0o600 });
        if (result.error || result.status !== 0 || !existsSync(resultFile)) {
          state.lastResult = { status: 'blocked', summary: 'Codex did not finish successfully.', evidence: [], blockers: ['Inspect the private run log; rerun after resolving the interruption.'] };
          saveState(state); throw new Error(`Codex stopped. Progress preserved; private log: ${logFile}`);
        }
        state.lastResult = validateResult(JSON.parse(readFileSync(resultFile, 'utf8')));
        saveState(state);
        if (state.lastResult.status !== 'ready') {
          console.log(state.lastResult.summary);
          console.log(state.lastResult.blockers.join('\n'));
          process.exitCode = 2; return;
        }
        try {
          if (command('git', ['branch', '--show-current'], worktree) !== branch) throw new Error('Agent changed the build branch.');
          if (command('git', ['status', '--porcelain'], worktree)) throw new Error('Implementation is not fully committed.');
          command('sh', ['scripts/check'], worktree, { env: runtimeEnv(), timeout: 10 * 60 * 1000 });
          const sha = command('git', ['rev-parse', 'HEAD'], worktree);
          const receipt = JSON.parse(command('node', ['scripts/verify-stage.mjs', task.id], worktree,
            { env: runtimeEnv(), timeout: 10 * 60 * 1000 }));
          validateReceipt(receipt, config, sha);
          const healthResponse = await fetch(new URL('/healthz', config.appUrl), { signal: AbortSignal.timeout(20000) });
          if (!healthResponse.ok || (await healthResponse.json()).buildSha !== sha) throw new Error('Deployed health check does not match this commit.');
          if (command('git', ['status', '--porcelain'], worktree)) throw new Error('Checks modified tracked files; commit and redeploy.');
          state.completed.push({ id: task.id, sha, verifiedAt: new Date().toISOString(), evidence: receipt.evidence });
          saveState(state); finished = true;
          console.log(`Verified ${task.id}.`); break;
        } catch (error) { repair = `Independent verification failed: ${error.message}. Repair the actual failure before returning ready.`; }
      }
      if (!finished) {
        state.lastResult = { status: 'blocked', summary: 'Independent checks failed three times.', evidence: [], blockers: [repair] };
        saveState(state); throw new Error('Stage remains incomplete after three repair attempts. Work is preserved.');
      }
      if (args.includes('--one')) return;
    }
    console.log('All software stages verified. Review codex/build-mvp and perform the real phone/desktop acceptance checks in docs/SETUP.md.');
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
