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
select pg_temp.assert((select latest_completed_run_id is null from app.sources where id=repeat('p',22)),'inflight first scan cannot publish a latest-completed cohort');
select pg_temp.assert(public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','snapshot-two')->>'done'='false','changed after snapshot resets walk');
select pg_temp.assert((select count(*)=3 from app.source_memberships),'failed snapshot retains previous memberships');
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,0,0,null,'snapshot-two','[]',0,0);
select public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','snapshot-two');
select pg_temp.assert((select count(*)=1 from app.source_memberships),'complete validated empty source reconciles only its memberships');
select pg_temp.assert((select latest_completed_run_id='11111111-1111-4111-8111-111111111111' from app.sources where id=repeat('p',22)),'validated source publishes its own completed job identity');
select pg_temp.assert((select removed_at is null from app.track_metadata where track_key=repeat('1',64)),'source scan preserves liked membership');
select pg_temp.assert((select removed_at is not null from app.track_metadata where track_key=repeat('2',64)),'validated removal soft removes last member');
select pg_temp.assert((select present from app.track_tags where track_key=repeat('2',64)),'validated removal keeps annotations');
-- Unchanged snapshots still advance the per-source verified cohort, clearing
-- old arrivals without making content requests or republishing an inflight ID.
insert into app.jobs(id,epoch,kind,state,lease_token,lease_until) values('99999999-9999-4999-8999-999999999999',1,'source_sync','running','88888888-8888-4888-8888-888888888888',now()+interval '1 hour');
insert into app.source_scans(job_id,epoch,source_id) values('99999999-9999-4999-8999-999999999999',1,repeat('p',22));
create temp table unchanged_revision as select library_revision from app.library_state where singleton;
select public.app_source_finish(1,'99999999-9999-4999-8999-999999999999','88888888-8888-4888-8888-888888888888','snapshot-two');
select pg_temp.assert((select latest_completed_run_id='99999999-9999-4999-8999-999999999999' from app.sources where id=repeat('p',22)),'unchanged verified snapshot advances latest source cohort');
select pg_temp.assert((select l.library_revision>r.library_revision from app.library_state l cross join unchanged_revision r where l.singleton),'cohort change invalidates revision-bound latest-sync cursors and selections');
-- Forbidden reads never clear membership; unavailable status is explicit.
insert into app.source_memberships values(1,repeat('p',22),repeat('2',64),now());
select app.refresh_source_pool(1);
select public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',null,'forbidden');
select pg_temp.assert((select not available and error_code='forbidden' from app.sources where id=repeat('p',22)),'unavailable source honest');
select pg_temp.assert((select latest_completed_run_id='99999999-9999-4999-8999-999999999999' from app.sources where id=repeat('p',22)),'failed scan preserves prior completed source cohort');
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
select pg_temp.assert((select s.latest_completed_run_id=l.completed_run_id from app.sources s cross join app.library_state l where s.id='liked' and l.singleton),'liked verification publishes the validated run cohort');

-- A provisional Liked Songs pass must preserve the verified playlist arrival
-- cohort of a song already active there, including after an invalidated pass.
savepoint cross_source_liked_arrival;
update app.track_metadata set added_run_id='99999999-9999-4999-8999-999999999999',acknowledged_at=now(),liked_at='2025-01-01' where track_key=repeat('2',64);
update app.jobs set state='done' where epoch=1 and kind='library_sync';
select app.start_liked_walk(1);
update app.jobs set state='running',lease_token='33333333-3333-4333-8333-333333333333',lease_until=now()+interval '1 hour' where epoch=1 and kind='library_sync' and state='queued';
do $$ declare r app.sync_runs; j app.jobs; row_data jsonb; original_liked uuid; filter jsonb:='{"membership":"active","search":"","untagged":false,"newOnly":false,"latestSyncOnly":true}'; begin
 select latest_completed_run_id into original_liked from app.sources where epoch=1 and id='liked';
 select jsonb_build_array(jsonb_build_object('trackKey',m.track_key,'spotifyId',m.spotify_id,'title',m.title,'artists',m.artists,'album',m.album,'durationMs',1000,'explicit',false,'likedAt','2026-04-04T00:00:00Z')) into row_data from app.track_metadata m where m.track_key=repeat('2',64);
 select * into r from app.sync_runs where id=(select latest_run_id from app.library_state where singleton);
 select * into j from app.jobs where id=r.job_id;
 perform public.app_library_page_commit(1,j.id,j.lease_token,r.pass,0,2,1,1,row_data,0,'{}');
 perform pg_temp.assert((select acknowledged_at is not null and added_run_id='99999999-9999-4999-8999-999999999999' from app.track_metadata where track_key=repeat('2',64)),'incomplete liked pass preserves acknowledged verified playlist arrival');
 if to_regprocedure('app.song_group_key(text)') is not null then
  perform pg_temp.assert(exists(select 1 from app.filter_keys(filter) where track_key=repeat('2',64)),'verified playlist arrival remains latest during provisional liked pass');
 end if;
 perform public.app_library_page_commit(1,j.id,j.lease_token,r.pass,1,2,1,null,'[]',1,'{}');
 perform pg_temp.assert((select latest_completed_run_id is not distinct from original_liked from app.sources where epoch=1 and id='liked') and (select added_run_id='99999999-9999-4999-8999-999999999999' from app.track_metadata where track_key=repeat('2',64)),'invalid liked walk cannot erase prior verified source cohort');
 if to_regprocedure('app.song_group_key(text)') is not null then
  perform pg_temp.assert(exists(select 1 from app.filter_keys(filter) where track_key=repeat('2',64)),'verified playlist arrival remains latest after failed liked pass');
 end if;
 for n in 1..2 loop
  select * into r from app.sync_runs where job_id=j.id;
  perform public.app_library_page_commit(1,j.id,j.lease_token,r.pass,0,1,1,null,row_data,0,'{}');
 end loop;
 perform pg_temp.assert((select latest_completed_run_id=r.id from app.sources where epoch=1 and id='liked') and (select acknowledged_at is not null and added_run_id='99999999-9999-4999-8999-999999999999' from app.track_metadata where track_key=repeat('2',64)),'verified liked membership preserves existing shared-pool arrival identity');
 if to_regprocedure('app.song_group_key(text)') is not null then
  perform pg_temp.assert(exists(select 1 from app.filter_keys(filter) where track_key=repeat('2',64)),'completed liked pass keeps source-A verified arrival while A remains enabled');
 end if;
