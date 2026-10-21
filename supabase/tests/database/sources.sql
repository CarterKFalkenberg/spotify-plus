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

-- A rescan whose playlist date differs from the preserved liked date does not
-- turn an acknowledged overlapping song into a false arrival.
insert into app.source_memberships values(1,'liked',repeat('1',64),'2026-01-01'),(1,repeat('p',22),repeat('1',64),'2026-02-02') on conflict(epoch,source_id,track_key) do update set added_at=excluded.added_at;
update app.track_metadata set liked_at='2026-01-01',removed_at=null,acknowledged_at=now() where track_key=repeat('1',64);
update app.source_scans set next_offset=0,snapshot_id=null,total=null,received=0,invalid=false where job_id='11111111-1111-4111-8111-111111111111';
delete from app.source_seen where job_id='11111111-1111-4111-8111-111111111111';
create function pg_temp.source_row(k text,missing boolean default false) returns jsonb language sql as $$
 select jsonb_build_array(jsonb_build_object('trackKey',repeat(k,64),'spotifyId',repeat(k,22),'title','Synthetic track '||k,'artists','[]'::jsonb,'album','Synthetic album','durationMs',1000,'explicit',false,'likedAt','2026-02-02T00:00:00Z','addedAtMissing',missing));
$$;
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,1,1,null,'ack-snapshot',pg_temp.source_row('1'),0,0);
select pg_temp.assert((select acknowledged_at is not null and liked_at='2026-01-01' from app.track_metadata where track_key=repeat('1',64)),'unrelated playlist rescan preserves acknowledgment and actual liked date');
-- Missing remote dates persist the first successful discovery date, including
-- repeated rescan/restart. A known prior date also survives a missing response.
update app.source_scans set next_offset=0,snapshot_id=null,total=null,received=0,invalid=false where job_id='11111111-1111-4111-8111-111111111111';
delete from app.source_seen where job_id='11111111-1111-4111-8111-111111111111';
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,1,1,null,'missing-snapshot',pg_temp.source_row('3',true),0,0);
create temp table first_discovery as select added_at from app.source_memberships where source_id=repeat('p',22) and track_key=repeat('3',64);
select pg_temp.assert((select added_at=now() from first_discovery),'missing addition date is first discovery rather than epoch');
-- Simulate the next day without sleeping inside this rollback transaction.
update first_discovery set added_at=added_at-interval '1 day';
update app.source_memberships set added_at=(select added_at from first_discovery) where source_id=repeat('p',22) and track_key=repeat('3',64);
update app.source_scans set next_offset=0,snapshot_id=null,total=null,received=0,invalid=false where job_id='11111111-1111-4111-8111-111111111111';
delete from app.source_seen where job_id='11111111-1111-4111-8111-111111111111';
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,1,1,null,'missing-snapshot-two',pg_temp.source_row('3',true),0,0);
select pg_temp.assert((select sm.added_at=d.added_at from app.source_memberships sm cross join first_discovery d where sm.source_id=repeat('p',22) and sm.track_key=repeat('3',64)),'missing date stays stable across repeated scans');
-- Discovery records followed playlists rather than silently filtering them.
insert into app.jobs(id,epoch,kind,state,lease_token,lease_until) values('44444444-4444-4444-8444-444444444444',1,'source_discovery','running','55555555-5555-4555-8555-555555555555',now()+interval '1 hour');
insert into app.source_scans(job_id,epoch) values('44444444-4444-4444-8444-444444444444',1);
select public.app_source_discovery_commit(1,'44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',0,1,1,null,jsonb_build_array(jsonb_build_object('id',repeat('f',22),'name','Synthetic followed','total',7,'eligible',false)));
select pg_temp.assert(exists(select 1 from app.sources where id=repeat('f',22)),'followed playlist remains visible pending actual access proof');
select public.app_source_discovery_commit(1,'44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',0,1,1,null,jsonb_build_array(jsonb_build_object('id',repeat('f',22),'name','Synthetic followed','total',7,'eligible',false)));
update app.jobs set state='done' where id is not null and kind='source_sync';
insert into app.jobs(id,epoch,kind,state,lease_token,lease_until) values('66666666-6666-4666-8666-666666666666',1,'source_sync','running','77777777-7777-4777-8777-777777777777',now()+interval '1 hour');
insert into app.source_scans(job_id,epoch,source_id) values('66666666-6666-4666-8666-666666666666',1,repeat('f',22));
select pg_temp.assert(not (public.app_library_status(1)->>'initialSyncComplete')::boolean,'unknown access first import gates generation');
select public.app_source_finish(1,'66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777',null,'forbidden');
select pg_temp.assert(exists(select 1 from app.sources where id=repeat('f',22) and enabled and not available and error_code='forbidden'),'confirmed inaccessible followed source remains visible with preference intact');
select pg_temp.assert((public.app_library_status(1)->>'initialSyncComplete')::boolean,'confirmed unavailable first source no longer blocks completed accessible pool');
select public.app_source_page_commit(1,'66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777',0,2,1,1,'recovered-snapshot',pg_temp.source_row('4'),0,0);
select pg_temp.assert(not (public.app_library_status(1)->>'initialSyncComplete')::boolean,'recovered access gates generation during incomplete first walk');
select public.app_disconnect(1);
select public.app_disconnect_finish(2);
select pg_temp.assert(not exists(select 1 from app.sources) and not exists(select 1 from app.source_memberships),'disconnect clears source metadata and memberships');
rollback;
