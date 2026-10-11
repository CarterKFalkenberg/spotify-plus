import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySupabaseProject } from '../scripts/build.mjs';
const ref = 'synthetic-project';
test('scoped access probes only the configured project without listing the account', async () => {
  await verifySupabaseProject(ref, 'synthetic-token', async (url, options) => {
    assert.equal(url, 'https://api.supabase.com/v1/projects/synthetic-project');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ id: ref, status: 'ACTIVE_HEALTHY' }) };
  });
});
test('access failures never expose the API response or credentials', async () => {
  for (const status of [401,403,404]) {
    await assert.rejects(verifySupabaseProject(ref, 'synthetic-token', async () => ({
      ok:false,status,json:async()=>{throw new Error('private response must not be read');}
    })), new RegExp(`HTTP ${status}`));
  }
});
test('a different, paused or malformed project cannot pass preflight', async () => {
  for (const project of [{id:'other',status:'ACTIVE_HEALTHY'},{id:ref,status:'INACTIVE'},{}]) {
    await assert.rejects(verifySupabaseProject(ref,'synthetic-token',async()=>({ok:true,json:async()=>project})));
  }
});
