import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("ACK-targeted entrypoint preserves guarded lifecycle and never replays ambiguous mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spotify-ack-proof-"));
  try {
    const root = process.cwd();
    const imports = (file) =>
      JSON.stringify(pathToFileURL(join(root, file)).href);
    const code = `
import { runReviewAckProof } from ${imports("scripts/live/review-ack-proof.ts")};
import { reviewProofFailure } from ${imports("scripts/live/review-proof.ts")};
import { ServiceDatabase } from ${imports("supabase/functions/_shared/database.ts")};
import { OwnerTokens } from ${imports("supabase/functions/_shared/tokens.ts")};
import { ownerFingerprint } from ${imports("supabase/functions/_shared/crypto.ts")};
const dir=${JSON.stringify(dir)}, binding=btoa('s'.repeat(32)), account='synthetic-account';
const input={origin:'https://'+'a'.repeat(20)+'.supabase.co',serviceKey:'synthetic',clientId:'synthetic',encryptionKey:binding,bindingKey:binding,ownerFingerprint:await ownerFingerprint(account,binding),epoch:2,projectRef:'a'.repeat(20),managementToken:'synthetic',registryPath:'',authorized:true};
ServiceDatabase.prototype.rpc=(name)=>Promise.resolve(name==='app_pacing_acquire'?{granted:true,retryAfterMs:0}:true);
OwnerTokens.prototype.getAccessToken=()=>Promise.resolve('synthetic-token');
// Accelerate only experiment read waits, never adapter request timeouts.
const originalTimeout=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>originalTimeout(fn,[500,1000,2000].includes(ms)?0:ms,...args);
const a='spotify:track:'+'a'.repeat(22),b='spotify:track:'+'b'.repeat(22),id='p'.repeat(22);
let scenarios=0;
for(const mode of ['historical','all_current','lost_create','lost_append','lost_remove','baseline','cleanup_lost','cleanup_rejected','guard']){
 input.registryPath=dir+'/'+mode+'.json';
 let present=false,description='',items=[],revision=0,creates=0,appends=0,replaces=0,removes=0,cleanups=0,guardBlocked=mode==='guard';
 const versions=new Map();
 const save=()=>{const s='opaque-write-'+(++revision);versions.set(s,[...items]);return s;};
 const playlist=(creating=false)=>({id,name:'Synthetic private fixture',description,owner:{id:'profile',...(guardBlocked&&items.length===3?{account_id:'synthetic-private-other'}:{})},collaborative:false,public:!creating,snapshot_id:'opaque-stale-read',items:{total:items.length}});
 globalThis.fetch=async(raw,init)=>{
  const url=new URL(String(raw)),method=init?.method??'GET';
  if(url.hostname==='api.supabase.com'){if(method!=='POST'||JSON.parse(init.body).read_only!==true)throw new Error('Unexpected management write');return Response.json([{playable_uri:a},{playable_uri:b}]);}
  if(url.pathname==='/v1/me')return Response.json({id:'profile',account_id:account});
  if(url.pathname==='/v1/me/playlists'&&method==='POST'){creates++;present=true;description=JSON.parse(init.body).description;if(mode==='lost_create')throw new Error('synthetic-private-response');return Response.json(playlist(true),{status:201});}
  if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='POST'){appends++;items.push(...JSON.parse(init.body).uris);const ack=save();if(mode==='lost_append'&&appends===1)throw new Error('synthetic-private-response');return Response.json({snapshot_id:ack},{status:201});}
  if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='PUT'){replaces++;items=[...JSON.parse(init.body).uris];return Response.json({snapshot_id:save()});}
  if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='DELETE'){
   removes++;const body=JSON.parse(init.body);if(Object.keys(body).sort().join(',')!=='items,snapshot_id'||body.items.length!==1||body.items[0].uri!==a||!versions.has(body.snapshot_id))throw new Error('Unexpected removal contract');
   let left=mode==='all_current'?Infinity:versions.get(body.snapshot_id).filter(uri=>uri===a).length;
   items=items.filter(uri=>uri!==a||left--<=0);const ack=save();if(mode==='lost_remove'&&removes===1)throw new Error('synthetic-private-response');return Response.json({snapshot_id:ack});
  }
  if(url.pathname==='/v1/playlists/'+id&&method==='GET')return Response.json(playlist());
  if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='GET'){
   const observed=mode==='baseline'&&items.length===3?[a]:items;
   return Response.json({items:observed.map(uri=>({added_at:null,is_local:false,item:{type:'track',uri}})),total:observed.length,offset:0,limit:50,next:null});
  }
  if(url.pathname==='/v1/me/library'&&method==='DELETE'){
   cleanups++;if(mode==='cleanup_rejected')return new Response('synthetic-private-response',{status:503});
   present=false;if(mode==='cleanup_lost')throw new Error('synthetic-private-response');return new Response(null,{status:204});
  }
  if(url.pathname==='/v1/me/library/contains')return Response.json([present]);
  if(url.pathname==='/v1/me/playlists'&&method==='GET')return Response.json({items:present?[playlist()]:[],total:present?1:0,offset:0,limit:50,next:null});
  throw new Error('Unexpected request');
 };
 let result;
 try{result=await runReviewAckProof(input);}catch(error){result=reviewProofFailure(error);}
 if(/opaque|spotify:|synthetic-private/.test(JSON.stringify(result)))throw new Error('Private value escaped');
 const registry=JSON.parse(await Deno.readTextFile(input.registryPath));
 if(mode==='historical'||mode==='all_current'){
  if(!result.cleanupConfirmed||result.originalProofPassed!==false||result.readVersionConsistencyVerified!==false||result.historicalSnapshotGuarantee!==false||creates!==1||appends!==3||replaces!==1||removes!==2||cleanups!==1)throw new Error('Wrong completed diagnostic');
  if(result.observations[0].historicalSequenceObserved!==(mode==='historical')||result.observations[1].latestSequenceObserved!==true)throw new Error('Wrong selection observation');
  if(registry.receipt.acknowledgements.length!==6||registry.state!=='removed')throw new Error('Missing private ACK chain');
 }else{
  if(!result.blocker)throw new Error('Expected blocker');
  if(mode==='baseline'&&(result.blocker!=='review_ack_content_unconfirmed'||removes!==0||replaces!==0))throw new Error('Baseline mismatch reached deletion');
  if(mode==='guard'&&(result.blocker!=='review_fixture_guard'||removes!==0||replaces!==0))throw new Error('Guard mismatch reached deletion');
  const before={creates,appends,replaces,removes,cleanups};
  if(mode==='cleanup_rejected'){
   try{await runReviewAckProof(input);throw new Error('Expected pending cleanup blocker');}catch(error){if(reviewProofFailure(error).blocker!=='review_cleanup_pending_reconciliation_required')throw error;}
   if(cleanups!==before.cleanups||creates!==before.creates||appends!==before.appends||removes!==before.removes)throw new Error('Rejected cleanup replayed');
  }else{
   if(mode==='guard'){
    try{await runReviewAckProof(input);throw new Error('Expected guard blocker');}catch(error){if(reviewProofFailure(error).blocker!=='review_fixture_guard')throw error;}
    if(cleanups!==0)throw new Error('Ownership bypassed');guardBlocked=false;
   }
   const recovered=await runReviewAckProof(input);
   if(!recovered.recoveredFixture||!recovered.cleanupConfirmed||recovered.originalProofPassed!==false||recovered.readVersionConsistencyVerified!==false||recovered.historicalSnapshotGuarantee!==false)throw new Error('Recovery not cleanup-only');
   if(creates!==before.creates||appends!==before.appends||replaces!==before.replaces||removes!==before.removes)throw new Error('Ambiguous write replayed');
   if(mode==='cleanup_lost'&&cleanups!==before.cleanups)throw new Error('Lost cleanup replayed');
  }
 }
 scenarios++;
}
console.log(JSON.stringify({passed:true,scenarios}));
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
    assert.deepEqual(JSON.parse(result.stdout), { passed: true, scenarios: 9 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
