import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Exercise the actual registry/lock/recovery code in an isolated process with
// synthetic credentials and no network permission. Private operator files never
// enter this fixture or its stdout.
test("review proof registry recovery never replays ambiguous fixture mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spotify-review-proof-"));
  try {
    const root = process.cwd();
    const imports = (path) =>
      JSON.stringify(pathToFileURL(join(root, path)).href);
    const code = `
import { runReviewProof, reviewProofFailure, writeReviewRegistry } from ${imports("scripts/live/review-proof.ts")};
import { ServiceDatabase } from ${imports("supabase/functions/_shared/database.ts")};
import { OwnerTokens } from ${imports("supabase/functions/_shared/tokens.ts")};
import { ownerFingerprint } from ${imports("supabase/functions/_shared/crypto.ts")};
const path = ${JSON.stringify(join(dir, "registry.json"))};
const binding = btoa('s'.repeat(32));
const account = 'synthetic-account';
const fingerprint = await ownerFingerprint(account, binding);
const r = { version:1, operation:crypto.randomUUID(), epoch:2, ownerFingerprint:fingerprint, playlistId:'p'.repeat(22), state:'created', pending:'append' };
const input = { origin:'https://synthetic.supabase.co', serviceKey:'synthetic', clientId:'synthetic', encryptionKey:binding, bindingKey:binding, ownerFingerprint:fingerprint, epoch:2, projectRef:'a'.repeat(20), managementToken:'synthetic', registryPath:path, authorized:true };
ServiceDatabase.prototype.rpc = (name) => Promise.resolve(name === 'app_pacing_acquire' ? {granted:true,retryAfterMs:0} : true);
OwnerTokens.prototype.getAccessToken = () => Promise.resolve('synthetic-token');
const playlist = () => ({ id:r.playlistId, name:'Synthetic', description:'[Tagger review proof '+r.operation+'] Disposable', owner:{id:'legacy', account_id:account}, collaborative:false, public:false, snapshot_id:'synthetic-snapshot', items:{total:0} });
let present = true, deletes = 0, posts = 0, loseCleanup = false, owner = account;
const responses = [];
globalThis.fetch = async (raw, init) => {
 const url = new URL(String(raw)); const method = init?.method ?? 'GET';
 if (method === 'POST') { posts++; throw new Error('Unexpected POST'); }
 if (url.pathname === '/v1/me') return Response.json({id:'legacy', account_id:owner});
 if (url.pathname === '/v1/me/playlists') return Response.json({items:present?[playlist()]:[], total:present?1:0, offset:0, limit:50, next:null});
 if (url.pathname === '/v1/me/library/contains') return Response.json([present]);
 if (url.pathname === '/v1/me/library' && method === 'DELETE') { deletes++; present=false; if(loseCleanup) throw new Error('Synthetic lost response'); return new Response(null,{status:204}); }
 if (url.pathname === '/v1/playlists/'+r.playlistId) return Response.json(playlist());
 throw new Error('Unexpected request');
};
async function reset(value) { await writeReviewRegistry(path,value); }
await reset(r);
const recovered = await runReviewProof(input);
if(!recovered.recoveredFixture || !recovered.cleanupConfirmed || posts!==0 || deletes!==1) throw new Error('Recovery failed');
responses.push('ambiguous_append_cleaned');
present=true; loseCleanup=true; await reset(r);
try { await runReviewProof(input); throw new Error('Expected lost cleanup'); } catch(error) { if(reviewProofFailure(error).blocker !== 'spotify_network') throw error; }
const pending=JSON.parse(await Deno.readTextFile(path));
if(pending.state!=='cleanup_pending') throw new Error('Lost cleanup not registered');
const before=deletes; const reconciled=await runReviewProof(input);
if(!reconciled.recoveredFixture || deletes!==before || posts!==0) throw new Error('Cleanup replayed');
responses.push('lost_cleanup_reconciled_without_replay');
present=true; loseCleanup=false; await reset({...r,state:'cleanup_pending',pending:'cleanup'});
try { await runReviewProof(input); throw new Error('Expected pending blocker'); } catch(error) { if(reviewProofFailure(error).blocker !== 'review_cleanup_pending_reconciliation_required') throw error; }
if(deletes!==before) throw new Error('Pending cleanup replayed');
responses.push('pending_cleanup_preserved');
await reset({...r,playlistId:null,state:'creating',pending:'create'});
await runReviewProof(input);
if(posts!==0 || deletes!==before+1) throw new Error('Lost create was replayed');
responses.push('lost_create_reconciled');
present=false; await reset({...r,playlistId:null,state:'creating',pending:'create'});
try { await runReviewProof(input); throw new Error('Expected create blocker'); } catch(error) { if(reviewProofFailure(error).blocker !== 'review_creation_reconciliation_required') throw error; }
if(posts!==0) throw new Error('Unresolved create replayed');
responses.push('unresolved_create_preserved');
await reset({...r,epoch:3});
try { await runReviewProof(input); throw new Error('Expected owner blocker'); } catch(error) { if(reviewProofFailure(error).blocker !== 'review_recovery_owner_changed') throw error; }
responses.push('epoch_change_refused');
owner='other'; await reset(r);
try { await runReviewProof(input); throw new Error('Expected owner mismatch'); } catch(error) { if(reviewProofFailure(error).blocker !== 'review_owner_mismatch') throw error; }
responses.push('immutable_owner_refused');
owner=account; await Deno.writeTextFile(path+'.lock','synthetic');
try { await runReviewProof(input); throw new Error('Expected lock blocker'); } catch(error) { if(reviewProofFailure(error).blocker!=='review_operator_lock_requires_recovery') throw error; }
await Deno.remove(path+'.lock');
responses.push('concurrent_lock_refused');
await Deno.writeTextFile(path+'.tmp','synthetic');
try { await reset(r); throw new Error('Expected temp blocker'); } catch(error) { if(!(error instanceof Deno.errors.AlreadyExists)) throw error; }
responses.push('stale_temp_preserved');
console.log(JSON.stringify({passed:true,checks:responses.length}));
`;
    const result = spawnSync(
      "deno",
      [
        "run",
        "--no-remote",
        "--deny-net",
        `--allow-read=${root},${dir}`,
        `--allow-write=${dir}`,
        "-",
      ],
      {
        cwd: root,
        input: code,
        encoding: "utf8",
        env: { ...process.env, DENO_NO_PROMPT: "1" },
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { passed: true, checks: 9 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
