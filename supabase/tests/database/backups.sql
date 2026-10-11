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
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
update app.library_state set encrypted_annotation_key='synthetic-key',annotation_revision=5 where singleton;
delete from app.jobs where id is not null;
insert into app.annotations values(repeat('1',64),1),(repeat('2',64),1);
insert into app.tags(id,epoch,name,normalized_name,deleted_at) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'Chill','chill',null),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'Deleted',null,now());
insert into app.track_tags(track_key,tag_id,present) values
 (repeat('1',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true),
 (repeat('2',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false),
 (repeat('2',64),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
insert into app.jobs(kind,epoch) values('annotation_backup',1);
create temp table context(key text primary key,value jsonb);
insert into context values('job',public.app_job_claim());
insert into context values('plan',public.app_backup_prepare(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job')));
select pg_temp.check((select jsonb_array_length(value#>'{snapshot,tags}')=1 and jsonb_array_length(value#>'{snapshot,assignments}')=1 from context where key='plan'),'only live vocabulary and present assignments');
select pg_temp.check(not ((select value->'snapshot' from context where key='plan') ?| array['encryptedKey','metadata','sessions','credentials','jobs']),'no secret or product cache in document');
select pg_temp.check(public.app_backup_bucket_start(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),(select (value#>>'{snapshot,id}')::uuid from context where key='plan')),'first bucket create intent');
select pg_temp.check(not public.app_backup_bucket_start(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),(select (value#>>'{snapshot,id}')::uuid from context where key='plan')),'never recreate same bucket identity');
select pg_temp.check(public.app_backup_upload_allowed(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),(select (value#>>'{snapshot,id}')::uuid from context where key='plan')),'confirm bucket before upload');
select pg_temp.check(public.app_backup_commit(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),(select (value#>>'{snapshot,id}')::uuid from context where key='plan'),5,encode(sha256(convert_to('synthetic-key','UTF8')),'hex')),'record confirmed daily copy');
insert into context values('snapshot',(select value->'snapshot'||jsonb_build_object('keyLink',encode(sha256(convert_to('synthetic-key','UTF8')),'hex')) from context where key='plan'));
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('c',64),5,(select value from context where key='snapshot'))$q$,'invalid_input');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),4,(select value from context where key='snapshot'))$q$,'stale_revision');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select value||'{"keyVersion":2}' from context where key='snapshot'))$q$,'invalid_input');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select value||'{"extra":"forbidden"}' from context where key='snapshot'))$q$,'invalid_input');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select value||jsonb_build_object('keyLink',repeat('c',64)) from context where key='snapshot'))$q$,'invalid_input');
-- Direct service RPC calls cannot smuggle NULL or string scalar versions around
-- the codec. Rejected attempts leave all durable annotation state unchanged.
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select value||'{"version":null}' from context where key='snapshot'))$q$,'invalid_input');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select value||'{"version":"1"}' from context where key='snapshot'))$q$,'invalid_input');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select value||'{"keyVersion":null}' from context where key='snapshot'))$q$,'invalid_input');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select value||'{"keyVersion":"1"}' from context where key='snapshot'))$q$,'invalid_input');
select pg_temp.check((select annotation_revision=5 from app.library_state),'invalid version leaves revision unchanged');
select pg_temp.check((select count(*)=2 from app.tags) and (select count(*)=2 from app.track_tags where present),'invalid version leaves vocabulary and assignments unchanged');
-- UUID spelling cannot hide a duplicated logical assignment from the SQL boundary.
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select jsonb_set(value,'{assignments}',jsonb_build_array(value->'assignments'->0,(value->'assignments'->0)||jsonb_build_object('tagId',upper(value#>>'{assignments,0,tagId}')))) from context where key='snapshot'))$q$,'invalid_input');
select pg_temp.check((select annotation_revision=5 from app.library_state) and (select count(*)=2 from app.track_tags where present),'duplicate logical UUID edge leaves state unchanged');
-- A valid compact codec document near its budget exceeds the former JSONB-text
-- budget solely because PostgreSQL adds separators. It must actually restore.
savepoint near_limit;
insert into context values('near', (select value||jsonb_build_object('assignments',(select jsonb_agg(jsonb_build_object('trackKey',lpad(to_hex(i),64,'0'),'tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) from generate_series(1,29000)i)) from context where key='snapshot'));
select pg_temp.check((select octet_length(value::text)>3750000 and octet_length(value::text)<=4264933 from context where key='near'),'near-limit expanded JSONB exceeds former limit');
select pg_temp.check((public.app_backup_restore(1,repeat('a',64),5,(select value from context where key='near'))->>'restoredAssignments')::integer=29000,'near-limit snapshot SQL restore');
select pg_temp.check((select count(*)=29000 from app.track_tags where present),'near-limit restore exact assignment count');
rollback to savepoint near_limit;
-- OAuth expiry parks Spotify work but keeps annotation-only backups leased,
-- schedulable and runnable while authenticated editing remains available.
savepoint reconnect_backup;
insert into app.jobs(kind,epoch) values('library_sync',1),('playlist',1);
update app.account set authorization_deadline=now()-interval '1 second' where singleton;
select pg_temp.check(public.app_token_claim(1)->>'action'='reconnect','expired authorization enters reconnect');
select pg_temp.check((select state='running' from app.jobs where id=(select (value->>'id')::uuid from context where key='job')),'token failure preserves active backup lease');
select pg_temp.check((select count(*)=2 from app.jobs where epoch=1 and kind in ('library_sync','playlist') and state='parked'),'Spotify jobs remain parked');
select pg_temp.check(public.app_job_renew((select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job')),'backup lease renews during reconnect');
select pg_temp.check(public.app_backup_prepare(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job')) is not null,'backup snapshots annotations during reconnect');
select pg_temp.check(public.app_job_finish((select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),'done'),'backup completes during reconnect');
update app.annotation_backups set day=day-1 where epoch=1 and state='retained';
select app.library_maintenance();
insert into context values('reconnect_job',public.app_job_claim());
select pg_temp.check((select value->>'kind'='annotation_backup' from context where key='reconnect_job'),'daily backup scheduled and claimed during reconnect');
select pg_temp.expect($q$select public.app_job_enqueue('library_sync',1)$q$,'inactive_epoch');
select public.app_disconnect(1);
select pg_temp.check(public.app_backup_prepare(1,(select (value->>'id')::uuid from context where key='reconnect_job'),(select (value->>'leaseToken')::uuid from context where key='reconnect_job')) is null,'disconnect still fences annotation backup during reconnect');
rollback to savepoint reconnect_backup;
savepoint reconnect_refresh_failure;
insert into app.jobs(kind,epoch) values('library_sync',1),('playlist',1);
update app.credentials set access_expires_at=now()-interval '1 second' where epoch=1;
insert into context values('refresh_claim',public.app_token_claim(1));
select pg_temp.check((select value->>'action'='refresh' from context where key='refresh_claim'),'synthetic refresh lease');
select pg_temp.check(public.app_token_fail(1,(select (value->>'lease')::uuid from context where key='refresh_claim'),true),'refresh failure enters reconnect');
select pg_temp.check((select state='running' from app.jobs where id=(select (value->>'id')::uuid from context where key='job')),'refresh failure preserves backup lease');
select pg_temp.check((select count(*)=2 from app.jobs where epoch=1 and kind in ('library_sync','playlist') and state='parked'),'refresh failure still parks Spotify jobs');
rollback to savepoint reconnect_refresh_failure;

-- Subsequent new vocabulary disappears into a UUID tombstone, not a query mutation.
insert into app.tags(id,epoch,name,normalized_name) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,'Later','later');
insert into app.track_tags(track_key,tag_id,present) values(repeat('2',64),'cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
select pg_temp.check((public.app_backup_restore(1,repeat('a',64),5,(select value from context where key='snapshot'))->>'restoredTags')::integer=1,'isolated annotation restore');
select pg_temp.check((select annotation_revision=6 from app.library_state),'restore advances revision');
select pg_temp.check((select deleted_at is not null and normalized_name is null from app.tags where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),'later query leaf remains tombstone');
select pg_temp.check((select count(*)=1 from app.track_tags where present),'restore exact present assignments');
select pg_temp.check(exists(select 1 from app.sessions),'restore does not modify sessions');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),5,(select value from context where key='snapshot'))$q$,'stale_revision');
-- Daily retention is independent of creation order and keeps three successes.
insert into app.annotation_backups(epoch,day,state,revision,key_link,committed_at)
 select 1,(now() at time zone 'UTC')::date-i,'retained',0,repeat('1',64),now() from generate_series(1,4)i;
insert into context values('obsolete',public.app_backup_retention(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job')));
select pg_temp.check((select count(*)=3 from app.annotation_backups where state='retained'),'retain exactly three successful UTC-day copies');
select pg_temp.check((select jsonb_array_length(value)=1 from context where key='obsolete'),'retired target batch is bounded to one');
-- Metadata presence independently prevents a false cleanup receipt.
insert into storage.buckets select 'annotation-backups-e'||epoch||'-'||id from app.annotation_backups where state='retired';
select pg_temp.check(not public.app_backup_retention_finish(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),(select value from context where key='obsolete')),'retention cannot claim removal while bucket remains');
delete from storage.buckets where id<>'annotation-backups';
select pg_temp.check(public.app_backup_retention_finish(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),(select value from context where key='obsolete')),'confirmed absent retired buckets');
select pg_temp.check(jsonb_array_length(public.app_backup_retention(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job')))=1,'next retry returns only unconfirmed target');
select pg_temp.check(public.app_backup_retention_finish(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),public.app_backup_retention(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'))),'second target progress checkpoint');
select public.app_disconnect(1);
select pg_temp.check((select count(*)=5 from app.annotation_backups),'disconnect keeps redacted purge registry');
insert into storage.buckets select 'annotation-backups-e'||epoch||'-'||id from app.annotation_backups limit 1;
select pg_temp.check(not public.app_disconnect_finish(2),'bucket absence is required for disconnect completion');
delete from storage.buckets where id<>'annotation-backups';
insert into context values('purge_job',public.app_job_claim());
select pg_temp.check(jsonb_array_length(public.app_backup_purge_targets(2))=1,'disconnect targets are bounded');
select pg_temp.check(public.app_backup_purge_checkpoint(2,(select (value->>'id')::uuid from context where key='purge_job'),(select (value->>'leaseToken')::uuid from context where key='purge_job'),public.app_backup_purge_targets(2)->>0),'confirmed disconnect target checkpoint');
select pg_temp.check((select count(*)=3 from app.annotation_backups where purged_at is not null),'checkpoint preserves earlier cleanup progress');
select pg_temp.check(public.app_disconnect_finish(2),'disconnect finishes only after verified absence');
select pg_temp.expect($q$select public.app_backup_purge_targets(2)$q$,'inactive_epoch');
-- A later disconnect skips confirmed-absent old registry targets.
select public.app_connect(2,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),null,false);
select public.app_disconnect(2);
select pg_temp.check(jsonb_array_length(public.app_backup_purge_targets(3))=0,'later disconnect does not rescan purged registry');
select pg_temp.check(public.app_disconnect_finish(3),'empty later epoch disconnect finishes');

select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),6,(select value from context where key='snapshot'))$q$,'inactive_epoch');
rollback;
