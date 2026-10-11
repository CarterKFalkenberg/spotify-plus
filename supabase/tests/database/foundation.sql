\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean, label text) returns void language plpgsql as $$
 begin if ok is distinct from true then raise exception 'assertion_failed: %',label; end if; end;
$$;
select pg_temp.assert(not has_schema_privilege('anon','app','USAGE'),'anon cannot reach private schema');
select pg_temp.assert(not has_schema_privilege('authenticated','app','USAGE'),'authenticated cannot reach private schema');
select pg_temp.assert(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'app_%'
  and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))),'all product RPCs deny client roles');
select pg_temp.assert(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'app_%'
  and not has_function_privilege('service_role',p.oid,'EXECUTE')),'all product RPCs grant service role');
select pg_temp.assert(not has_table_privilege('service_role','app.credentials','SELECT'),'service role cannot bypass RPC boundary');
select pg_temp.assert(not exists(select 1 from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='app' and c.relkind='r' and not c.relrowsecurity),'private tables enforce RLS');
set local role anon;
do $$ begin
 begin perform public.app_account_status(); raise exception 'anonymous RPC unexpectedly allowed'; exception when insufficient_privilege then null; end;
 begin perform 1 from app.credentials; raise exception 'anonymous SELECT unexpectedly allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
 begin perform public.app_job_claim(); raise exception 'authenticated job RPC unexpectedly allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'ciphertext',now()+interval '1 hour',now()-interval '1 month',repeat('b',64),true);
reset role;
select pg_temp.assert((public.app_session(repeat('b',64))->>'state')='connected','session authenticates');
select pg_temp.assert(public.app_session(repeat('c',64)) is null,'unknown session denies');
select pg_temp.assert(not public.app_connect(1,'synthetic-account',repeat('a',64),true,'overwrite',now()+interval '1 hour',now(),null,true),'bootstrap consumed once');
select pg_temp.assert((select encrypted_tokens='ciphertext' from app.credentials),'bootstrap retry does not overwrite grant');
select pg_temp.assert((select authorization_deadline=authorized_at+interval '6 months' from app.account),'deadline anchored to original authorization');
select public.app_oauth_start(repeat('d',64),repeat('e',64),'verifier');
select pg_temp.assert(public.app_oauth_consume(repeat('d',64),repeat('f',64)) is null,'OAuth bound to browser');
select pg_temp.assert(public.app_oauth_consume(repeat('d',64),repeat('e',64)) is not null,'OAuth valid state consumes');
select pg_temp.assert(public.app_oauth_consume(repeat('d',64),repeat('e',64)) is null,'OAuth replay denied');

create temporary table snapshots(name text primary key,value jsonb);
insert into snapshots values('refresh',public.app_token_claim(1,1));
select pg_temp.assert((select value->>'action'='refresh' from snapshots where name='refresh'),'401 claims refresh');
select pg_temp.assert(public.app_token_claim(1,1)->>'action'='busy','concurrent refresh serialized');
select pg_temp.assert(public.app_token_finish(1,(select (value->>'lease')::uuid from snapshots where name='refresh'),'rotated',now()+interval '1 hour'),'rotation committed');
select pg_temp.assert(public.app_token_claim(1,1)->>'action'='cached','stale 401 reuses rotated token');
select pg_temp.assert((select authorized_at<now()-interval '29 days' from app.account),'refresh retains original authorization');
select pg_temp.assert(not public.app_token_finish(1,(select (value->>'lease')::uuid from snapshots where name='refresh'),'late',now()+interval '1 hour'),'old refresh result fenced');
select pg_temp.assert((public.app_pacing_acquire(1,500)->>'granted')::boolean,'first pacing request granted');
select pg_temp.assert(not (public.app_pacing_acquire(1,500)->>'granted')::boolean,'second concurrent pacing request denied');
select public.app_pacing_defer(1,1,'quota');
select pg_temp.assert((public.app_pacing_acquire(1,500)->>'retryAfterMs')::bigint>21599000,'quota parks six hours');
select public.app_pacing_defer(1,30000,'rate_limit');
select pg_temp.assert((public.app_pacing_acquire(1,500)->>'retryAfterMs')::bigint>21599000,'short cooldown cannot lower quota delay');

