import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("attribution entrypoint isolates replacement identity, final rejection and cleanup-only recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spotify-attribution-proof-"));
  try {
    const root = process.cwd();
    const imports = (file) =>
      JSON.stringify(pathToFileURL(join(root, file)).href);
    const code = `
import {runReviewAttributionProof} from ${imports("scripts/live/review-attribution-proof.ts")};
import {reviewProofFailure} from ${imports("scripts/live/review-proof.ts")};
import {ServiceDatabase} from ${imports("supabase/functions/_shared/database.ts")};
import {OwnerTokens} from ${imports("supabase/functions/_shared/tokens.ts")};
import {ownerFingerprint} from ${imports("supabase/functions/_shared/crypto.ts")};
const dir=${JSON.stringify(dir)},binding=btoa('s'.repeat(32)),account='synthetic-account';
const input={origin:'https://'+'a'.repeat(20)+'.supabase.co',serviceKey:'synthetic',clientId:'synthetic',encryptionKey:binding,bindingKey:binding,ownerFingerprint:await ownerFingerprint(account,binding),epoch:2,projectRef:'a'.repeat(20),managementToken:'synthetic',registryPath:'',authorized:true};
ServiceDatabase.prototype.rpc=name=>Promise.resolve(name==='app_pacing_acquire'?{granted:true,retryAfterMs:0}:true);
OwnerTokens.prototype.getAccessToken=()=>Promise.resolve('synthetic-token');
const originalTimeout=globalThis.setTimeout;
globalThis.setTimeout=(fn,ms,...args)=>originalTimeout(fn,[500,1000,2000].includes(ms)?0:ms,...args);
const a='spotify:track:'+'a'.repeat(22),b='spotify:track:'+'b'.repeat(22),id='p'.repeat(22);
let scenarios=0;
for(const mode of ['historical','noop','reject','replacement_removed','lost_final','guard','baseline','cleanup_lost','unique_negative','unrelated_negative']){
 input.registryPath=dir+'/'+mode+'.json';
 let present=false,description='',items=[],revision=0,occurrence=0,creates=0,appends=0,removes=0,cleanups=0,guardBlocked=mode==='guard';
 const versions=new Map();
 const save=()=>{const ack='opaque-write-'+ ++revision;versions.set(ack,structuredClone(items));return ack;};
 const playlist=(creating=false)=>({id,name:'Synthetic private fixture',description,owner:{id:'profile',...(guardBlocked&&appends===5?{account_id:'synthetic-private-other'}:{})},collaborative:false,public:!creating,snapshot_id:'opaque-stale-read',items:{total:items.length}});
 globalThis.fetch=async(raw,init)=>{
  const url=new URL(String(raw)),method=init?.method??'GET';
  if(url.hostname==='api.supabase.com'){if(method!=='POST'||JSON.parse(init.body).read_only!==true)throw new Error('Unexpected management write');return Response.json([{playable_uri:a},{playable_uri:b}]);}
  if(method==='PUT')throw new Error('Diagnostic must never reset');
  if(url.pathname==='/v1/me')return Response.json({id:'profile',account_id:account});
  if(url.pathname==='/v1/me/playlists'&&method==='POST'){creates++;present=true;description=JSON.parse(init.body).description;return Response.json(playlist(true),{status:201});}
  if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='POST'){appends++;items.push(...JSON.parse(init.body).uris.map(uri=>({uri,key:++occurrence})));return Response.json({snapshot_id:save()},{status:201});}
  if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='DELETE'){
   removes++;const body=JSON.parse(init.body);if(Object.keys(body).sort().join(',')!=='items,snapshot_id'||body.items.length!==1||body.items[0].uri!==a||!versions.has(body.snapshot_id))throw new Error('Unexpected removal contract');
   if(removes===4&&mode==='reject')return new Response('synthetic-private-body',{status:400});
   if(removes===4&&mode==='noop')return Response.json({snapshot_id:'opaque-write-'+revision});
   const targets=new Set(versions.get(body.snapshot_id).filter(item=>item.uri===a).map(item=>item.key));
   if(!(mode==='unique_negative'&&removes===1))items=items.filter(item=>!targets.has(item.key));
   if((mode==='replacement_removed'&&removes===4)||(mode==='unrelated_negative'&&removes===2))items=items.filter(item=>mode==='unrelated_negative'?false:item.uri!==a);
   const ack=save();if(mode==='lost_final'&&removes===4)throw new Error('synthetic-private-response');return Response.json({snapshot_id:ack});
  }
  if(url.pathname==='/v1/playlists/'+id&&method==='GET')return Response.json(playlist());
  if(url.pathname==='/v1/playlists/'+id+'/items'&&method==='GET'){
   const observed=mode==='baseline'&&appends===1?[]:items;
   return Response.json({items:observed.map(item=>({added_at:null,is_local:false,item:{type:'track',uri:item.uri}})),total:observed.length,offset:0,limit:50,next:null});
  }
  if(url.pathname==='/v1/me/library'&&method==='DELETE'){cleanups++;present=false;if(mode==='cleanup_lost')throw new Error('synthetic-private-response');return new Response(null,{status:204});}
  if(url.pathname==='/v1/me/library/contains')return Response.json([present]);
  if(url.pathname==='/v1/me/playlists'&&method==='GET')return Response.json({items:present?[playlist()]:[],total:present?1:0,offset:0,limit:50,next:null});
  throw new Error('Unexpected request');
 };
 let result;
 try{result=await runReviewAttributionProof(input);}catch(error){result=reviewProofFailure(error);}
 if(/opaque|spotify:|synthetic-private/.test(JSON.stringify(result)))throw new Error('Private value escaped');
 const registry=JSON.parse(await Deno.readTextFile(input.registryPath));
 const failed=['lost_final','guard','baseline','cleanup_lost'].includes(mode);
 if(!failed){
  if(!result.cleanupConfirmed||result.originalProofPassed!==false||result.readVersionConsistencyVerified!==false||result.historicalSnapshotGuarantee!==false||creates!==1||cleanups!==1)throw new Error('Wrong diagnostic completion');
  if(mode==='unique_negative'||mode==='unrelated_negative'){
   const unique=mode==='unique_negative';
   if(result.candidateReady!==false||result.allCasesCompleted!==false||appends!==(unique?1:3)||removes!==(unique?1:2)||result.observations.length!==(unique?1:2))throw new Error('Early negative continued mutating');
  }else{
   if(appends!==5||removes!==4||result.allCasesCompleted!==true||result.candidateReady!==(mode!=='replacement_removed'))throw new Error('Wrong three-case attribution');
   if(mode==='reject'&&(result.finalRemoval.status!==400||result.finalRemoval.category!=='bad_request'||registry.receipt.acknowledgements.length!==8))throw new Error('Rejection not observed privately');
   if(mode!=='reject'&&registry.receipt.acknowledgements.length!==9)throw new Error('Missing nine-write chain');
   if(mode==='noop'&&result.finalRemoval.ackMatchesPreviousWrite!==true)throw new Error('No-op ACK rejected');
  }
 }else{
  if(!result.blocker)throw new Error('Expected blocker');
  if(mode==='baseline'&&removes!==0)throw new Error('Mismatched baseline reached delete');
  if(mode==='guard'&&removes!==3)throw new Error('Ownership mismatch reached final delete');
  const before={creates,appends,removes,cleanups};
  if(mode==='guard'){
   try{await runReviewAttributionProof(input);throw new Error('Expected guard blocker');}catch(error){if(reviewProofFailure(error).blocker!=='review_fixture_guard')throw error;}
   if(cleanups!==0)throw new Error('Owner guard bypassed');guardBlocked=false;
  }
  const recovery=await runReviewAttributionProof(input);
  if(!recovery.recoveredFixture||!recovery.cleanupConfirmed||recovery.originalProofPassed!==false||recovery.readVersionConsistencyVerified!==false||recovery.historicalSnapshotGuarantee!==false)throw new Error('Recovery not cleanup-only');
  if(creates!==before.creates||appends!==before.appends||removes!==before.removes)throw new Error('Ambiguous write replayed');
  if(mode==='cleanup_lost'&&cleanups!==before.cleanups)throw new Error('Cleanup replayed');
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
    assert.deepEqual(JSON.parse(result.stdout), {
      passed: true,
      scenarios: 10,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
