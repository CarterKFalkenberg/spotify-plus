begin;
create function pg_temp.check(ok boolean,message text) returns void language plpgsql as $$
 begin if ok is distinct from true then raise exception 'Assertion: %',message; end if; end;
$$;
create function pg_temp.expect(statement text,message text) returns void language plpgsql as $$
 begin
  begin execute statement; exception when others then
   if sqlerrm=message then return; end if;
   raise exception 'Expected %, got %',message,sqlerrm;
  end;
  raise exception 'Expected failure: %',message;
 end;
$$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic-ciphertext',now()+interval '1 hour',now(),repeat('b',64),true);
-- The real migration004 connect trigger creates library state and initial work.
select pg_temp.check(exists(select 1 from app.library_state where epoch=1),'connected library state');
insert into app.annotations(track_key,epoch) select lpad(i::text,64,'0'),1 from generate_series(1,252) i;
insert into app.track_metadata(track_key,spotify_id,title,artists,album,duration_ms,playable_uri,liked_at,removed_at,added_run_id)
 select lpad(i::text,64,'0'),lpad(i::text,22,'0'),'Synthetic track','[]','Synthetic album',1000,
 case when i=251 then null else 'spotify:track:'||lpad(i::text,22,'0') end,
 '2026-01-01'::timestamptz+make_interval(secs=>i),case when i=252 then now() else null end,gen_random_uuid()
 from generate_series(1,252) i;
insert into app.tags(id,epoch,name,normalized_name) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'Synthetic','synthetic'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'Excluded','excluded');
insert into app.track_tags(track_key,tag_id,present) select track_key,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true from app.annotations;
create temp table test_data(key text primary key,value jsonb);
insert into test_data values('request',jsonb_build_object('requestId','11111111-1111-4111-8111-111111111111',
 'query','{"version":1,"root":{"op":"and","children":[{"op":"tag","tagId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},{"op":"not","child":{"op":"or","children":[{"op":"tag","tagId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}]}}]}}'::jsonb,
 'previewRevision',app.library_revision(),'name','Synthetic snapshot','retention','month'));