update app.spotify_pacing set cooldown_until='-infinity';
select public.app_job_enqueue('synthetic',1,'{"synthetic":true}',10);
insert into snapshots values('job',public.app_job_claim());
select pg_temp.assert(public.app_job_claim() is null,'leased job cannot be claimed twice');
update app.jobs set lease_until=now()-interval '1 second' where kind='synthetic';
insert into snapshots values('reclaimed',public.app_job_claim());
select pg_temp.assert((select a.value->>'leaseToken'<>b.value->>'leaseToken' from snapshots a,snapshots b where a.name='job' and b.name='reclaimed'),'reclaim rotates fencing token');
select pg_temp.assert(not public.app_job_finish((select (value->>'id')::uuid from snapshots where name='job'),(select (value->>'leaseToken')::uuid from snapshots where name='job'),'done'),'expired worker cannot finish reclaimed job');
select pg_temp.assert(public.app_job_finish((select (value->>'id')::uuid from snapshots where name='reclaimed'),(select (value->>'leaseToken')::uuid from snapshots where name='reclaimed'),'queued',60000,'synthetic_retry'),'retry timestamp persisted');
select pg_temp.assert(public.app_job_claim() is null,'retry delay prevents busy looping');
update app.jobs set retry_at=now() where kind='synthetic';
insert into snapshots values('inflight',public.app_job_claim());
insert into snapshots values('inflight_refresh',public.app_token_claim(1,2));
select public.app_oauth_start(repeat('1',64),repeat('2',64),'late-verifier');
insert into snapshots values('disconnect',public.app_disconnect(1));
select pg_temp.assert((select epoch=2 and state='disconnecting' and account_id is null and owner_fingerprint=repeat('a',64) from app.account),'disconnect invalidates epoch, clears identity, retains immutable auth binding');
select pg_temp.assert(not exists(select 1 from app.credentials) and not exists(select 1 from app.sessions) and not exists(select 1 from app.oauth_states),'disconnect purges credentials sessions and OAuth');
select pg_temp.assert(not exists(select 1 from app.jobs where epoch is not null),'disconnect invalidates then purges account jobs');
select pg_temp.assert(not public.app_job_finish((select (value->>'id')::uuid from snapshots where name='inflight'),(select (value->>'leaseToken')::uuid from snapshots where name='inflight'),'done'),'inflight old worker cannot resurrect');
select pg_temp.assert(not public.app_token_finish(1,(select (value->>'lease')::uuid from snapshots where name='inflight_refresh'),'resurrected',now()+interval '1 hour'),'inflight old refresh cannot resurrect');
select pg_temp.assert(not public.app_connect(1,'synthetic-account',repeat('a',64),true,'late-oauth',now()+interval '1 hour',now(),repeat('b',64),false),'inflight old OAuth cannot reconnect');
select pg_temp.assert(public.app_job_claim()->>'kind'='purge_backups','system backup purge remains runnable after disconnect');
select pg_temp.assert(public.app_disconnect_finish(2),'verified backup purge completes disconnect');
do $$ begin
 begin perform public.app_connect(2,'other-account',repeat('c',64),true,'evil',now()+interval '1 hour',now(),repeat('c',64),false);
 raise exception 'owner rebound unexpectedly'; exception when raise_exception then if sqlerrm<>'wrong_account' then raise; end if; end;
end $$;
select pg_temp.assert(public.app_connect(2,'synthetic-account',repeat('a',64),false,'new',now()+interval '1 hour',now(),repeat('b',64),false),'same immutable account reconnects without profile ID check');
select pg_temp.assert(not exists(select 1 from app.jobs where epoch=1),'reconnect never revives cancelled work');
-- A dead worker's refresh might have rotated remotely; expiry must require reconnect, not reuse.
select public.app_token_claim(2,1);
update app.credentials set refresh_until=now()-interval '1 second';
select pg_temp.assert(public.app_token_claim(2)->>'action'='reconnect','ambiguous refresh requires reconnect');
select pg_temp.assert(not exists(select 1 from app.credentials),'ambiguous refresh clears unusable credentials');
select pg_temp.assert(public.app_session(repeat('b',64))->>'state'='reconnect','existing owner session remains for annotations');
rollback;
