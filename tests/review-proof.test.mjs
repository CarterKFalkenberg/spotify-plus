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
const input = { origin:'https://'+'a'.repeat(20)+'.supabase.co', serviceKey:'synthetic', clientId:'synthetic', encryptionKey:binding, bindingKey:binding, ownerFingerprint:fingerprint, epoch:2, projectRef:'a'.repeat(20), managementToken:'synthetic', registryPath:path, authorized:true };
ServiceDatabase.prototype.rpc = (name) => Promise.resolve(name === 'app_pacing_acquire' ? {granted:true,retryAfterMs:0} : true);
OwnerTokens.prototype.getAccessToken = () => Promise.resolve('synthetic-token');
let playlistAccount = account, playlistProfile = 'legacy', publicReadback = false;
const playlist = () => ({ id:r.playlistId, name:'Synthetic', description:'[Tagger review proof '+r.operation+'] Disposable', owner:{id:playlistProfile, ...(playlistAccount === undefined ? {} : {account_id:playlistAccount})}, collaborative:false, public:publicReadback, snapshot_id:'synthetic-snapshot', items:{total:0} });
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
// Fresh immutable owner and profile identifiers deliberately differ. A legacy-only
// owner can be reconciled and cleaned, including the known contradictory public
// readback. Recovery must still never issue a second create.
playlistAccount=undefined; publicReadback=true; present=true;
await reset({...r,playlistId:null,state:'creating',pending:'create'});
const beforeLegacy=deletes; const legacyRecovered=await runReviewProof(input);
if(!legacyRecovered.cleanupConfirmed || posts!==0 || deletes!==beforeLegacy+1) throw new Error('Legacy owner recovery failed');
responses.push('legacy_owner_lost_create_reconciled');
// An explicit mismatched account cannot borrow a matching legacy profile ID.
playlistAccount='other-account'; present=true;
for(const pendingCreate of [true,false]) {
 const target=pendingCreate?{...r,playlistId:null,state:'creating',pending:'create'}:r;
 await reset(target); const beforeMismatch=deletes;
 try { await runReviewProof(input); throw new Error('Expected explicit account mismatch'); } catch(error) { if(reviewProofFailure(error).blocker !== (pendingCreate?'review_creation_reconciliation_required':'review_fixture_guard')) throw error; }
 const preserved=JSON.parse(await Deno.readTextFile(path));
 if(deletes!==beforeMismatch || posts!==0 || JSON.stringify(preserved)!==JSON.stringify(target)) throw new Error('Explicit mismatch changed fixture');
 responses.push(pendingCreate?'explicit_account_mismatch_create_refused':'explicit_account_mismatch_cleanup_refused');
}
playlistAccount=undefined; playlistProfile=account; await reset({...r,playlistId:null,state:'creating',pending:'create'});
const beforeWrongProfile=deletes;
try { await runReviewProof(input); throw new Error('Expected profile namespace mismatch'); } catch(error) { if(reviewProofFailure(error).blocker!=='review_creation_reconciliation_required') throw error; }
if(deletes!==beforeWrongProfile || posts!==0) throw new Error('Immutable account accepted as legacy profile');
responses.push('legacy_namespace_mismatch_refused');
// The immutable HMAC remains the first boundary even with a matching profile.
playlistProfile='legacy'; owner='other'; await reset({...r,playlistId:null,state:'creating',pending:'create'});
try { await runReviewProof(input); throw new Error('Expected immutable mismatch'); } catch(error) { if(reviewProofFailure(error).blocker!=='review_owner_mismatch') throw error; }
if(deletes!==beforeWrongProfile || posts!==0) throw new Error('Immutable mismatch changed fixture');
responses.push('legacy_match_cannot_bypass_immutable_binding');
owner=account; playlistAccount=account; publicReadback=false;
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
    assert.deepEqual(JSON.parse(result.stdout), { passed: true, checks: 14 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("separate append entrypoint observes one POST and never replays after ambiguity or receipt failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spotify-append-proof-"));
  try {
    const root = process.cwd();
    const imports = (file) =>
      JSON.stringify(pathToFileURL(join(root, file)).href);
    const code = `
import { runReviewAppendProof } from ${imports("scripts/live/review-append-proof.ts")};
import { reviewProofFailure, runReviewProof } from ${imports("scripts/live/review-proof.ts")};
import { ServiceDatabase } from ${imports("supabase/functions/_shared/database.ts")};
import { OwnerTokens } from ${imports("supabase/functions/_shared/tokens.ts")};
import { ownerFingerprint } from ${imports("supabase/functions/_shared/crypto.ts")};
const path=${JSON.stringify(join(dir, "registry.json"))};
const binding=btoa('s'.repeat(32)), account='synthetic-account';
const fingerprint=await ownerFingerprint(account,binding);
const input={origin:'https://'+'a'.repeat(20)+'.supabase.co',serviceKey:'synthetic',clientId:'synthetic',encryptionKey:binding,bindingKey:binding,ownerFingerprint:fingerprint,epoch:2,projectRef:'a'.repeat(20),managementToken:'synthetic',registryPath:path,authorized:true};
ServiceDatabase.prototype.rpc=(name)=>Promise.resolve(name==='app_pacing_acquire'?{granted:true,retryAfterMs:0}:true);
OwnerTokens.prototype.getAccessToken=()=>Promise.resolve('synthetic-token');
const uri='spotify:track:'+'a'.repeat(22), id='p'.repeat(22);
let present=false, description='', items=[], mode='mismatch', appends=0, creates=0, cleanups=0;
const verbs=[];
const playlist=(creating=false)=>({id,name:'Synthetic',description,owner:{id:'profile'},collaborative:false,public:!creating,snapshot_id:items.length?'opaque-read-after':'opaque-empty-before',items:{total:items.length}});
globalThis.fetch=async(raw,init)=>{
 const url=new URL(String(raw)), method=init?.method??'GET';
 if(url.hostname==='api.supabase.com') {
  if(method!=='POST'||JSON.parse(init.body).read_only!==true)throw new Error('Unexpected management write');
  return Response.json([{playable_uri:uri},{playable_uri:'spotify:track:'+'b'.repeat(22)}]);
 }
 verbs.push({method,path:url.pathname});
 if(url.pathname==='/v1/me')return Response.json({id:'profile',account_id:account});
 if(url.pathname==='/v1/me/playlists'&&method==='POST'){
  creates++; present=true;items=[];description=JSON.parse(init.body).description;
  return Response.json(playlist(true),{status:201});
 }
 if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='PUT'&&mode==='baseline'){items=[...JSON.parse(init.body).uris];return Response.json({snapshot_id:'opaque-replace-ack'});}
 if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='POST'){
  appends++; const body=JSON.parse(init.body); if(body.uris.length!==1||body.uris[0]!==uri)throw new Error('Unexpected append');
  items.push(uri);
  if(mode==='lost')throw new Error('Synthetic lost acknowledgement');
  if(mode==='receipt')await Deno.writeTextFile(path+'.tmp','synthetic interruption');
  return Response.json({snapshot_id:'opaque-append-ack'},{status:201});
 }
 if(url.pathname==='/v1/playlists/'+id&&method==='GET')return Response.json(playlist());
 if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='GET')return Response.json({items:items.map(value=>({added_at:null,is_local:false,item:{type:'track',uri:value}})),total:items.length,offset:0,limit:50,next:null});
 if(url.pathname==='/v1/me/library'&&method==='DELETE'){cleanups++;present=false;return new Response(null,{status:204});}
 if(url.pathname==='/v1/me/library/contains')return Response.json([present]);
 if(url.pathname==='/v1/me/playlists'&&method==='GET')return Response.json({items:present?[playlist()]:[],total:present?1:0,offset:0,limit:50,next:null});
 throw new Error('Unexpected request');
};
const result=await runReviewAppendProof(input);
if(!result.cleanupConfirmed||result.experiment!=='append_ack'||result.observation.ackSnapshotMatches!==false||result.observation.sequenceMatches!==true||result.historicalSnapshotGuarantee!==false||appends!==1||creates!==1||cleanups!==1)throw new Error('Wrong append observation');
const receipt=JSON.parse(await Deno.readTextFile(path)).receipt;
if(receipt.initialEmptySnapshotId!=='opaque-empty-before'||receipt.acknowledgedSnapshotId!=='opaque-append-ack'||receipt.readbacks.length!==4||receipt.readbacks.some(r=>r.afterSnapshotId!=='opaque-read-after'))throw new Error('Missing private versions');
if(/opaque|spotify:|snapshotId/.test(JSON.stringify(result)))throw new Error('Private versions escaped output');
mode='lost';
try{await runReviewAppendProof(input);throw new Error('Expected lost append');}catch(error){if(reviewProofFailure(error).blocker!=='spotify_network')throw error;}
let pending=JSON.parse(await Deno.readTextFile(path));
if(pending.state!=='created'||pending.pending!=='append')throw new Error('Lost append not pending');
let before=appends;
const recovered=await runReviewAppendProof(input);
if(!recovered.recoveredFixture||!recovered.cleanupConfirmed||appends!==before)throw new Error('Lost append replayed');
mode='receipt';
try{await runReviewAppendProof(input);throw new Error('Expected receipt failure');}catch(error){if(reviewProofFailure(error).blocker!=='review_proof_failed')throw error;}
pending=JSON.parse(await Deno.readTextFile(path));
if(pending.state!=='created'||pending.pending!=='append')throw new Error('Receipt failure not pending');
before=appends;
try{await runReviewAppendProof(input);throw new Error('Expected temp blocker');}catch(error){if(reviewProofFailure(error).blocker!=='review_operator_temp_requires_recovery')throw error;}
if(appends!==before)throw new Error('Receipt failure replayed');
await Deno.remove(path+'.tmp');
await runReviewAppendProof(input);
if(appends!==before||creates!==3||cleanups!==3||verbs.some(v=>v.method==='PUT'||(v.method==='DELETE'&&v.path.endsWith('/items'))))throw new Error('Unexpected mutation or replay');
// The original four-case proof still rejects an exact sequence with a different
// acknowledged snapshot; its private receipt retains both versions.
mode='baseline';
try{await runReviewProof(input);throw new Error('Expected original baseline blocker');}catch(error){const safe=reviewProofFailure(error);if(safe.blocker!=='review_baseline_unconfirmed'||safe.evidence?.snapshotMatches!==false||safe.evidence?.sequenceMatches!==true)throw error;}
const baselineReceipt=JSON.parse(await Deno.readTextFile(path)).receipt;
if(baselineReceipt.acknowledgedSnapshotId!=='opaque-replace-ack'||baselineReceipt.readbacks.length!==4||baselineReceipt.readbacks.some(r=>r.afterSnapshotId!=='opaque-read-after'))throw new Error('Original receipt missing');
await runReviewAppendProof(input);
if(appends!==3||creates!==4||cleanups!==4||verbs.filter(v=>v.method==='PUT').length!==1)throw new Error('Original proof replayed mutation');
console.log(JSON.stringify({passed:true,creates,appends,cleanups}));
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
    assert.deepEqual(JSON.parse(result.stdout), {
      passed: true,
      creates: 4,
      appends: 3,
      cleanups: 4,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