end $$;
rollback to cross_source_liked_arrival;

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
-- Repeated occurrences use the latest addition date within this walk, independent
-- of order; a later complete walk may move it back when the newer occurrence left.
update app.source_scans set next_offset=0,snapshot_id=null,total=null,received=0,invalid=false where job_id='11111111-1111-4111-8111-111111111111';
delete from app.source_seen where job_id='11111111-1111-4111-8111-111111111111';
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,2,2,null,'duplicates-snapshot',jsonb_set(pg_temp.source_row('5'),'{0,likedAt}','"2026-03-03T00:00:00Z"')||pg_temp.source_row('5'),0,0);
select public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','duplicates-snapshot');
select pg_temp.assert((select added_at='2026-03-03' from app.source_memberships where source_id=repeat('p',22) and track_key=repeat('5',64)),'reverse-order duplicate retains latest date within verified walk');
-- The opposite order across separate pages cannot temporarily clear a previous
-- acknowledgment or replace its arrival cohort before the later duplicate arrives.
update app.track_metadata set acknowledged_at=now(),added_run_id='10101010-1010-4010-8010-101010101010' where track_key=repeat('5',64);
update app.source_scans set next_offset=0,snapshot_id=null,total=null,received=0,invalid=false where job_id='11111111-1111-4111-8111-111111111111';
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,2,1,1,'older-first-snapshot',jsonb_set(pg_temp.source_row('5'),'{0,likedAt}','"2026-01-01T00:00:00Z"'),0,0);
select pg_temp.assert((select acknowledged_at is not null and added_run_id='10101010-1010-4010-8010-101010101010' from app.track_metadata where track_key=repeat('5',64)),'older first page preserves active song acknowledgment and arrival cohort');
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',1,2,1,null,'older-first-snapshot',jsonb_set(pg_temp.source_row('5'),'{0,likedAt}','"2026-03-03T00:00:00Z"'),0,0);
select public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','older-first-snapshot');
select pg_temp.assert((select acknowledged_at is not null and added_run_id='10101010-1010-4010-8010-101010101010' from app.track_metadata where track_key=repeat('5',64)) and (select added_at='2026-03-03' from app.source_memberships where source_id=repeat('p',22) and track_key=repeat('5',64)),'verified unchanged duplicate rescan preserves acknowledgment and restores latest ordering date');