select pg_temp.expect($q$select public.app_playlist_create(1,(select value from test_data where key='request'))$q$,'initial_sync_incomplete');
update app.library_state set initial_sync_complete=true where singleton=true;
select pg_temp.expect($q$select public.app_playlist_create(1,(select jsonb_set(value,'{previewRevision,library}','"9"') from test_data where key='request'))$q$,'stale_revision');
insert into test_data values('created',public.app_playlist_create(1,(select value from test_data where key='request')));
select pg_temp.check((select (value#>>'{playlist,trackCount}')::integer=250 from test_data where key='created'),'exclude unavailable and removed matches');
select pg_temp.check((select cardinality(target)=250 and target[1]='spotify:track:'||lpad('250',22,'0') and target[250]='spotify:track:'||lpad('1',22,'0') from app.playlist_operations),'frozen newest first');
-- Duplicate same intent wins before stale revision; changed intent conflicts.
update app.library_state set annotation_revision=annotation_revision+1 where singleton=true;
select pg_temp.check(public.app_playlist_create(1,(select value from test_data where key='request'))=(select value from test_data where key='created'),'create dedupe before revision');
select pg_temp.expect($q$select public.app_playlist_create(1,(select value||'{"name":"Different"}' from test_data where key='request'))$q$,'request_conflict');
select pg_temp.check((select count(*)=1 from app.playlists),'one managed record');
select pg_temp.expect($q$select public.app_playlist_create(1,(select jsonb_set(jsonb_set(value||jsonb_build_object('requestId','22222222-2222-4222-8222-222222222222','previewRevision',app.library_revision()),'{query,root,children,1,child,children,0,tagId}','"cccccccc-cccc-4ccc-8ccc-cccccccccccc"'),'{name}','"Unknown tag"') from test_data where key='request'))$q$,'unknown_tag');
select pg_temp.expect($q$select public.app_playlist_create(1,(select value||jsonb_build_object('requestId','22222222-2222-4222-8222-222222222222','previewRevision',app.library_revision(),'query','{"version":1,"root":{"op":"tag","tagId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}}'::jsonb) from test_data where key='request'))$q$,'no_playable_matches');
insert into test_data values('claim',public.app_job_claim());
select pg_temp.check((select value->>'kind'='playlist' from test_data where key='claim'),'explicit playlist priority beats ambient initial sync');
select pg_temp.check(public.app_playlist_fence((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim')),'active lease');
select pg_temp.check(not public.app_playlist_fence((select (value->>'id')::uuid from test_data where key='claim'),gen_random_uuid()),'wrong lease rejected');
select pg_temp.check(public.app_playlist_checkpoint((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),'{"createAttempted":true,"spotifyId":"pppppppppppppppppppppp"}'),'confirm Spotify id');
select pg_temp.check(public.app_playlist_managed(1,'pppppppppppppppppppppp'),'adapter identity guard');
select pg_temp.check(not public.app_playlist_managed(1,'xxxxxxxxxxxxxxxxxxxxxx'),'unmanaged guard');
select pg_temp.expect($q$select public.app_playlist_action(1,(select id from app.playlists),jsonb_build_object('requestId',gen_random_uuid(),'expectedRevision',(select revision::text from app.playlists),'action','pin'))$q$,'playlist_busy');
select pg_temp.check(public.app_playlist_failed((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),'description_capacity',1000),'failure visible');
select pg_temp.check((select state='parked' from app.jobs where id=(select (value->>'id')::uuid from test_data where key='claim')),'permanent failure parks');
insert into test_data values('retry',jsonb_build_object('requestId',gen_random_uuid(),'expectedRevision',(select revision::text from app.playlists),'action','retry'));
select public.app_playlist_action(1,(select id from app.playlists),(select value from test_data where key='retry'));
select pg_temp.check((select count(*)=1 from app.playlist_operations),'Retry reuses frozen operation');
select pg_temp.check((select create_attempted and cardinality(target)=250 from app.playlist_operations),'Retry preserves creation ambiguity and target');
update test_data set value=public.app_job_claim() where key='claim';
-- Fake remote confirmation is only used inside this synthetic SQL transaction.
select pg_temp.check(public.app_playlist_complete((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),app.playlist_expiry(now(),'month'),'Owner renamed'),'ready checkpoint');
select public.app_job_finish((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),'done');
select pg_temp.check((select status='ready' and active_operation is null and name='Owner renamed' from app.playlists),'confirmed ready only');
select pg_temp.expect($q$select public.app_playlist_action(1,(select id from app.playlists),jsonb_build_object('requestId',gen_random_uuid(),'expectedRevision','0','action','pin'))$q$,'stale_revision');
insert into test_data values('pin',jsonb_build_object('requestId',gen_random_uuid(),'expectedRevision',(select revision::text from app.playlists),'action','pin'));
insert into test_data values('pinResult',public.app_playlist_action(1,(select id from app.playlists),(select value from test_data where key='pin')));
select pg_temp.check(public.app_playlist_action(1,(select id from app.playlists),(select value from test_data where key='pin'))=(select value from test_data where key='pinResult'),'action dedupe before stale revision');
select pg_temp.expect($q$select public.app_playlist_action(1,(select id from app.playlists),(select value||'{"action":"delete"}' from test_data where key='pin'))$q$,'request_conflict');
update test_data set value=public.app_job_claim() where key='claim';
select public.app_playlist_complete((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),null,'Owner renamed');
select public.app_job_finish((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),'done');
select pg_temp.check((select retention='pinned' and expires_on is null from app.playlists),'pin confirms both retention and null expiry');
select public.app_playlist_action(1,(select id from app.playlists),jsonb_build_object('requestId',gen_random_uuid(),'expectedRevision',(select revision::text from app.playlists),'action','unpin','retention','week'));
update test_data set value=public.app_job_claim() where key='claim';
select public.app_playlist_complete((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),app.playlist_expiry(now(),'week'),'Owner renamed');
select public.app_job_finish((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),'done');
select pg_temp.check((select expires_on=(now() at time zone 'America/New_York')::date+7 from app.playlists),'unpin starts fresh date');
-- Regenerate re-evaluates a nested stored AST against current cache, but its
-- saved ordered target cannot change while the worker writes.
update app.track_tags set present=false where track_key=lpad('250',64,'0');
update app.library_state set annotation_revision=annotation_revision+1 where singleton;
select public.app_playlist_action(1,(select id from app.playlists),jsonb_build_object('requestId',gen_random_uuid(),'expectedRevision',(select revision::text from app.playlists),'action','regenerate'));
select pg_temp.check((select track_count=249 from app.playlists),'new frozen regeneration count');
select pg_temp.check((select cardinality(target)=249 from app.playlist_operations where state='active'),'regeneration target frozen');
update app.track_tags set present=false where track_key=lpad('249',64,'0');
select pg_temp.check((select cardinality(target)=249 from app.playlist_operations where state='active'),'later tag edit does not change target');
select public.app_playlist_schedule();
select pg_temp.check((select count(*)=1 from app.playlist_operations where state='active'),'cleanup cannot race regeneration');
update test_data set value=public.app_job_claim() where key='claim';
update app.jobs set lease_until=now()-interval '1 second' where id=(select (value->>'id')::uuid from test_data where key='claim');
select pg_temp.check(not public.app_playlist_checkpoint((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),'{"scan":null}'),'expired lease cannot commit');
update test_data set value=public.app_job_claim() where key='claim';
select public.app_playlist_complete((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),app.playlist_expiry(now(),'week'),'Owner renamed');
select public.app_job_finish((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),'done');
update app.playlists set expires_on=(now() at time zone 'America/New_York')::date where id is not null;
select public.app_playlist_schedule();
select pg_temp.check(not exists(select 1 from app.playlist_operations where state='active'),'valid through displayed date');
update app.playlists set expires_on=(now() at time zone 'America/New_York')::date-1 where id is not null;
select app.library_maintenance();
select pg_temp.check((select kind='expire' from app.playlist_operations where state='active'),'natural due cleanup queued');
select pg_temp.expect($q$select public.app_playlist_action(1,(select id from app.playlists),jsonb_build_object('requestId',gen_random_uuid(),'expectedRevision',(select revision::text from app.playlists),'action','pin'))$q$,'playlist_busy');
update test_data set value=public.app_job_claim() where key='claim';
select public.app_playlist_complete((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),null,'Owner renamed',true);
select pg_temp.check((public.app_playlist_list(1)->'playlists')='[]'::jsonb,'confirmed removal disappears from list');
select pg_temp.check((public.app_playlist_list(1)->>'lastCleanupAt') is not null,'cleanup success recorded');
-- Calendar semantics independently tested by PostgreSQL's actual date engine.
select pg_temp.check(app.playlist_expiry('2026-01-31T23:30Z','month')='2026-02-28','month clamp');
select pg_temp.check(app.playlist_expiry('2028-01-31T23:30Z','month')='2028-02-29','leap clamp');
select pg_temp.check(app.playlist_expiry('2026-11-30T23:30Z','threeMonths')='2027-02-28','three month clamp');
select pg_temp.check(app.playlist_expiry('2026-03-09T03:30Z','week')='2026-03-15','spring DST local date');
select pg_temp.check(app.playlist_expiry('2026-11-02T04:30Z','week')='2026-11-08','autumn DST local date');
-- Stalled known-ID writes remain disposable. Explicit Delete and unattended
-- expiry both fence the old operation before attempting playlist-only removal.
do $$
 declare mode text; v jsonb; req jsonb; old_job jsonb; new_job jsonb; pid uuid; i integer;
 begin
  for mode in select unnest(array['delete','expire']) loop
   select value||jsonb_build_object('requestId',gen_random_uuid(),'previewRevision',app.library_revision()) into req from test_data where key='request';
   v:=public.app_playlist_create(1,req); pid:=(v#>>'{playlist,id}')::uuid;
   old_job:=public.app_job_claim();
   perform public.app_playlist_checkpoint((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,
    jsonb_build_object('spotifyId',case when mode='delete' then repeat('q',22) else repeat('r',22) end));
   perform public.app_playlist_failed((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,'description_capacity',1000);
   if mode='delete' then
    perform public.app_playlist_action(1,pid,jsonb_build_object('requestId',gen_random_uuid(),
     'expectedRevision',(select revision::text from app.playlists where id=pid),'action','delete'));
   else
    update app.playlists set expires_on=(now() at time zone 'America/New_York')::date-1 where id=pid;
    perform public.app_playlist_schedule();
   end if;
   perform pg_temp.check((select status='removing' from app.playlists where id=pid),'stalled managed write can be disposed');
   perform pg_temp.check(not public.app_playlist_checkpoint((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,'{"scan":null}'),'disposal fences old worker');
   new_job:=public.app_job_claim();
   perform pg_temp.check((select kind=mode from app.playlist_operations where job_id=(new_job->>'id')::uuid),'correct disposal intent');
   for i in 1..6 loop
    perform public.app_playlist_failed((new_job->>'id')::uuid,(new_job->>'leaseToken')::uuid,'network',1000);
    perform pg_temp.check((select state='active' from app.playlist_operations where job_id=(new_job->>'id')::uuid),'cleanup keeps bounded retries after five outages');
    perform public.app_job_finish((new_job->>'id')::uuid,(new_job->>'leaseToken')::uuid,'queued');
    new_job:=public.app_job_claim();
   end loop;
   perform pg_temp.check(public.app_playlist_list(1)->>'cleanupBlockedBy'='unavailable','cleanup reports provider failure');
   perform pg_temp.check(public.app_playlist_complete((new_job->>'id')::uuid,(new_job->>'leaseToken')::uuid,null,'Synthetic',true),'cleanup recovers after provider recovery');
   perform public.app_job_finish((new_job->>'id')::uuid,(new_job->>'leaseToken')::uuid,'done');
   perform pg_temp.check((select status='removed' from app.playlists where id=pid),'disposed row retired');
  end loop;
 end;
$$;
-- Permanent reconciliation mismatches cannot strand an expired playlist. A live
-- lease remains fenced until release/expiry; takeover then creates one removal.
do $$
 declare mode text; req jsonb; v jsonb; pid uuid; old_op uuid; old_job jsonb; removal jsonb; i integer;
 begin
  for mode in select unnest(array['queued','expired-lease','parked']) loop
   select value||jsonb_build_object('requestId',gen_random_uuid(),'previewRevision',app.library_revision()) into req from test_data where key='request';
   v:=public.app_playlist_create(1,req); pid:=(v#>>'{playlist,id}')::uuid;
   old_job:=public.app_job_claim();
   perform public.app_playlist_checkpoint((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,
    jsonb_build_object('spotifyId',case mode when 'queued' then repeat('s',22) when 'expired-lease' then repeat('t',22) else repeat('u',22) end));
   perform public.app_playlist_complete((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,app.playlist_expiry(now(),'month'),'Synthetic');
   perform public.app_job_finish((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,'done');
   update app.playlists set last_checked_at=now()-interval '2 days' where id=pid;
   perform public.app_playlist_schedule();
   select active_operation into old_op from app.playlists where id=pid;
   perform pg_temp.check((select kind='reconcile' from app.playlist_operations where id=old_op),'stale playlist starts reconciliation');
   old_job:=public.app_job_claim();
   for i in 1..6 loop
    perform public.app_playlist_failed((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,'remote_changed',1000);
    perform public.app_job_finish((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,'queued');
    old_job:=public.app_job_claim();
   end loop;
   perform pg_temp.check((select state='active' and failures=6 from app.playlist_operations where id=old_op),'reconciliation remains retryable after repeated mismatch');
   update app.playlists set expires_on=(now() at time zone 'America/New_York')::date-1 where id=pid;
   perform public.app_playlist_schedule();
   perform pg_temp.check((select active_operation=old_op from app.playlists where id=pid),'expiry cannot supersede live reconciliation lease');
   perform pg_temp.check(public.app_playlist_fence((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid),'live reconciliation fence remains valid');
   if mode='expired-lease' then
    update app.jobs set lease_until=now()-interval '1 second' where id=(old_job->>'id')::uuid;
   else
    perform public.app_job_finish((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,mode);
   end if;
   perform public.app_playlist_schedule();
   perform pg_temp.check((select status='removing' and active_operation<>old_op from app.playlists where id=pid),'expired failed reconciliation becomes removal');
   perform pg_temp.check((select state='cancelled' and lease_token is null and lease_until is null from app.jobs where id=(old_job->>'id')::uuid),'takeover cancels old reconciliation job');
   perform pg_temp.check((select state='done' from app.playlist_operations where id=old_op),'takeover retires old operation');
   perform pg_temp.check(not public.app_playlist_checkpoint((old_job->>'id')::uuid,(old_job->>'leaseToken')::uuid,'{"scan":null}'),'old reconciliation lease cannot checkpoint');
   perform public.app_playlist_schedule();
   perform pg_temp.check((select count(*)=1 from app.playlist_operations where playlist_id=pid and kind='expire'),'repeated maintenance does not duplicate expiry');
   removal:=public.app_job_claim();
   perform pg_temp.check((select playlist_id=pid and kind='expire' from app.playlist_operations where job_id=(removal->>'id')::uuid),'new worker receives playlist-only expiry intent');
   perform public.app_playlist_complete((removal->>'id')::uuid,(removal->>'leaseToken')::uuid,null,'Synthetic',true);
   perform public.app_job_finish((removal->>'id')::uuid,(removal->>'leaseToken')::uuid,'done');
   perform pg_temp.check((select status='removed' from app.playlists where id=pid),'expiry recovers despite permanent reconciliation mismatch');
  end loop;
 end;
$$;
-- The collection uses its own opaque stable cursors, unaffected by library edits.
do $$
 declare req jsonb; first_page jsonb; token text; v jsonb;
 begin
  select value||jsonb_build_object('requestId',gen_random_uuid(),'previewRevision',app.library_revision()) into req from test_data where key='request';
  perform public.app_playlist_create(1,req);
  perform public.app_playlist_create(1,req||jsonb_build_object('requestId',gen_random_uuid()));
  first_page:=public.app_playlist_list(1,null,1); token:=first_page->>'nextCursor';
  perform pg_temp.check(length(token)=64 and jsonb_array_length(first_page->'playlists')=1,'bounded opaque playlist page');
  update app.library_state set annotation_revision=annotation_revision+1 where singleton;
  perform pg_temp.check(jsonb_array_length(public.app_playlist_list(1,token,1)->'playlists')=1,'library changes do not invalidate playlist ordering');
  perform public.app_playlist_create(1,req||jsonb_build_object('requestId',gen_random_uuid(),'previewRevision',app.library_revision()));
  begin perform public.app_playlist_list(1,token,1); raise exception 'stale playlist cursor accepted';
   exception when others then if sqlerrm<>'stale_revision' then raise; end if; end;
 end;
$$;
-- New playlist followed by disconnect proves wrapper purges all feature state.
insert into test_data values('new',public.app_playlist_create(1,(select value||jsonb_build_object('requestId',gen_random_uuid(),'previewRevision',app.library_revision()) from test_data where key='request')));
update test_data set value=public.app_job_claim() where key='claim';
select public.app_disconnect(1);
select pg_temp.check(not public.app_playlist_schedule(),'disconnected owner cannot schedule expiry');
select pg_temp.check(not public.app_playlist_fence((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim')),'disconnect fences remote work');
select pg_temp.check(not public.app_playlist_complete((select (value->>'id')::uuid from test_data where key='claim'),(select (value->>'leaseToken')::uuid from test_data where key='claim'),null,'Late name'),'late response cannot restore data');
select pg_temp.check(not exists(select 1 from app.playlists) and not exists(select 1 from app.playlist_operations) and not exists(select 1 from app.playlist_requests) and not exists(select 1 from app.annotations),'product purge includes playlists and annotations');
select pg_temp.check(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'app_playlist_%' and
 (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))),'playlist RPCs deny browser roles');
set local role anon;
do $$ begin
 begin perform public.app_playlist_list(1); raise exception 'anonymous playlist RPC allowed'; exception when insufficient_privilege then null; end;
 begin perform 1 from app.playlists; raise exception 'anonymous playlist SELECT allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Standalone pg_net/Vault doubles validate dispatch admission and correlation.
-- The separate vendor harness proves real extensions and a genuine cron tick.
create schema vault;
create table vault.decrypted_secrets(name text,decrypted_secret text);
create schema net;
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint
 language plpgsql as $$ begin
  perform pg_temp.check(url='https://synthetic.invalid/functions/v1/jobs' and headers->>'x-cron-secret'='synthetic-cron-secret' and body='{}'::jsonb,'authenticated scheduler contract');
  perform pg_temp.check(timeout_milliseconds=90000,'HTTP response timeout covers bounded worker');
  return 9001;
 end $$;
update app.jobs j set state='cancelled',lease_token=null,lease_until=null where j.id is not null;
update app.runtime_health h set last_maintenance_at=now() where h.singleton=true;
insert into app.cron_dispatches values(1,now()-interval '8 days'),(2,now()-interval '1 day');
select app.scheduler_tick();
select pg_temp.check((select count(*)=1 and min(request_id)=2 from app.cron_dispatches),'retention is bounded and idle ticks do not dispatch');
insert into app.jobs(kind) values('scheduler_ping');
select app.scheduler_tick();
select pg_temp.check((select count(*)=1 from app.cron_dispatches),'missing Vault configuration never dispatches');
insert into vault.decrypted_secrets values('spotify_plus_project_url','https://synthetic.invalid'),('spotify_plus_cron_secret','synthetic-cron-secret');
select app.scheduler_tick();
select pg_temp.check(exists(select 1 from app.cron_dispatches where request_id=9001 and dispatched_at>=now()),'stores actual request id and time only after enqueue');
select pg_temp.check(not has_table_privilege('anon','app.cron_dispatches','SELECT') and not has_table_privilege('authenticated','app.cron_dispatches','SELECT'),'dispatch correlation stays private');
select pg_temp.check(not (public.app_health() ? 'request_id') and not (public.app_health() ? 'dispatched_at'),'health does not expose dispatch audit');
rollback;
