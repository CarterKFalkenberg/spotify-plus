begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
update app.library_state set initial_sync_complete=true,completed_run_id='11111111-1111-4111-8111-111111111111' where singleton;
insert into app.annotations select lpad(i::text,64,'0'),1 from generate_series(1,5) i;
insert into app.track_metadata(track_key,spotify_id,title,artists,album,release_date,liked_at,added_run_id,acknowledged_at,removed_at)
 select lpad(i::text,64,'0'),lpad(i::text,22,'0'),'Synthetic '||(6-i),jsonb_build_array(jsonb_build_object('id',repeat('a',22),'name','Synthetic artist')),
 case when i<3 then 'Synthetic  Album' else 'synthetic album' end,case when i=5 then null else '199'||i end,timestamptz '2026-01-01'+make_interval(days=>i),
 case when i=1 then '11111111-1111-4111-8111-111111111111'::uuid else '22222222-2222-4222-8222-222222222222'::uuid end,
 case when i=1 then now() else null end,case when i=5 then now() else null end from generate_series(1,5) i;
-- Queue playback resolves only current active owner metadata and exposes no names.
update app.track_metadata set playable_uri='spotify:track:'||repeat('a',22),duration_ms=180001 where track_key=lpad('1',64,'0');
update app.track_metadata set playable_uri='spotify:track:'||repeat('a',22),duration_ms=180001 where track_key=lpad('5',64,'0');
select pg_temp.assert(public.app_playback_track(1,lpad('1',64,'0'))=jsonb_build_object('uri','spotify:track:'||repeat('a',22),'durationMs',180001),'playback returns only active owner playable URI and duration');
select pg_temp.assert(public.app_playback_track(1,lpad('5',64,'0')) is null,'removed song cannot start playback');
select pg_temp.assert(public.app_playback_track(1,lpad('2',64,'0')) is null,'unavailable song cannot start playback');
select pg_temp.assert(public.app_playback_track(1,repeat('f',64)) is null,'unknown song cannot start playback');
select pg_temp.assert(not has_function_privilege('anon','public.app_playback_track(bigint,text)','execute') and not has_function_privilege('authenticated','public.app_playback_track(bigint,text)','execute'),'no direct public playback RPC access');
do $$ begin
 begin perform public.app_playback_track(2,lpad('1',64,'0')); raise exception 'stale playback epoch accepted'; exception when raise_exception then if sqlerrm<>'inactive_epoch' then raise; end if; end;
 begin perform public.app_playback_track(1,'bad'); raise exception 'invalid playback key accepted'; exception when raise_exception then if sqlerrm<>'invalid_input' then raise; end if; end;
end $$;
update app.account set state='reconnect' where singleton;
do $$ begin
 begin perform public.app_playback_track(1,lpad('1',64,'0')); raise exception 'reconnect playback accepted'; exception when raise_exception then if sqlerrm<>'inactive_epoch' then raise; end if; end;