update app.source_scans set next_offset=0,snapshot_id=null,total=null,received=0,invalid=false where job_id='11111111-1111-4111-8111-111111111111';
select public.app_source_page_commit(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,1,1,null,'older-only-snapshot',pg_temp.source_row('5'),0,0);
select public.app_source_finish(1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','older-only-snapshot');
select pg_temp.assert((select added_at='2026-02-02' from app.source_memberships where source_id=repeat('p',22) and track_key=repeat('5',64)),'subsequent verified walk can move date backward after latest occurrence removal');
-- A disabled source may retain only opaque identities after the metadata
-- retention window. Re-enable must gate and rehydrate despite an unchanged
-- provider snapshot, while retaining user tags and saved source preferences.
insert into app.track_tags(track_key,tag_id,present) values(repeat('5',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select public.app_sources_selection(1,jsonb_build_array(repeat('p',22)),false);
update app.track_metadata set removed_at=now()-interval '91 days' where track_key=repeat('5',64);
select app.library_maintenance();
select pg_temp.assert(not exists(select 1 from app.track_metadata where track_key=repeat('5',64)) and exists(select 1 from app.source_memberships where source_id=repeat('p',22) and track_key=repeat('5',64)),'retention purges provider metadata but keeps confirmed opaque membership');
select public.app_sources_selection(1,jsonb_build_array(repeat('p',22)),true);
select pg_temp.assert((select last_synced_at is null and enabled and snapshot_id='older-only-snapshot' from app.sources where id=repeat('p',22)),'re-enable invalidates completeness only while retaining verified remote marker');
select pg_temp.assert(not (public.app_library_status(1)->>'initialSyncComplete')::boolean,'generation gates until retained membership metadata rehydrates');
insert into app.jobs(id,epoch,kind,state,lease_token,lease_until) values('12121212-1212-4212-8212-121212121212',1,'source_sync','running','13131313-1313-4313-8313-131313131313',now()+interval '1 hour');
insert into app.source_scans(job_id,epoch,source_id) values('12121212-1212-4212-8212-121212121212',1,repeat('p',22));
select pg_temp.assert(public.app_source_job_state(1,'12121212-1212-4212-8212-121212121212','13131313-1313-4313-8313-131313131313','synthetic-key')->'previousSnapshotId'='null'::jsonb,'missing metadata suppresses unchanged snapshot skip');
select public.app_source_page_commit(1,'12121212-1212-4212-8212-121212121212','13131313-1313-4313-8313-131313131313',0,1,1,null,'older-only-snapshot',pg_temp.source_row('5'),0,0);
select pg_temp.assert(not (public.app_library_status(1)->>'initialSyncComplete')::boolean,'page write alone cannot certify rehydrated source');
select public.app_source_finish(1,'12121212-1212-4212-8212-121212121212','13131313-1313-4313-8313-131313131313','older-only-snapshot');
select pg_temp.assert((public.app_library_status(1)->>'initialSyncComplete')::boolean and (select removed_at is null from app.track_metadata where track_key=repeat('5',64)),'unchanged provider snapshot full walk restores complete active pool');
select pg_temp.assert((select present from app.track_tags where track_key=repeat('5',64)),'rehydration restores original tag assignments');
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
select public.app_source_page_commit(1,'66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777',0,2,1,1,'partial-first-import',pg_temp.source_row('4'),0,0);
select pg_temp.assert((select removed_at is null from app.track_metadata where track_key=repeat('4',64)) and not (public.app_library_status(1)->>'initialSyncComplete')::boolean,'pending first-import rows browse while generation remains gated');

insert into app.track_tags(track_key,tag_id,present) values(repeat('4',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select public.app_source_finish(1,'66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777',null,'forbidden');
select pg_temp.assert(exists(select 1 from app.sources where id=repeat('f',22) and enabled and not available and error_code='forbidden'),'confirmed inaccessible followed source remains visible with preference intact');
select pg_temp.assert((public.app_library_status(1)->>'initialSyncComplete')::boolean,'confirmed unavailable first source no longer blocks completed accessible pool');
select pg_temp.assert((select removed_at is not null from app.track_metadata where track_key=repeat('4',64)) and not exists(select 1 from app.query_targets('{"version":1,"root":{"op":"tag","tagId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}') where track_key=repeat('4',64)),'failed never-confirmed source cannot leak tagged provisional rows into generation');
select pg_temp.assert(not app.source_contributes(1,repeat('f',22)) and app.source_contributes(1,repeat('p',22)),'contribution predicate excludes failed first import while retaining confirmed cached source');
-- Simulate the successor job after access returns, retaining its opaque rows.
update app.source_scans set next_offset=0,snapshot_id=null,total=null,received=0,invalid=false where job_id='66666666-6666-4666-8666-666666666666';
delete from app.source_seen where job_id='66666666-6666-4666-8666-666666666666';

select public.app_source_page_commit(1,'66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777',0,2,1,1,'recovered-snapshot',pg_temp.source_row('4'),0,0);
select pg_temp.assert(not (public.app_library_status(1)->>'initialSyncComplete')::boolean,'recovered access gates generation during incomplete first walk');
select public.app_disconnect(1);
select public.app_disconnect_finish(2);
select pg_temp.assert(not exists(select 1 from app.sources) and not exists(select 1 from app.source_memberships),'disconnect clears source metadata and memberships');
rollback;
