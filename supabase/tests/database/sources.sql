-- Synthetic content only; all fixtures roll back.
begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
update app.jobs set state='done' where id is not null;
update app.library_state set encrypted_annotation_key='synthetic-key',sources_discovered_at=now() where singleton;
insert into app.sources(epoch,id,kind,name,last_synced_at) values(1,repeat('p',22),'playlist','Synthetic source',now());
insert into app.annotations values(repeat('1',64),1),(repeat('2',64),1);
insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id)
 values(repeat('1',64),repeat('1',22),'Synthetic track one','[]','Synthetic album',now(),gen_random_uuid()),
 (repeat('2',64),repeat('2',22),'Synthetic track two','[]','Synthetic album',now(),gen_random_uuid());
insert into app.source_memberships values(1,'liked',repeat('1',64),now()),(1,repeat('p',22),repeat('1',64),now()),(1,repeat('p',22),repeat('2',64),now());
insert into app.tags(id,epoch,name,normalized_name) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'Synthetic tag','synthetic tag');
insert into app.track_tags(track_key,tag_id,present) values(repeat('2',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select app.refresh_source_pool(1);
select pg_temp.assert(public.app_sources_list(1)->>'uniqueTrackCount'='2','overlap deduplicates stable Spotify identity');
select public.app_sources_selection(1,jsonb_build_array(repeat('p',22)),false);
select pg_temp.assert((select removed_at is null from app.track_metadata where track_key=repeat('1',64)),'another enabled membership keeps active');
select pg_temp.assert((select removed_at is not null from app.track_metadata where track_key=repeat('2',64)),'last disabled membership soft removes');
select pg_temp.assert((select present from app.track_tags where track_key=repeat('2',64)),'soft removal retains tag annotation');
select public.app_sources_selection(1,jsonb_build_array(repeat('p',22)),true);
select pg_temp.assert((select removed_at is null from app.track_metadata where track_key=repeat('2',64)),'cached membership restores without provider read');
do $$ begin
 begin perform public.app_sources_selection(1,jsonb_build_array('liked','unknown'),false); raise exception 'unknown accepted'; exception when raise_exception then if sqlerrm<>'unknown_source' then raise; end if; end;
end $$;
select pg_temp.assert((select enabled from app.sources where id='liked'),'selection unknown IDs rollback atomically');
-- Source paging must fence the lease, offset, selection and snapshot before removals.
insert into app.jobs(id,epoch,kind,state,lease_token,lease_until) values('11111111-1111-4111-8111-111111111111',1,'source_sync','running','22222222-2222-4222-8222-222222222222',now()+interval '1 hour');
insert into app.source_scans(job_id,epoch,source_id) values('11111111-1111-4111-8111-111111111111',1,repeat('p',22));
select pg_temp.assert(public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111',gen_random_uuid(),0,0,0,null,'snapshot-one','[]',0,0) is null,'stale lease cannot write');
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,0,0,null,'snapshot-one','[]',0,0);
select pg_temp.assert((select count(*)=3 from app.source_memberships),'terminal page alone cannot remove membership');
select pg_temp.assert(public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','snapshot-two')->>'done'='false','changed after snapshot resets walk');
select pg_temp.assert((select count(*)=3 from app.source_memberships),'failed snapshot retains previous memberships');
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,0,0,null,'snapshot-two','[]',0,0);
select public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','snapshot-two');
select pg_temp.assert((select count(*)=1 from app.source_memberships),'complete validated empty source reconciles only its memberships');
select pg_temp.assert((select removed_at is null from app.track_metadata where track_key=repeat('1',64)),'source scan preserves liked membership');
select pg_temp.assert((select removed_at is not null from app.track_metadata where track_key=repeat('2',64)),'validated removal soft removes last member');
select pg_temp.assert((select present from app.track_tags where track_key=repeat('2',64)),'validated removal keeps annotations');
-- Forbidden reads never clear membership; unavailable status is explicit.
insert into app.source_memberships values(1,repeat('p',22),repeat('2',64),now());
select app.refresh_source_pool(1);
select public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',null,'forbidden');
select pg_temp.assert((select not available and error_code='forbidden' from app.sources where id=repeat('p',22)),'unavailable source honest');
select pg_temp.assert((select removed_at is null from app.track_metadata where track_key=repeat('2',64)),'access loss retains prior active membership');
-- Existing liked reconciliation can never remove playlist-only tracks.
select app.start_liked_walk(1);
update app.jobs set state='running',lease_token='33333333-3333-4333-8333-333333333333',lease_until=now()+interval '1 hour' where kind='library_sync' and state='queued';
do $$ declare r app.sync_runs; j app.jobs; begin
 for n in 1..2 loop
  select * into r from app.sync_runs where id=(select latest_run_id from app.library_state where singleton);
  select * into j from app.jobs where id=r.job_id;
  perform public.app_library_page_commit(1,j.id,j.lease_token,r.pass,0,0,0,null,'[]',0,'{}');
 end loop;
end $$;
select pg_temp.assert((select removed_at is null from app.track_metadata where track_key=repeat('2',64)),'liked global reconciliation preserves playlist-only active track');
select pg_temp.assert(not exists(select 1 from app.source_memberships where source_id='liked'),'completed empty liked reconciles liked only');
select public.app_disconnect(1);
select public.app_disconnect_finish(2);
select pg_temp.assert(not exists(select 1 from app.sources) and not exists(select 1 from app.source_memberships),'disconnect clears source metadata and memberships');
rollback;