end $$;
update app.account set state='connected' where singleton;
update app.track_metadata set artists=artists||jsonb_build_array(jsonb_build_object('id',repeat('c',22),'name','Synthetic collaborator')) where track_key=lpad('1',64,'0');
insert into app.tags(id,epoch,name,normalized_name) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'Chill','chill'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'Chil','chil'),('cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,'Chillout','chillout'),('dddddddd-dddd-4ddd-8ddd-dddddddddddd',1,'Unused','unused');
insert into app.track_tags(track_key,tag_id,present) select lpad(i::text,64,'0'),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true from generate_series(1,3) i;
insert into app.track_tags(track_key,tag_id,present) values
 (lpad('2',64,'0'),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true),(lpad('4',64,'0'),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true),
 (lpad('4',64,'0'),'cccccccc-cccc-4ccc-8ccc-cccccccccccc',true),(lpad('5',64,'0'),'cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
create table snapshots(name text primary key,v jsonb);
insert into snapshots values('filter','{"membership":"active","search":"","untagged":false,"newOnly":false,"artistId":null}');
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from snapshots where name='filter')||'{"latestSyncOnly":true}')),'completed-run filter includes only additions not all walked');
select pg_temp.assert((select count(*)=3 from app.filter_keys((select v from snapshots where name='filter')||'{"newOnly":true}')),'unread badge independent from latest sync and acknowledgement');
select pg_temp.assert((select count(*)=1 from app.filter_keys('{"membership":"removed","search":"","untagged":false,"newOnly":false,"artistId":null,"decade":"unknown"}')),'unknown decade distinct from no filter');
insert into snapshots values('search',public.app_library_search(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'groupBy',null,'limit',1,'cursor',null,'sort','oldest')));
select pg_temp.assert((select v->'tracks'->0->>'trackKey'=lpad('1',64,'0') from snapshots where name='search'),'oldest sort');
insert into snapshots values('album',public.app_library_search(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'groupBy','album','limit',10,'cursor',null)));
select pg_temp.assert((select v->>'totalGroups'='1' and v->'groups'->0->>'trackCount'='4' from snapshots where name='album'),'normalized album groups are distinct');
select pg_temp.assert(cardinality(app.selection_keys(1,(select v->'groups'->0->'selection' from snapshots where name='album')))=4,'group selection equals exact distinct group');
insert into snapshots values('facetPage',public.app_library_facets(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'facet','artist','cursor',null,'limit',1)));
select pg_temp.assert(public.app_library_facets(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'facet','artist','cursor',(select v->>'nextCursor' from snapshots where name='facetPage'),'limit',1))->'options'->0->>'trackCount'='1','facet continuation exact collaborator count');
do $$ begin
 begin perform public.app_library_search(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'groupBy','artist','limit',1,'cursor',(select v->>'nextCursor' from snapshots where name='facetPage'))); raise exception 'facet token accepted for library'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
end $$;

insert into snapshots values('random',public.app_library_search(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'groupBy',null,'limit',2,'cursor',null,'sort','random','seed','33333333-3333-4333-8333-333333333333')));
select pg_temp.assert((select v=public.app_library_search(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'groupBy',null,'limit',2,'cursor',null,'sort','random','seed','33333333-3333-4333-8333-333333333333'))-'nextCursor'||jsonb_build_object('nextCursor',v->'nextCursor') from snapshots where name='random'),'seed random first page stable');
do $$ begin
 begin perform public.app_library_search(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'groupBy',null,'limit',1,'cursor',(select v->>'nextCursor' from snapshots where name='search'),'sort','newest')); raise exception 'cursor accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
