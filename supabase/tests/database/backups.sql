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
select pg_temp.check((select jsonb_array_length(value)=2 from context where key='obsolete'),'two old daily copies retired');
-- Metadata presence independently prevents a false cleanup receipt.
insert into storage.buckets select 'annotation-backups-e'||epoch||'-'||id from app.annotation_backups where state='retired';
select pg_temp.check(not public.app_backup_retention_finish(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),(select value from context where key='obsolete')),'retention cannot claim removal while bucket remains');
delete from storage.buckets where id<>'annotation-backups';
select pg_temp.check(public.app_backup_retention_finish(1,(select (value->>'id')::uuid from context where key='job'),(select (value->>'leaseToken')::uuid from context where key='job'),(select value from context where key='obsolete')),'confirmed absent retired buckets');
select public.app_disconnect(1);
select pg_temp.check((select count(*)=5 from app.annotation_backups),'disconnect keeps redacted purge registry');
insert into storage.buckets select 'annotation-backups-e'||epoch||'-'||id from app.annotation_backups limit 1;
select pg_temp.check(not public.app_disconnect_finish(2),'bucket absence is required for disconnect completion');
delete from storage.buckets where id<>'annotation-backups';
select pg_temp.check(public.app_disconnect_finish(2),'disconnect finishes only after verified absence');
select pg_temp.expect($q$select public.app_backup_restore(1,repeat('a',64),6,(select value from context where key='snapshot'))$q$,'inactive_epoch');
rollback;
