-- Synthetic fixtures only. This suite rolls back every assertion.
begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
create table library_snapshots(name text primary key,value jsonb);
select public.app_disconnect_finish(2);
delete from app.jobs where id is not null;
select public.app_connect(2,'synthetic-account',repeat('a',64),false,'synthetic-ciphertext',now()+interval '1 hour',now(),repeat('b',64),false);
select pg_temp.assert((select count(*)=1 from app.jobs where kind='library_sync'),'connect automatically queues initial import');
insert into library_snapshots values('job',public.app_job_claim());
select pg_temp.assert(public.app_library_job_state(2,(select (value->>'id')::uuid from library_snapshots where name='job'),(select (value->>'leaseToken')::uuid from library_snapshots where name='job'),'synthetic-encrypted-key')->>'offset'='0','fenced checkpoint creates encrypted key');
create function pg_temp.sync_page(ids integer[],total integer,next_offset integer,unresolved integer default 0,shift_by interval default interval '0 seconds') returns jsonb language plpgsql as $$
 declare r app.sync_runs; j app.jobs; rows jsonb;
 begin
  select * into r from app.sync_runs where id=(select latest_run_id from app.library_state where singleton);
  select * into j from app.jobs where id=r.job_id;
  select coalesce(jsonb_agg(jsonb_build_object('trackKey',lpad(id::text,64,'0'),'spotifyId',lpad(id::text,22,'0'),
   'title','Synthetic song '||id,'artists',jsonb_build_array(jsonb_build_object('id',lpad('1',22,'a'),'name','Synthetic artist'),jsonb_build_object('id',lpad('2',22,'a'),'name','Synthetic collaborator')),
   'album','Synthetic album','releaseDate','2020','durationMs',1000*id,'explicit',false,'artworkUrl',null,'spotifyUrl','https://open.spotify.com/track/'||lpad(id::text,22,'0'),
   'playableUri',case when id=4 then null else 'spotify:track:'||lpad(id::text,22,'0') end,
   'likedAt',timestamptz '2026-01-01T00:00:00Z'+make_interval(secs=>id)+shift_by)),'[]') into rows from unnest(ids) id;
  return public.app_library_page_commit(2,j.id,j.lease_token,r.pass,r.next_offset,total,cardinality(ids)+unresolved,next_offset,rows,unresolved,jsonb_build_object('total',total,'members',ids));
 end;