end $$;
insert into snapshots values('selection',jsonb_build_object('kind','filter','filter',(select v from snapshots where name='filter'),'expectedRevision',app.library_revision()));
insert into snapshots values('tri',public.app_tags_selection(1,jsonb_build_object('selection',(select v from snapshots where name='selection'),'tagIds',jsonb_build_array('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','dddddddd-dddd-4ddd-8ddd-dddddddddddd'),'expectedRevision',app.library_revision())));
select pg_temp.assert((select v->'tags'->0->>'state'='some' and v->'tags'->0->>'assignedCount'='3' and v->'tags'->1->>'state'='none' from snapshots where name='tri'),'exact tri-state');
select pg_temp.assert(public.app_tags_search(1,'CHILL',10)->'tags'->0->>'name'='Chill','normalized exact before prefix and near');
select pg_temp.assert(exists(select 1 from jsonb_array_elements(public.app_tags_search(1,'chli',10)->'tags') t where t->>'name'='Chil'),'near typo suggestion');
select pg_temp.assert(public.app_tags_vocabulary(1,'{"search":"","sort":"unused","limit":10,"cursor":null}')->'tags'->0->>'name'='Unused','unused means zero retained assignments');
insert into app.playlists(id,epoch,name,query,retention,track_count,status) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',1,'Synthetic preserved title','{"version":1,"root":{"op":"and","children":[{"op":"tag","tagId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},{"op":"not","child":{"op":"or","children":[{"op":"tag","tagId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}]}}]}}','pinned',3,'ready');
insert into snapshots values('query',(select query from app.playlists));
insert into snapshots values('merge',jsonb_build_object('action','merge','sourceIds',jsonb_build_array('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'),'targetId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','expectedRevision',app.library_revision()));
savepoint ordinary_merge_undo;
select app.playlist_operation('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','regenerate','pinned',array['spotify:track:1111111111111111111111','spotify:track:2222222222222222222222','spotify:track:3333333333333333333333'],app.playlist_labels((select query->'root' from app.playlists)));
insert into snapshots values('capturedOperation',(select jsonb_build_object('query',query,'target',target,'labels',labels) from app.playlist_operations));
insert into snapshots values('ordinaryMerge',public.app_tags_manage(1,repeat('b',64),(select v from snapshots where name='merge')));
select pg_temp.assert((select jsonb_build_object('query',query,'target',target,'labels',labels)=(select v from snapshots where name='capturedOperation') from app.playlist_operations),'merge leaves captured operation query/labels/targets unchanged');
select public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from snapshots where name='ordinaryMerge'));
select pg_temp.assert((select query=(select v from snapshots where name='query') from app.playlists),'ordinary merge undo restores prior nested query references');
select pg_temp.assert((select count(*)=3 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'ordinary merge undo restores prior destination edges');
select pg_temp.assert((select count(*)=4 from app.track_tags where tag_id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc') and present),'ordinary merge undo restores source edges');
rollback to ordinary_merge_undo;
select pg_temp.assert(public.app_tags_manage_preview(1,(select v from snapshots where name='merge'))->>'unionCount'='5','merge union distinct across overlapping and removed annotations');
select pg_temp.assert(public.app_tags_manage_preview(1,(select v from snapshots where name='merge'))->>'activeTrackCount'='4','merge active count is distinct across overlap');
select pg_temp.assert(public.app_tags_manage_preview(1,(select v from snapshots where name='merge'))->>'assignmentCount'='7','merge separately counts assignment edges');
insert into snapshots values('mergeResult',public.app_tags_manage(1,repeat('b',64),(select v from snapshots where name='merge')));
select pg_temp.assert((select v->>'changedCount'='8' from snapshots where name='mergeResult'),'merge counts changed destination/source edges and source identities');
select pg_temp.assert((select count(*)=5 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'merge assignment union');
select pg_temp.assert((select query->'root'->'children'->1->'child'->'children'->0->>'tagId'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and revision=2 and track_count=3 and name='Synthetic preserved title' from app.playlists),'arbitrary nested rewrite preserves snapshot/title');
do $$ begin
 begin perform public.app_tags_manage(1,repeat('b',64),(select v from snapshots where name='merge')); raise exception 'stale merge accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
 begin perform public.app_tags_selection(1,jsonb_build_object('selection',(select v from snapshots where name='selection'),'tagIds',jsonb_build_array('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'expectedRevision',app.library_revision())); raise exception 'stale selection accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
end $$;
-- Merge undo independently skips a later assignment and a later playlist edit.
update app.track_tags set version=version+1 where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and track_key=lpad('4',64,'0');
update app.playlists set revision=revision+1 where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
insert into snapshots values('mergeUndo',public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from snapshots where name='mergeResult')));
select pg_temp.assert((select (v->>'skippedCount')::integer=2 from snapshots where name='mergeUndo'),'merge undo skips later assignment and playlist revision');
select pg_temp.assert((select query<> (select v from snapshots where name='query') and track_count=3 from app.playlists),'undo preserves later playlist edit');
select pg_temp.assert((select count(*)=4 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'undo preserves later destination edge');
-- Restore the test merge through a fresh revision to exercise ordinary delete next.
select public.app_tags_manage(1,repeat('b',64),(select v from snapshots where name='merge')||jsonb_build_object('expectedRevision',app.library_revision()));
insert into snapshots values('rename',public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','rename','tagId','dddddddd-dddd-4ddd-8ddd-dddddddddddd','name','Renamed unused','expectedRevision',app.library_revision())));
select public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from snapshots where name='rename'));
select pg_temp.assert((select name='Unused' from app.tags where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),'rename session undo restores display name');
insert into snapshots values('facet',public.app_library_facets(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'facet','album','cursor',null,'limit',1)));
select pg_temp.assert((select v->'options'->0->>'trackCount'='4' and v->>'totalOptions'='1' from snapshots where name='facet'),'explicit facet count respects normalized current filter');
insert into snapshots values('collision',public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','rename','tagId','dddddddd-dddd-4ddd-8ddd-dddddddddddd','name',' chill ','expectedRevision',app.library_revision())));
select pg_temp.assert((select v->'collisionTag'->>'id'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and v->>'changedCount'='0' from snapshots where name='collision'),'rename collision offers merge without overwrite');
insert into snapshots values('delete',public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','delete','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','confirmedAssignmentCount',5,'expectedRevision',app.library_revision())));
select pg_temp.assert(not exists(select 1 from app.track_tags where present),'delete removes assignments');
savepoint literal_tombstone_name;
insert into snapshots values('literalName',public.app_tag_create(1,'__deleted:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
select pg_temp.assert((select v->>'created'='true' and v->'tag'->>'id'<>'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' from snapshots where name='literalName'),'literal historical tombstone spelling creates a live distinct tag');
select pg_temp.assert(public.app_tag_create(1,U&'\00A0Unicode\2003  whitespace\FEFF')->'tag'->>'name'='Unicode whitespace','SQL collapses Unicode whitespace before trimming');
select pg_temp.assert(public.app_tag_create(1,' unicode whitespace ')->>'created'='false','Unicode and ordinary whitespace share identity');
rollback to literal_tombstone_name;

do $$ begin
 begin perform app.validate_query((select query from app.playlists)); raise exception 'deleted query accepted'; exception when raise_exception then if sqlerrm<>'unknown_tag' then raise; end if; end;
end $$;
-- Later edits must survive deletion undo even if an internal edge tombstone advances.
update app.track_tags set version=version+1 where track_key=lpad('1',64,'0') and tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from snapshots where name='delete'))->>'restoredCount'='4','delete undo restores only changed edges');
select app.validate_query((select query from app.playlists));
-- Delete/recreate normalization collision cannot overwrite new vocabulary.
insert into snapshots values('delete2',public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','delete','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','confirmedAssignmentCount',4,'expectedRevision',app.library_revision())));
select public.app_tag_create(1,'CHILL');
do $$ begin
 begin perform public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from snapshots where name='delete2')); raise exception 'collision undo accepted'; exception when raise_exception then if sqlerrm<>'request_conflict' then raise; end if; end;
end $$;
-- Two source tags contribute the same edge to one destination. An earlier undo
-- must not erase the later merge's contribution while leaving its source deleted.
savepoint dependent_merge_undo;
insert into app.tags(id,epoch,name,normalized_name) values('11111111-1111-4111-8111-111111111111',1,'Overlap source A','overlap source a'),('22222222-2222-4222-8222-222222222222',1,'Overlap destination B','overlap destination b'),('33333333-3333-4333-8333-333333333333',1,'Overlap source C','overlap source c');
insert into app.track_tags(track_key,tag_id,present) values(lpad('1',64,'0'),'11111111-1111-4111-8111-111111111111',true),(lpad('1',64,'0'),'33333333-3333-4333-8333-333333333333',true);
insert into snapshots values('overlapFirst',public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','merge','sourceIds',jsonb_build_array('11111111-1111-4111-8111-111111111111'),'targetId','22222222-2222-4222-8222-222222222222','expectedRevision',app.library_revision())));
select public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','merge','sourceIds',jsonb_build_array('33333333-3333-4333-8333-333333333333'),'targetId','22222222-2222-4222-8222-222222222222','expectedRevision',app.library_revision()));
insert into snapshots values('overlapUndo',public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from snapshots where name='overlapFirst')));
select pg_temp.assert((select v->>'restoredCount'='0' and v->>'skippedCount'='4' from snapshots where name='overlapUndo'),'dependent old merge undo is fenced and counts all skipped units');
select pg_temp.assert((select deleted_at is not null from app.tags where id='11111111-1111-4111-8111-111111111111'),'dependency conflict never partially restores original source A');
select pg_temp.assert((select present from app.track_tags where track_key=lpad('1',64,'0') and tag_id='22222222-2222-4222-8222-222222222222'),'later overlap merge destination edge survives earlier undo');
select pg_temp.assert((select deleted_at is not null from app.tags where id='33333333-3333-4333-8333-333333333333'),'later overlap source identity remains deleted');
rollback to dependent_merge_undo;
savepoint ordinary_assignment_merge_dependency;
insert into app.tags(id,epoch,name,normalized_name) values('11111111-1111-4111-8111-111111111111',1,'Ordinary B','ordinary b'),('22222222-2222-4222-8222-222222222222',1,'Ordinary C','ordinary c');
insert into snapshots values('ordinaryAdd',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','add','tagId','11111111-1111-4111-8111-111111111111','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('1',64,'0'))))));
insert into app.track_tags(track_key,tag_id,present) values(lpad('1',64,'0'),'22222222-2222-4222-8222-222222222222',true);
select public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','merge','sourceIds',jsonb_build_array('22222222-2222-4222-8222-222222222222'),'targetId','11111111-1111-4111-8111-111111111111','expectedRevision',app.library_revision()));
insert into snapshots values('ordinaryDependencyUndo',public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from snapshots where name='ordinaryAdd')));
select pg_temp.assert((select v->>'restoredCount'='0' and v->>'skippedCount'='1' from snapshots where name='ordinaryDependencyUndo'),'ordinary earlier add undo skips later overlap contribution');
select pg_temp.assert((select present from app.track_tags where track_key=lpad('1',64,'0') and tag_id='11111111-1111-4111-8111-111111111111'),'later overlap contribution remains after ordinary add undo');
rollback to ordinary_assignment_merge_dependency;
-- A complete unchanged sync still changes latest-sync membership and invalidates old pages.
insert into snapshots values('beforeCompleted',app.library_revision());
insert into snapshots values('beforeCompletedPage',public.app_library_search(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'groupBy',null,'cursor',null,'limit',1)));
insert into snapshots values('syncJob',public.app_job_claim());
select public.app_library_job_state(1,(select (v->>'id')::uuid from snapshots where name='syncJob'),(select (v->>'leaseToken')::uuid from snapshots where name='syncJob'),'synthetic-key');
create function pg_temp.unchanged_page() returns jsonb language plpgsql as $$
 declare r app.sync_runs; j app.jobs; rows jsonb;
 begin
  select * into r from app.sync_runs where id=(select latest_run_id from app.library_state where singleton);
  select * into j from app.jobs where id=r.job_id;
  select jsonb_agg(jsonb_build_object('trackKey',m.track_key,'spotifyId',m.spotify_id,'title',m.title,'artists',m.artists,'album',m.album,'releaseDate',m.release_date,'durationMs',m.duration_ms,'explicit',m.explicit,'artworkUrl',m.artwork_url,'spotifyUrl',m.spotify_url,'playableUri',m.playable_uri,'likedAt',m.liked_at)) into rows from app.track_metadata m where removed_at is null;
  return public.app_library_page_commit(1,j.id,j.lease_token,r.pass,r.next_offset,4,4,null,rows,0,'{}');
 end;
