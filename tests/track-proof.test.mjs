import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("one-track entrypoint binds consent, observes dates, and never replays ambiguous writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spotify-track-proof-"));
  try {
    const imp = (p) =>
      JSON.stringify(pathToFileURL(join(process.cwd(), p)).href);
    const code = `
import {runTrackProof,trackProofFailure,validAddedAt} from ${imp("scripts/live/track-proof.ts")};
import {ServiceDatabase} from ${imp("supabase/functions/_shared/database.ts")};
import {OwnerTokens} from ${imp("supabase/functions/_shared/tokens.ts")};
import {ownerFingerprint} from ${imp("supabase/functions/_shared/crypto.ts")};
const dir=${JSON.stringify(dir)},binding=btoa('s'.repeat(32)),account='private-account',uri='spotify:track:'+'a'.repeat(22),id='a'.repeat(22);
const fail=(m)=>{throw new Error(m)};
const timer=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>timer(fn,[500,1000,2000,2100].includes(ms)?0:ms,...args);
if(!validAddedAt('2026-01-01T00:00:00Z')||!validAddedAt('2026-01-01T00:00:00.12Z')||validAddedAt('2026-02-30T00:00:00Z')||validAddedAt('2026-01-01T00:00:00+00:00'))fail('Date precision validation');
let scenarios=0;
for(const mode of ['normal','equal','pagination','liked','target','cache','consent','head','scope','owner','epoch','lost1','lost2','lost3','lost4','lost_cleanup','cleanup_not_applied','schema','date','scan_bound','page_schema','guard','intent_crash','delayed_after_false','delayed_after_cleanup']){
 let liked=mode==='liked',writes=[],likes=0,readCalls=0,active=true,lose=true;
 const input={origin:'https://'+'a'.repeat(20)+'.supabase.co',serviceKey:'private-service',clientId:'private-client',encryptionKey:binding,bindingKey:binding,ownerFingerprint:await ownerFingerprint(account,binding),epoch:2,projectRef:'a'.repeat(20),managementToken:'private-management',registryPath:dir+'/'+mode+'.json',executionHead:'b'.repeat(40),operation:'11111111-1111-4111-8111-111111111111',targetUri:uri,consent:null};
 input.consent={approved:mode!=='consent',purpose:'one-unliked-track-date-proof',operation:input.operation,ownerFingerprint:input.ownerFingerprint,epoch:2,reviewedHead:mode==='head'?'c'.repeat(40):input.executionHead,targetFingerprint:await ownerFingerprint('track-proof:'+uri,binding),registryPath:input.registryPath,maxWrites:4,restoreUnliked:true,expiresAt:new Date(Date.now()+3600000).toISOString()};
 ServiceDatabase.prototype.rpc=async(name)=>name==='app_pacing_acquire'?{granted:true,retryAfterMs:0}:mode==='epoch'?false:active;
 OwnerTokens.prototype.getAccessToken=()=>Promise.resolve('private-token');
 OwnerTokens.prototype.getGrantedScopes=()=>Promise.resolve(mode==='scope'?['user-library-read']:['user-library-read','user-library-modify']);
 const track=(target=true)=>({type:'track',id:target?id:'z'.repeat(22),uri:target?uri:'spotify:track:'+'z'.repeat(22),is_local:false,is_playable:true,name:'private-title'});
 globalThis.fetch=async(raw,init)=>{
  const u=new URL(String(raw)),method=init?.method??'GET';
  if(u.hostname==='api.supabase.com'){if(JSON.parse(init.body).read_only!==true)fail('Management mutation');return Response.json([{count:mode==='cache'?0:1}]);}
  if(u.pathname==='/v1/me')return Response.json({account_id:mode==='owner'?'other':account,id:'private-profile'});
  if(u.pathname==='/v1/tracks/'+id)return Response.json(track(mode!=='target'));
  if(u.pathname==='/v1/me/library/contains'){
   if(u.searchParams.get('uris')!==uri)fail('Wrong contains target');
   readCalls++;if(mode==='guard'&&likes===1)active=false;
   return Response.json([liked]);
  }
  if(u.pathname==='/v1/me/library'&&['PUT','DELETE'].includes(method)){
   if(u.searchParams.get('uris')!==uri||[...u.searchParams].length!==1||init.body!==undefined)fail('Broadened track write');
   const r=JSON.parse(await Deno.readTextFile(input.registryPath));
   if(r.writes.length!==writes.length+1||r.writes.at(-1).acknowledged!==false)fail('Intent not durable');
   if(['intent_crash','delayed_after_false'].includes(mode)&&writes.length===0){ // Simulate failure after intent but before remote effect.
    writes.push(method);throw new Error('private-loss');
   }
   writes.push(method);if(mode==='cleanup_not_applied'&&writes.length===2)throw new Error('private-loss');liked=method==='PUT';if(liked)likes++;
   if((mode==='lost'+writes.length&&lose)||(mode==='delayed_after_cleanup'&&writes.length===1)||(['lost_cleanup','cleanup_not_applied'].includes(mode)&&[1,2].includes(writes.length))) {if(mode!=='lost_cleanup')lose=false;throw new Error('private-loss');}
   return new Response(mode==='schema'&&writes.length===1?'private-body':null,{status:200});
  }
  if(u.pathname==='/v1/me/tracks'){
   const offset=Number(u.searchParams.get('offset'));
   if(mode==='scan_bound'||(mode==='pagination'&&offset===0))return Response.json({items:Array.from({length:50},()=>({track:track(false),added_at:'2026-01-01T00:00:00Z'})),total:10050,offset,limit:50,next:'https://api.spotify.com/v1/me/tracks?limit=50&offset='+(offset+50)});
   const date=mode==='date'?'2026-02-30T00:00:00Z':(likes===1?'2026-01-01T00:00:00Z':mode==='equal'?'2026-01-01T00:00:00.000Z':'2026-01-01T00:00:03.000Z');
   return Response.json({items:liked?[{track:track(),added_at:date}]:[],total:offset+(liked?1:0),offset:mode==='page_schema'?999:offset,limit:50,next:null});
  }
  fail('Unexpected transport path');
 };
 const run=async()=>{try{return await runTrackProof(input)}catch(e){return trackProofFailure(e)}};
 const result=await run();
 if(/private-|spotify:|2026-|[ab]{40}/.test(JSON.stringify(result)))fail('Output leaked private data');
 const zero=['liked','target','cache','consent','head','scope','owner','epoch'].includes(mode);
 if(zero&&writes.length!==0)fail('Preflight refusal wrote');
 if(['normal','equal','pagination'].includes(mode)){
  if(!result.passed||!result.cleanupConfirmed||result.writeCount!==4||liked||writes.join(',')!=='PUT,DELETE,PUT,DELETE'||result.datesEqual!==(mode==='equal')||result.secondDateLater!==(mode!=='equal'))fail('Four-write result wrong');
 }else if(result.passed)fail('Failure passed');
 const ambiguousLike=['lost1','lost3','lost_cleanup','cleanup_not_applied','schema','intent_crash','delayed_after_false','delayed_after_cleanup'].includes(mode);
 if(ambiguousLike){
  const r=JSON.parse(await Deno.readTextFile(input.registryPath));
  if(r.complete||result.cleanupConfirmed||!r.writes.some(w=>['first_like','second_like'].includes(w.phase)&&!w.acknowledged))fail('Ambiguous like was consumed');
 }
 if(mode.startsWith('delayed_')){
  // The original unacknowledged PUT takes effect only after false observations
  // (or after the distinct cleanup DELETE) have already finished.
  liked=true;
  const before=writes.length;
  const recovered=await run();
  const r=JSON.parse(await Deno.readTextFile(input.registryPath));
  const expected=mode==='delayed_after_false'?before+1:before;
  if(writes.length!==expected||r.complete||recovered.cleanupConfirmed||recovered.alreadyConsumed)fail('Delayed PUT uncertainty erased');
  const again=await run();
  if(writes.length!==expected||again.cleanupConfirmed||JSON.parse(await Deno.readTextFile(input.registryPath)).complete)fail('Delayed cleanup replayed or consumed');
  // Refuse a consumed receipt produced by older code; its pending PUT still wins.
  const stale=JSON.parse(await Deno.readTextFile(input.registryPath));stale.complete=true;
  await Deno.writeTextFile(input.registryPath,JSON.stringify(stale));
  const consumed=await run();
  if(consumed.blocker!=='write_reconciliation_required'||consumed.alreadyConsumed||consumed.cleanupConfirmed||writes.length!==expected)fail('Consumed guard hid ambiguous PUT');
  scenarios++;continue;
 }
 const before=writes.length;
 if(!zero){
  const registry=JSON.parse(await Deno.readTextFile(input.registryPath));
  if(registry.writes.length>4||registry.writes.length!==writes.length)fail('Budget mismatch');
  if(['normal','equal','pagination'].includes(mode))liked=true; // A later human like must survive a consumed registry.
  const recovered=!['guard'].includes(mode)?await run():null;
  if(ambiguousLike&&(recovered?.cleanupConfirmed||recovered?.alreadyConsumed||JSON.parse(await Deno.readTextFile(input.registryPath)).complete))fail('Recovery erased ambiguous like');
  if(['normal','equal','pagination'].includes(mode)&&!liked)fail('Consumed registry removed later membership');
  if(writes.length!==before)fail('Restart replayed a write');
  if(['lost1','lost3','schema','date','scan_bound','page_schema'].includes(mode)&&liked)fail('Distinct cleanup not performed');
  if(['lost2','lost4'].includes(mode)&&writes.filter(x=>x==='DELETE').length!==(mode==='lost2'?1:2))fail('Ambiguous DELETE replayed');
  if(['lost_cleanup','cleanup_not_applied'].includes(mode)&&writes.length!==2)fail('Ambiguous cleanup replayed');
 }
 scenarios++;
}
// A replacement target, registry path or operation cannot reuse consent.
for(const field of ['targetUri','registryPath','operation']){
 const input={serviceKey:'private',clientId:'private',encryptionKey:binding,managementToken:'private',projectRef:'a'.repeat(20),origin:'https://'+'a'.repeat(20)+'.supabase.co',epoch:2,ownerFingerprint:'a'.repeat(64),executionHead:'b'.repeat(40),operation:'11111111-1111-4111-8111-111111111111',targetUri:uri,registryPath:dir+'/binding.json',bindingKey:binding,consent:{approved:true,purpose:'one-unliked-track-date-proof',operation:'11111111-1111-4111-8111-111111111111',ownerFingerprint:'a'.repeat(64),epoch:2,reviewedHead:'b'.repeat(40),targetFingerprint:await ownerFingerprint('track-proof:'+uri,binding),registryPath:dir+'/binding.json',maxWrites:4,restoreUnliked:true,expiresAt:new Date(Date.now()+3600000).toISOString()}};
 input[field]=field==='targetUri'?'spotify:track:'+'z'.repeat(22):field==='operation'?'22222222-2222-4222-8222-222222222222':dir+'/other.json';
 globalThis.fetch=()=>fail('Consent mismatch made request');
 try{await runTrackProof(input);fail('Bad binding accepted')}catch(e){if(trackProofFailure(e).blocker!=='consent_required')throw e;}
}
console.log(JSON.stringify({scenarios,passed:true}));
`;
    const checked = spawnSync(
      "deno",
      ["check", "--no-remote", "scripts/live/track-proof.ts"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30000 },
    );
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    const harness = join(dir, "harness.ts");
    await writeFile(harness, code);
    const result = spawnSync(
      "deno",
      [
        "run",
        "--no-check",
        "--no-remote",
        "--no-prompt",
        "--deny-net",
        `--allow-read=${dir}`,
        `--allow-write=${dir}`,
        harness,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DENO_NO_UPDATE_CHECK: "1" },
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      scenarios: 25,
      passed: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