$$;
select pg_temp.sync_page(array[1,2],3,2);
select pg_temp.assert((public.app_library_status(2)->>'importedCount')::integer=2,'browsing progress counts unique imported keys');
insert into library_snapshots values('tag',public.app_tag_create(2,'  Chill   Café  '));
select pg_temp.assert(not (public.app_tag_create(2,'chill café')->>'created')::boolean,'normalized casing/accent/whitespace tag identity');
select pg_temp.assert(public.app_tag_create(2,'chill café')->'tag'->>'name'='Chill Café','first typed display casing preserved');
insert into library_snapshots values('tag_action',public.app_tag_action(2,repeat('b',64),jsonb_build_object('tagId',(select value->'tag'->>'id' from library_snapshots where name='tag'),
 'selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('1',64,'0'))),'action','add')));
select pg_temp.assert((select value->>'changedCount'='1' from library_snapshots where name='tag_action'),'tagging during initial import is durable');
select pg_temp.sync_page(array[2],3,null);
select pg_temp.assert(not (public.app_library_status(2)->>'initialSyncComplete')::boolean,'duplicate coverage does not complete import');
select pg_temp.sync_page(array[1,2,3],3,null);
select pg_temp.sync_page(array[1,2,4],3,null);
select pg_temp.assert(not (public.app_library_status(2)->>'initialSyncComplete')::boolean,'equal-count swap requires another identical walk');
select pg_temp.assert((select removed_at is null from app.track_metadata where spotify_id=lpad('3',22,'0')),'unstable walks never soft-remove missing entries');
select pg_temp.sync_page(array[1,2,4],3,null);
select pg_temp.assert((public.app_library_status(2)->>'initialSyncComplete')::boolean,'two consecutive complete matching sets are accepted');
select pg_temp.assert((select removed_at is not null from app.track_metadata where spotify_id=lpad('3',22,'0')),'only stable completion reconciles removals');
select pg_temp.assert((select count(*)=1 from app.track_tags where present),'sync preserves assignments');
-- Simulate worker death after the final page commit, before acknowledging the job.
update app.jobs set lease_until=now()-interval '1 second' where id=(select (value->>'id')::uuid from library_snapshots where name='job');
update library_snapshots set value=public.app_job_claim() where name='job';
select pg_temp.assert((public.app_library_job_state(2,(select (value->>'id')::uuid from library_snapshots where name='job'),(select (value->>'leaseToken')::uuid from library_snapshots where name='job'),'unused-candidate')->>'completed')::boolean,'reclaimed completed run is explicitly finishable after lost acknowledgement');
select public.app_job_finish((select (value->>'id')::uuid from library_snapshots where name='job'),(select (value->>'leaseToken')::uuid from library_snapshots where name='job'),'done');
-- Complete local previews, grouping, literal search and secure pagination.
insert into library_snapshots values('query',jsonb_build_object('version',1,'root',jsonb_build_object('op','not','child',jsonb_build_object('op','tag','tagId',(select value->'tag'->>'id' from library_snapshots where name='tag')))));
insert into library_snapshots values('preview',public.app_query_preview(2,jsonb_build_object('query',(select value from library_snapshots where name='query'),'cursor',null,'limit',1)));
select pg_temp.assert((select value->>'matchedCount'='2' and value->>'playableCount'='1' and value->>'excludedCount'='1' and value->>'durationMs'='2000' and value->'tracks'->0->>'trackKey'=lpad('4',64,'0') from library_snapshots where name='preview'),'preview full counts/duration and newest order include unavailable exclusions');
select pg_temp.assert(jsonb_array_length(public.app_query_preview(2,jsonb_build_object('query',(select value from library_snapshots where name='query'),'cursor',(select value->>'nextCursor' from library_snapshots where name='preview'),'limit',1))->'tracks')=1,'server cursor returns second page');
insert into library_snapshots values('filter','{"membership":"active","search":"","untagged":false,"newOnly":false,"artistId":null}');
insert into library_snapshots values('groups',public.app_library_search(2,jsonb_build_object('filter',(select value from library_snapshots where name='filter'),'cursor',null,'limit',10,'groupBy','artist')));
select pg_temp.assert((select value->>'totalTracks'='3' and value->>'totalGroups'='2' and value->'groups'->0->>'trackCount'='3' and value->'groups'->0->>'taggedCount'='1' from library_snapshots where name='groups'),'artist groups count distinct tracks and assignments');
select pg_temp.assert(public.app_library_search(2,jsonb_build_object('filter',(select value from library_snapshots where name='filter')||jsonb_build_object('artistId',lpad('1',22,'a')),'cursor',null,'limit',10,'groupBy','artist'))->>'totalGroups'='1','filtered groups never widen selection through collaborators');
select pg_temp.assert(public.app_library_search(2,jsonb_build_object('filter',(select value from library_snapshots where name='filter')||'{"search":"%"}'::jsonb,'cursor',null,'limit',10,'groupBy',null))->>'totalTracks'='0','search treats SQL wildcard literally');
do $$ begin
 begin perform public.app_library_search(2,jsonb_build_object('filter',(select value from library_snapshots where name='filter'),'cursor',(select value->>'nextCursor' from library_snapshots where name='preview'),'limit',1,'groupBy',null)); raise exception 'cross-route cursor accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
 begin perform public.app_query_preview(2,jsonb_build_object('query',jsonb_build_object('version',1,'root',jsonb_build_object('op','not','child',jsonb_build_object('op','tag','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))),'cursor',null,'limit',10)); raise exception 'unknown NOT leaf accepted'; exception when raise_exception then if sqlerrm<>'unknown_tag' then raise; end if; end;
 begin perform public.app_query_preview(2,jsonb_build_object('query',jsonb_build_object('version',1,'root',jsonb_build_object('op','or','children',jsonb_build_array(jsonb_build_object('op','tag','tagId',(select value->'tag'->>'id' from library_snapshots where name='tag')),jsonb_build_object('op','tag','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')))),'cursor',null,'limit',10)); raise exception 'short-circuit unknown leaf accepted'; exception when raise_exception then if sqlerrm<>'unknown_tag' then raise; end if; end;
end $$;
-- SQL nested-boolean truth table, independent of the TypeScript evaluator.
savepoint query_truth_table;
insert into app.tags(id,epoch,name,normalized_name) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',2,'Truth A','truth a'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',2,'Truth B','truth b'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',2,'Truth C','truth c');
insert into app.annotations(track_key,epoch) select lpad((10+i)::text,64,'0'),2 from generate_series(0,7) i;
insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id,playable_uri,duration_ms)
 select lpad((10+i)::text,64,'0'),lpad((10+i)::text,22,'0'),'Synthetic truth '||i,'[]','Synthetic truth',now(),gen_random_uuid(),'spotify:track:'||lpad((10+i)::text,22,'0'),1000 from generate_series(0,7) i;
insert into app.track_tags(track_key,tag_id,present)
 select lpad((10+i)::text,64,'0'),tag_id,true from generate_series(0,7) i
 cross join (values (1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid),(2,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid),(4,'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid)) masks(mask,tag_id) where i&mask<>0;
do $$ declare i integer; node jsonb := '{"op":"and","children":[{"op":"tag","tagId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},{"op":"or","children":[{"op":"tag","tagId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},{"op":"tag","tagId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}]},{"op":"not","child":{"op":"and","children":[{"op":"tag","tagId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},{"op":"tag","tagId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}]}}]}'; begin
 for i in 0..7 loop
  perform pg_temp.assert(app.query_matches(node,lpad((10+i)::text,64,'0')) = ((i&1<>0) and ((i&2<>0) or (i&4<>0)) and not ((i&2<>0) and (i&4<>0))),'recursive SQL AND/OR/NOT truth table');
 end loop;
 perform pg_temp.assert((select count(*)=2 from app.query_targets(jsonb_build_object('version',1,'root',node))),'nested query selects exact cached target set');
end $$;
rollback to query_truth_table;
-- Frozen filter selection, idempotent edges and changed-only session undo.
insert into library_snapshots values('bulk',public.app_tag_action(2,repeat('b',64),jsonb_build_object('tagId',(select value->'tag'->>'id' from library_snapshots where name='tag'),
 'selection',jsonb_build_object('kind','filter','filter',(select value from library_snapshots where name='filter'),'expectedRevision',app.library_revision()),'action','add')));
select pg_temp.assert((select value->>'selectedCount'='3' and value->>'changedCount'='2' from library_snapshots where name='bulk'),'bulk fills missing edges only');
insert into library_snapshots values('noop',public.app_tag_action(2,repeat('b',64),jsonb_build_object('tagId',(select value->'tag'->>'id' from library_snapshots where name='tag'),
 'selection',jsonb_build_object('kind','filter','filter',(select value from library_snapshots where name='filter'),'expectedRevision',app.library_revision()),'action','add')));
select pg_temp.assert((select a.value->'revision'=b.value->'revision' and b.value->>'changedCount'='0' from library_snapshots a,library_snapshots b where a.name='bulk' and b.name='noop'),'no-op preserves revision and assignments');
select public.app_tag_action(2,repeat('b',64),jsonb_build_object('tagId',(select value->'tag'->>'id' from library_snapshots where name='tag'),
 'selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('2',64,'0'))),'action','remove'));
insert into library_snapshots values('undo',public.app_tag_undo(2,repeat('b',64),(select (value->>'actionId')::uuid from library_snapshots where name='bulk')));
select pg_temp.assert((select value->>'restoredCount'='1' and value->>'skippedCount'='1' from library_snapshots where name='undo'),'undo restores changed edge but skips later edits');
select pg_temp.assert((select present from app.track_tags where track_key=lpad('1',64,'0')),'undo preserves assignments predating bulk action');
select pg_temp.assert(public.app_tag_undo(2,repeat('b',64),(select (value->>'actionId')::uuid from library_snapshots where name='bulk'))->>'restoredCount'='0','repeated undo is harmless');
do $$ begin
 begin perform public.app_tag_action(2,repeat('b',64),jsonb_build_object('tagId',(select value->'tag'->>'id' from library_snapshots where name='tag'),'selection',(select value->'groups'->0->'selection' from library_snapshots where name='groups'),'action','add')); raise exception 'stale selection accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
 begin perform public.app_tag_action(2,repeat('b',64),jsonb_build_object('tagId',(select value->'tag'->>'id' from library_snapshots where name='tag'),'selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(repeat('f',64))),'action','add')); raise exception 'unknown annotation accepted'; exception when raise_exception then if sqlerrm<>'unknown_track' then raise; end if; end;
 begin perform public.app_tag_undo(2,repeat('c',64),(select (value->>'actionId')::uuid from library_snapshots where name='tag_action')); raise exception 'foreign session undo accepted'; exception when raise_exception then if sqlerrm<>'inactive_epoch' then raise; end if; end;
 begin perform public.app_query_preview(2,jsonb_build_object('query',(select value from library_snapshots where name='query'),'cursor',(select value->>'nextCursor' from library_snapshots where name='preview'),'limit',1)); raise exception 'stale cursor accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
end $$;
-- A still-authenticated session retains undo beyond an arbitrary day boundary.
savepoint long_session;
update app.tag_actions set created_at=now()-interval '2 days' where id=(select (value->>'actionId')::uuid from library_snapshots where name='tag_action');
select pg_temp.assert(public.app_tag_undo(2,repeat('b',64),(select (value->>'actionId')::uuid from library_snapshots where name='tag_action'))->>'restoredCount'='1','undo follows authenticated session lifetime');
rollback to long_session;
-- Null identity/changed totals/interrupted passes cannot certify completeness or remove tags.
select public.app_library_sync(2,'manual');
select pg_temp.assert((select count(*)=2 from app.sync_runs),'subsequent sync starts after lost-final-acknowledgement recovery');
update library_snapshots set value=public.app_job_claim() where name='job';
select pg_temp.sync_page(array[1],2,1);
select pg_temp.assert((select next_offset=1 from app.sync_runs where id=(select latest_run_id from app.library_state where singleton)),'page and checkpoint commit atomically');
update app.jobs set lease_until=now()-interval '1 second' where id=(select (value->>'id')::uuid from library_snapshots where name='job');
insert into library_snapshots values('reclaimed',public.app_job_claim());
select pg_temp.assert(public.app_library_job_state(2,(select (value->>'id')::uuid from library_snapshots where name='job'),(select (value->>'leaseToken')::uuid from library_snapshots where name='job'),'stale-key') is null,'old worker loses write authority after reclaim');
select pg_temp.sync_page(array[2],3,null);
select pg_temp.assert((select pass=2 and prior_valid_pass is null from app.sync_runs where id=(select latest_run_id from app.library_state where singleton)),'changing total resets consecutive stability');
select pg_temp.sync_page(array[1,2],3,null,1);
select pg_temp.assert((select prior_valid_pass is null from app.sync_runs where id=(select latest_run_id from app.library_state where singleton)),'unresolved null/local identity cannot silently complete');
select pg_temp.sync_page(array[1,2],2,null);
select pg_temp.sync_page(array[1,2],2,null,0,interval '1 second');
select pg_temp.assert((select completed_at is null from app.sync_runs where id=(select latest_run_id from app.library_state where singleton)),'changed liked-at is a membership change despite identical IDs');
select pg_temp.sync_page(array[1,2],2,null,0,interval '1 second');
select public.app_job_finish((select (value->>'id')::uuid from library_snapshots where name='reclaimed'),(select (value->>'leaseToken')::uuid from library_snapshots where name='reclaimed'),'done');
-- Acknowledgements are explicit and idempotent; app-open probes are debounced.
select pg_temp.assert(public.app_library_acknowledge(2,jsonb_build_array(lpad('1',64,'0')))->>'changedCount'='1','acknowledgement clears one new badge');
select pg_temp.assert(public.app_library_acknowledge(2,jsonb_build_array(lpad('1',64,'0')))->>'changedCount'='0','repeat acknowledgement is no-op');
select public.app_library_sync(2,'app-open');
select public.app_library_sync(2,'app-open');
select pg_temp.assert((select count(*)=1 from app.jobs where kind='library_probe'),'app-open hint debounces');
-- Metadata TTL does not touch persistent annotation edges or HMAC identity.
update app.track_metadata set removed_at=now()-interval '91 days' where track_key=lpad('1',64,'0');
select app.library_maintenance();
select pg_temp.assert(not exists(select 1 from app.track_metadata where track_key=lpad('1',64,'0')) and exists(select 1 from app.annotations where track_key=lpad('1',64,'0')) and exists(select 1 from app.track_tags where track_key=lpad('1',64,'0') and present),'90-day metadata purge preserves annotated identity');
-- Reconnect keeps annotation editing; paused Spotify work does not invent progress.
update app.account set state='reconnect' where singleton;
select pg_temp.assert(public.app_library_status(2)->>'blockedBy'='reconnect','reconnect is visible');
select pg_temp.assert((public.app_tag_create(2,'Reconnect tag')->>'created')::boolean,'authenticated reconnect sessions can edit annotations');
do $$ begin
 begin perform app.require_owner(2,true); raise exception 'reconnect allowed Spotify generation'; exception when raise_exception then if sqlerrm<>'inactive_epoch' then raise; end if; end;
end $$;
select public.app_disconnect(2);
select pg_temp.assert(not exists(select 1 from app.library_state) and not exists(select 1 from app.annotations) and not exists(select 1 from app.tags) and not exists(select 1 from app.track_tags) and not exists(select 1 from app.sync_runs),'disconnect purges annotations, ciphertext and metadata');
select public.app_disconnect_finish(3);
select public.app_connect(3,'synthetic-account',repeat('a',64),false,'synthetic',now()+interval '1 hour',now(),repeat('d',64),false);
delete from app.jobs where epoch is null;
select public.app_job_claim();
-- Empty library requires two complete empty walks too.
do $$ declare r app.sync_runs; j app.jobs; result jsonb; begin
 select * into r from app.sync_runs where epoch=3;
 select * into j from app.jobs where id=r.job_id;
 result:=public.app_library_page_commit(3,j.id,j.lease_token,1,0,0,0,null,'[]',0,'{"total":0,"members":[]}');
 perform pg_temp.assert(not (result->>'done')::boolean,'first empty walk still verifies');
 result:=public.app_library_page_commit(3,j.id,j.lease_token,2,0,0,0,null,'[]',0,'{"total":0,"members":[]}');
 perform pg_temp.assert((result->>'done')::boolean,'second empty walk completes');
end $$;
select pg_temp.assert(public.app_library_status(3)->>'activeCount'='0' and (public.app_library_status(3)->>'initialSyncComplete')::boolean,'empty library has an explicit completed state');
set local role anon;
do $$ begin
 begin perform public.app_library_status(3); raise exception 'anonymous library access'; exception when insufficient_privilege then null; end;
 begin perform public.app_tag_create(3,'attack'); raise exception 'anonymous tagging'; exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