$$;
select pg_temp.unchanged_page();
select pg_temp.unchanged_page();
select pg_temp.assert((select library_revision=(select (v->>'library')::bigint+1 from snapshots where name='beforeCompleted') from app.library_state),'unchanged stable completion advances revision');
select pg_temp.assert((select count(*)=0 from app.filter_keys((select v from snapshots where name='filter')||'{"latestSyncOnly":true}')),'unchanged complete run has zero additions');
do $$ begin
 begin perform public.app_library_search(1,jsonb_build_object('filter',(select v from snapshots where name='filter'),'groupBy',null,'cursor',(select v->>'nextCursor' from snapshots where name='beforeCompletedPage'),'limit',1)); raise exception 'completed-run stale cursor accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
end $$;

update app.sessions set expires_at=now()-interval '1 second' where token_hash=repeat('b',64);
select app.library_maintenance();
select pg_temp.assert(not exists(select 1 from app.vocabulary_deletes),'expired session erases undo snapshot');
select pg_temp.assert((select name='Deleted tag' from app.tags where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),'expired undo scrubs deleted display spelling');
select public.app_disconnect(1);
select public.app_disconnect_finish(2);
select pg_temp.assert(not exists(select 1 from app.tags) and not exists(select 1 from app.vocabulary_deletes),'disconnect purges identities and undo');
rollback;
