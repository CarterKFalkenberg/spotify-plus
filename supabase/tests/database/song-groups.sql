begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
update app.library_state set initial_sync_complete=true,encrypted_annotation_key='synthetic-key' where singleton;
insert into app.annotations select lpad(i::text,64,'0'),1 from generate_series(1,7) i;
insert into app.tags(id,epoch,name,normalized_name) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'One','one'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'Two','two');
-- Duplicate original annotations conflict; migration/ingestion must union rather than overwrite.
insert into app.track_tags(track_key,tag_id,present) values
 (lpad('1',64,'0'),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true),
 (lpad('2',64,'0'),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id,playable_uri,duration_ms)
 select lpad(i::text,64,'0'),lpad(i::text,22,'0'),
 case i when 1 then ' Synthetic  Café ' when 2 then 'synthetic Café' when 3 then 'Synthetic Café (Live)' else 'Other '||i end,
 case when i=2 then '[{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Secondary"},{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic"}]'::jsonb
 else '[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic"},{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Secondary"}]'::jsonb end,
 'Synthetic album',now()-make_interval(days=>i),'11111111-1111-4111-8111-111111111111',
 'spotify:track:'||lpad(i::text,22,'0'),180000 from generate_series(1,7) i;
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_group_key(lpad('1',64,'0'))=app.song_group_key(lpad('2',64,'0')),'normalized title with full reordered artist identity groups');
select pg_temp.assert(app.song_group_key(lpad('1',64,'0'))<>app.song_group_key(lpad('3',64,'0')),'live suffix preserved');
select pg_temp.assert(app.song_identity('Same','[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Name"}]')<>app.song_identity('Same','[{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Name"}]'),'same artist name with distinct known IDs is not equivalent');
select pg_temp.assert(app.song_identity('Same','[{"name":"  NAME "}]')=app.song_identity('same','[{"name":"name"}]'),'missing artist IDs use normalized full names');
select pg_temp.assert(app.song_identity('Same','[]') is null,'unknown artist metadata cannot merge unrelated tracks');
select pg_temp.assert((select bool_and(normalized_song_identity is not distinct from app.song_identity(title,artists)) from app.track_metadata),'stored identity exactly matches immutable title and artist normalization');
select pg_temp.assert((select count(*)=4 from app.track_tags where present and track_key in (lpad('1',64,'0'),lpad('2',64,'0'))),'preexisting tags union keeps original identities');
create temp table results(k text primary key,v jsonb);
insert into results values('filter','{"membership":"active","untagged":false,"newOnly":false}');
select pg_temp.assert((select count(*)=6 from app.filter_keys((select v from results where k='filter'))),'library filters list logical songs once');
select pg_temp.assert((select count(*)=1 from app.query_targets('{"version":1,"root":{"op":"tag","tagId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}')),'query preview and generated snapshot input unique');
select pg_temp.assert(cardinality(app.selection_keys(1,jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('1',64,'0'),lpad('2',64,'0')))))=1,'manual bulk selection canonicalized');
insert into results values('selection',jsonb_build_object('kind','filter','filter',(select v from results where k='filter'),'expectedRevision',app.library_revision()));
insert into results values('remove',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','remove','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('2',64,'0'))))));
select pg_temp.assert((select v->>'selectedCount'='1' and v->>'changedCount'='1' from results where k='remove'),'mutation counts logical songs');
select pg_temp.assert(not exists(select 1 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'removal shared immediately');
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from results where k='remove'))->>'restoredCount'='1','undo restores logical group once');
select pg_temp.assert((select count(*)=2 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'undo restores every changed original assignment');
do $$ begin
 begin perform app.selection_keys(1,(select v from results where k='selection')); raise exception 'stale selection accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
end $$;
-- Later edits fence stale undo for the complete logical song.
insert into results values('remove2',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','remove','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('1',64,'0'))))));
select public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','add','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('2',64,'0')))));
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from results where k='remove2'))->>'skippedCount'='1','later edit skips whole undo group');
-- Stable representative survives new aliases, then falls back if removed/unplayable.
insert into results values('representative',to_jsonb(app.song_representative(lpad('1',64,'0'))));
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_representative(lpad('2',64,'0'))=(select v#>>'{}' from results where k='representative'),'representative stable');
update app.track_metadata set removed_at=now() where track_key=lpad('1',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_representative(lpad('1',64,'0'))=lpad('2',64,'0'),'removed representative replaced by eligible alias');
select pg_temp.assert(public.app_playback_track(1,lpad('1',64,'0'))->>'uri'='spotify:track:'||lpad('2',22,'0'),'playback resolves replacement alias');
update app.track_metadata set removed_at=null where track_key=lpad('1',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_representative(lpad('1',64,'0'))=lpad('2',64,'0'),'returning alias does not churn eligible representative');
savepoint group_acknowledgement;
select public.app_library_acknowledge(1,jsonb_build_array(lpad('1',64,'0')));
select pg_temp.assert((select count(*)=2 from app.track_metadata where acknowledged_at is not null),'acknowledgement marks every alias seen');
update app.track_metadata set acknowledged_at=null where track_key=lpad('1',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert((select acknowledged_at is not null from app.track_metadata where track_key=lpad('1',64,'0')),'returning release inherits logical song acknowledgement');
update app.track_metadata set duration_ms=0 where track_key=lpad('2',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_representative(lpad('2',64,'0'))=lpad('1',64,'0'),'unplayable representative replaced by playable alias');
rollback to savepoint group_acknowledgement;

-- A group that fully leaves the pool must become new on its first real return.
savepoint acknowledged_group_reentry;
select app.ensure_sources(1);
insert into app.source_memberships(epoch,source_id,track_key,added_at) values
 (1,'liked',lpad('1',64,'0'),now()),(1,'liked',lpad('2',64,'0'),now());
select app.refresh_source_pool(1);
select public.app_library_acknowledge(1,jsonb_build_array(lpad('1',64,'0')));
select pg_temp.assert((select count(*)=2 from app.track_metadata where track_key in (lpad('1',64,'0'),lpad('2',64,'0')) and acknowledged_at is not null),'both active aliases begin acknowledged');
delete from app.source_memberships where epoch=1 and source_id='liked';
select app.refresh_source_pool(1);
select pg_temp.assert((select count(*)=2 from app.track_metadata where track_key in (lpad('1',64,'0'),lpad('2',64,'0')) and removed_at is not null and acknowledged_at is not null),'full departure keeps historical alias acknowledgements');
-- The page writer clears acknowledgement only on the returning recording.
insert into app.source_memberships(epoch,source_id,track_key,added_at) values(1,'liked',lpad('1',64,'0'),now());
update app.track_metadata set removed_at=null,acknowledged_at=null,added_run_id='66666666-6666-4666-8666-666666666666' where track_key=lpad('1',64,'0');
select app.refresh_source_pool(1);
select pg_temp.assert((select acknowledged_at is null from app.track_metadata where track_key=lpad('1',64,'0')),'removed alias acknowledgement does not overwrite returning recording state');
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from results where k='filter')||'{"newOnly":true}')),'first alias returning after full departure is one new logical song');
select pg_temp.assert((select count(*)=4 from app.track_tags where track_key in (lpad('1',64,'0'),lpad('2',64,'0')) and present),'full departure and return preserve both shared tag assignments');
select public.app_library_acknowledge(1,jsonb_build_array(lpad('1',64,'0')));
insert into app.source_memberships(epoch,source_id,track_key,added_at) values(1,'liked',lpad('2',64,'0'),now());
update app.track_metadata set removed_at=null,acknowledged_at=null,added_run_id='77777777-7777-4777-8777-777777777777' where track_key=lpad('2',64,'0');
select app.refresh_source_pool(1);
select pg_temp.assert((select acknowledged_at is not null from app.track_metadata where track_key=lpad('2',64,'0')),'later alias inherits acknowledgement from still-active returned song');
select pg_temp.assert((select count(*)=0 from app.filter_keys((select v from results where k='filter')||'{"newOnly":true}')),'second alias return does not repeat the acknowledged group arrival');
rollback to savepoint acknowledged_group_reentry;

-- Enabled source membership controls the whole logical pool and provenance.
savepoint source_memberships;
select app.ensure_sources(1);
insert into app.sources(epoch,id,kind,name,last_synced_at) values(1,repeat('p',22),'playlist','Synthetic source',now());
insert into app.source_memberships(epoch,source_id,track_key,added_at) values
 (1,'liked',lpad('1',64,'0'),now()),(1,repeat('p',22),lpad('1',64,'0'),now()),(1,repeat('p',22),lpad('2',64,'0'),now());
select app.refresh_source_pool(1);
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from results where k='filter'))),'source union deduplicates aliases and overlapping memberships');
select pg_temp.assert(jsonb_array_length(app.track_dto(lpad('1',64,'0'))->'sources')=2,'provenance unions enabled sources across aliases');
select pg_temp.assert(public.app_sources_list(1)->>'uniqueTrackCount'='1','Sources summary counts logical songs');
select pg_temp.assert((select item->>'uniqueCount'='1' from jsonb_array_elements(public.app_sources_list(1)->'items') item where item->>'id'=repeat('p',22)),'source duplicates count once');
update app.sources set enabled=false where id='liked' and epoch=1;
select app.refresh_source_pool(1);
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from results where k='filter'))),'disabling one overlapping source preserves song');
delete from app.source_memberships where epoch=1 and source_id=repeat('p',22) and track_key=lpad('2',64,'0');
select app.refresh_source_pool(1);
select pg_temp.assert(app.song_representative(lpad('2',64,'0'))=lpad('1',64,'0'),'source removal chooses surviving eligible representative');
select pg_temp.assert(public.app_playback_track(1,lpad('2',64,'0'))->>'uri'='spotify:track:'||lpad('1',22,'0'),'playback excludes alias removed from enabled sources');
update app.sources set enabled=false where id=repeat('p',22) and epoch=1;
select app.refresh_source_pool(1);
select pg_temp.assert((select count(*)=0 from app.filter_keys((select v from results where k='filter'))),'last enabled source removal archives logical song');
select pg_temp.assert((select count(*)=2 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'source removal preserves opaque annotations');
update app.sources set enabled=true where id='liked' and epoch=1;
select app.refresh_source_pool(1);
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from results where k='filter'))),'source reenable restores logical song with tags');
rollback to savepoint source_memberships;

-- Retained source dates survive metadata expiry and immediate source reenable.
savepoint retained_alias_date;
select app.ensure_sources(1);
insert into app.sources(epoch,id,kind,name,enabled,last_synced_at)
 values(1,repeat('r',22),'playlist','Synthetic retained source',false,now());
insert into app.source_memberships(epoch,source_id,track_key,added_at) values
 (1,'liked',lpad('1',64,'0'),timestamptz '2026-01-01'),
 (1,repeat('r',22),lpad('2',64,'0'),timestamptz '2026-02-01');
select app.refresh_source_pool(1);
delete from app.track_metadata where track_key=lpad('2',64,'0');
select public.app_sources_selection(1,jsonb_build_array(repeat('r',22)),true);
select pg_temp.assert(app.song_added_at(lpad('1',64,'0'))=timestamptz '2026-02-01','reenabled opaque alias retains later known source date');
select pg_temp.assert((select liked_at=app.song_added_at(track_key) from app.filter_keys((select v from results where k='filter')) where track_key=lpad('1',64,'0')),'filter date includes reenabled metadata-free alias membership');
select pg_temp.assert((select liked_at=app.song_added_at(track_key) from app.query_targets('{"version":1,"root":{"op":"tag","tagId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}') where track_key=lpad('1',64,'0')),'query date agrees with DTO helper after alias metadata expiry');
rollback to savepoint retained_alias_date;

-- Latest arrivals use verified per-source checkpoints with Liked Songs disabled.
savepoint latest_source_sync;
select app.ensure_sources(1);
update app.sources set enabled=false where epoch=1 and id='liked';
insert into app.sources(epoch,id,kind,name,last_synced_at,latest_completed_run_id)
 values(1,repeat('q',22),'playlist','Synthetic latest source',now(),'22222222-2222-4222-8222-222222222222');
insert into app.source_memberships(epoch,source_id,track_key,added_at) values
 (1,repeat('q',22),lpad('1',64,'0'),now()),(1,repeat('q',22),lpad('2',64,'0'),now());
-- Simulate the new-pool-arrival run committed by the page writer before finish.
update app.track_metadata set added_run_id='33333333-3333-4333-8333-333333333333' where track_key=lpad('2',64,'0');
select app.refresh_source_pool(1);
select pg_temp.assert((select count(*)=0 from app.filter_keys((select v from results where k='filter')||'{"latestSyncOnly":true}')),'in-flight source additions are excluded before verified completion');
update app.sources set latest_completed_run_id='33333333-3333-4333-8333-333333333333' where epoch=1 and id=repeat('q',22);
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from results where k='filter')||'{"latestSyncOnly":true}')),'playlist-only verified arrivals include one logical song even when its representative is an older alias');
-- A subsequent failed source walk leaves that successful checkpoint available.
update app.sources set error_code='unavailable' where epoch=1 and id=repeat('q',22);
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from results where k='filter')||'{"latestSyncOnly":true}')),'failed walk retains previous verified source arrivals');
-- An unchanged verified pass advances its checkpoint without marking old songs new.
update app.sources set error_code=null,latest_completed_run_id='44444444-4444-4444-8444-444444444444' where epoch=1 and id=repeat('q',22);
select pg_temp.assert((select count(*)=0 from app.filter_keys((select v from results where k='filter')||'{"latestSyncOnly":true}')),'unchanged next verified pass clears previous source arrivals');
rollback to savepoint latest_source_sync;

-- A failed first import cannot influence a surviving confirmed duplicate group.
savepoint failed_partial_alias_source;
select app.ensure_sources(1);
update app.sources set enabled=false where epoch=1 and id='liked';
insert into app.sources(epoch,id,kind,name,available,last_synced_at,latest_completed_run_id) values
 (1,repeat('r',22),'playlist','Synthetic confirmed cached source',false,null,'55555555-5555-4555-8555-555555555555'),
 (1,repeat('s',22),'playlist','Synthetic failed partial source',false,null,null);
insert into app.source_memberships(epoch,source_id,track_key,added_at) values
 (1,repeat('r',22),lpad('1',64,'0'),timestamptz '2026-01-01'),
 (1,repeat('s',22),lpad('2',64,'0'),timestamptz '2026-02-01');
-- The partial alias even has the same opaque run ID as the confirmed checkpoint;
-- only the membership's own contributing source may establish an arrival.
update app.track_metadata set added_run_id='55555555-5555-4555-8555-555555555555' where track_key=lpad('2',64,'0');
select app.refresh_source_pool(1);
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from results where k='filter'))),'confirmed cached source remains active after access loss and metadata sync reset');
select pg_temp.assert(app.song_added_at(lpad('1',64,'0'))=timestamptz '2026-01-01','never-confirmed failed alias cannot advance logical arrival date');
select pg_temp.assert(app.track_dto(lpad('1',64,'0'))#>>'{metadata,addedAt}'=(to_jsonb(timestamptz '2026-01-01')#>>'{}'),'DTO added date ignores failed partial source');
select pg_temp.assert(jsonb_array_length(app.track_dto(lpad('1',64,'0'))->'sources')=1 and app.track_dto(lpad('1',64,'0'))->'sources'->0->>'id'=repeat('r',22),'provenance excludes failed partial source and retains confirmed inaccessible source');
select pg_temp.assert((select count(*)=0 from app.filter_keys((select v from results where k='filter')||'{"latestSyncOnly":true}')),'partial alias cannot establish a latest verified source arrival');
select pg_temp.assert((select removed_at is not null from app.track_metadata where track_key=lpad('2',64,'0')),'failed first-import alias is ineligible while logical group survives');
update app.track_metadata set added_run_id='55555555-5555-4555-8555-555555555555' where track_key=lpad('1',64,'0');
select pg_temp.assert((select count(*)=1 from app.filter_keys((select v from results where k='filter')||'{"latestSyncOnly":true}')),'confirmed cached source still supplies its latest verified arrivals');
rollback to savepoint failed_partial_alias_source;

-- Journals created before component snapshots retain changed-only behavior.
savepoint legacy_group_undo;
insert into results values('legacyRemove',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','remove','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('1',64,'0'))))));
delete from app.song_action_groups where action_id=(select (v->>'actionId')::uuid from results where k='legacyRemove');
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from results where k='legacyRemove'))->>'restoredCount'='1','legacy journal without component snapshot restores complete matching group');
insert into results values('legacyRemoveAgain',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','remove','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('1',64,'0'))))));
delete from app.song_action_groups where action_id=(select (v->>'actionId')::uuid from results where k='legacyRemoveAgain');
update app.track_metadata set title='Synthetic Café',artists='[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic"},{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Secondary"}]' where track_key=lpad('4',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from results where k='legacyRemoveAgain'))->>'skippedCount'='1','legacy journal skips group when later member has no changed-only edge');
select pg_temp.assert(not exists(select 1 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'legacy undo never restores only older aliases');
rollback to savepoint legacy_group_undo;

-- A new exact duplicate makes earlier group undo stale and receives annotations.
insert into results values('remove3',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','remove','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('1',64,'0'))))));
update app.track_metadata set title='Synthetic Café',artists='[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic"},{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Secondary"}]' where track_key=lpad('4',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from results where k='remove3'))->>'skippedCount'='1','membership change skips complete stale undo');
select pg_temp.assert(exists(select 1 from app.track_tags where track_key=lpad('4',64,'0') and tag_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and present),'new alias inherits shared tags');
-- Vocabulary delete/merge undo skips complete components changed by alias arrival.
savepoint vocabulary_alias_race;
insert into results values('deletePreview',public.app_tags_manage_preview(1,jsonb_build_object('action','delete','tagId','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','expectedRevision',app.library_revision())));
insert into results values('deleteAction',public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','delete','tagId','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','confirmedAssignmentCount',(select v->'assignmentCount' from results where k='deletePreview'),'expectedRevision',app.library_revision())));
update app.track_metadata set title='Synthetic Café',artists='[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic"},{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Secondary"}]' where track_key=lpad('5',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from results where k='deleteAction'))->>'skippedCount'='1','delete undo reports complete alias-arrival conflict');
select pg_temp.assert(not exists(select 1 from app.track_tags where tag_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and present),'delete undo never partially restores older aliases');
rollback to savepoint vocabulary_alias_race;
savepoint merge_alias_race;
insert into results values('mergeAction',public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','merge','sourceIds',jsonb_build_array('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'targetId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','expectedRevision',app.library_revision())));
update app.track_metadata set title='Synthetic Café',artists='[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic"},{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Secondary"}]' where track_key=lpad('5',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from results where k='mergeAction'))->>'skippedCount'='1','merge undo fences new alias assignments');
select pg_temp.assert((select count(*)=4 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'merge undo leaves entire later component at its current target');
select pg_temp.assert(not exists(select 1 from app.track_tags where tag_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and present),'merge undo avoids restoring source to only original aliases');
rollback to savepoint merge_alias_race;

-- Merging components moves opaque aliases along with their known identity.
savepoint opaque_component_merge;
update app.track_metadata set title='Other 5' where track_key=lpad('6',64,'0');
select app.refresh_song_groups(1);
delete from app.track_metadata where track_key=lpad('6',64,'0');
update app.track_metadata set title='Synthetic Café' where track_key=lpad('5',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_group_key(lpad('5',64,'0'))=app.song_group_key(lpad('1',64,'0')) and app.song_group_key(lpad('6',64,'0'))=app.song_group_key(lpad('1',64,'0')),'known component merge carries every metadata-free alias to the oldest matching component');
rollback to savepoint opaque_component_merge;

-- Exact identity follows later complete metadata corrections, without losing tags.
savepoint metadata_identity_correction;
insert into results values('beforeSplitAction',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','add','tagId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('1',64,'0'))))));
update app.track_metadata set title='Synthetic Café (Live)' where track_key=lpad('2',64,'0');
select pg_temp.assert((select normalized_song_identity=app.song_identity(title,artists) from app.track_metadata where track_key=lpad('2',64,'0')),'metadata correction automatically refreshes stored identity');
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_group_key(lpad('1',64,'0'))<>app.song_group_key(lpad('2',64,'0')),'later Live correction splits formerly exact aliases');
select pg_temp.assert((select count(*)=6 from app.track_tags where present and track_key in (lpad('1',64,'0'),lpad('2',64,'0'),lpad('4',64,'0'))),'known identity split retains every replicated annotation');
select pg_temp.assert((select count(*)=2 from app.query_targets('{"version":1,"root":{"op":"tag","tagId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}}')),'query emits corrected Live version separately');
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from results where k='beforeSplitAction'))->>'skippedCount'='2','changed component undo skips every partition');
select public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','remove','tagId','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('2',64,'0')))));
select pg_temp.assert((select count(*)=2 from app.track_tags where tag_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and present),'post-split edits affect only the corrected identity');
-- Metadata disappearance alone keeps the original opaque relation.
delete from app.track_metadata where track_key=lpad('4',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_group_key(lpad('4',64,'0'))=app.song_group_key(lpad('1',64,'0')),'missing metadata alone does not split historical aliases');
insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id,playable_uri,duration_ms)
 values(lpad('4',64,'0'),lpad('4',22,'0'),'Synthetic Café (Live)','[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic"},{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Secondary"}]','Synthetic album',now(),'11111111-1111-4111-8111-111111111111','spotify:track:'||lpad('4',22,'0'),180000);
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_group_key(lpad('4',64,'0'))=app.song_group_key(lpad('2',64,'0')) and app.song_group_key(lpad('4',64,'0'))<>app.song_group_key(lpad('1',64,'0')),'returning metadata resolves missing alias to its current exact identity');
select pg_temp.assert((select count(*)=4 from app.track_tags where tag_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and present),'returning exact alias unions retained annotations without loss');
rollback to savepoint metadata_identity_correction;
-- A later artist-ID correction is also an exact identity divergence.
savepoint artist_identity_correction;
update app.track_metadata set artists='[{"id":"cccccccccccccccccccccc","name":"Synthetic"},{"id":"bbbbbbbbbbbbbbbbbbbbbb","name":"Secondary"}]' where track_key=lpad('2',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(app.song_group_key(lpad('1',64,'0'))<>app.song_group_key(lpad('2',64,'0')),'artist ID correction splits same-name artists');
select pg_temp.assert((select count(*)=3 from app.track_tags where tag_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and present),'artist correction preserves original annotations');
rollback to savepoint artist_identity_correction;

-- Annotation-only snapshots retain links after metadata retention, without names.
delete from app.jobs where id is not null;
insert into app.jobs(kind,epoch) values('annotation_backup',1);
insert into results values('job',public.app_job_claim());
insert into results values('plan',public.app_backup_prepare(1,(select (v->>'id')::uuid from results where k='job'),(select (v->>'leaseToken')::uuid from results where k='job')));
select pg_temp.assert((select jsonb_array_length(v#>'{snapshot,songGroups}')=1 from results where k='plan'),'backup carries only grouped opaque aliases');
select pg_temp.assert((select position('Synthetic' in (v->'snapshot')::text)=0 from results where k='plan'),'backup excludes recording/source metadata');
select public.app_backup_bucket_start(1,(select (v->>'id')::uuid from results where k='job'),(select (v->>'leaseToken')::uuid from results where k='job'),(select (v#>>'{snapshot,id}')::uuid from results where k='plan'));
select public.app_backup_upload_allowed(1,(select (v->>'id')::uuid from results where k='job'),(select (v->>'leaseToken')::uuid from results where k='job'),(select (v#>>'{snapshot,id}')::uuid from results where k='plan'));
select public.app_backup_commit(1,(select (v->>'id')::uuid from results where k='job'),(select (v->>'leaseToken')::uuid from results where k='job'),(select (v#>>'{snapshot,id}')::uuid from results where k='plan'),(select (v#>>'{snapshot,revision}')::bigint from results where k='plan'),encode(sha256(convert_to('synthetic-key','UTF8')),'hex'));
insert into results values('snapshot',(select v->'snapshot'||jsonb_build_object('keyLink',encode(sha256(convert_to('synthetic-key','UTF8')),'hex')) from results where k='plan'));
savepoint known_metadata_restore;
update app.track_metadata set title='Synthetic Café (Live)' where track_key=lpad('2',64,'0');
select app.refresh_song_groups(1);
select public.app_backup_restore(1,repeat('a',64),(select annotation_revision from app.library_state),(select v from results where k='snapshot'));
select pg_temp.assert(app.song_group_key(lpad('1',64,'0'))<>app.song_group_key(lpad('2',64,'0')),'snapshot links never override current known identity divergence');
select pg_temp.assert(app.song_group_key(lpad('2',64,'0'))=app.song_group_key(lpad('3',64,'0')),'snapshot restore retains current exact corrected identity grouping');
rollback to savepoint known_metadata_restore;

delete from app.track_metadata where track_key in (lpad('1',64,'0'),lpad('2',64,'0'),lpad('4',64,'0'));
delete from app.song_group_members where group_key=app.song_group_key(lpad('1',64,'0'));
delete from app.song_groups where group_key=lpad('1',64,'0');
select public.app_backup_restore(1,repeat('a',64),(select annotation_revision from app.library_state),(select v from results where k='snapshot'));
select pg_temp.assert(app.song_group_key(lpad('1',64,'0'))=app.song_group_key(lpad('4',64,'0')),'restore recovers opaque group links after metadata purge');
select pg_temp.assert(not exists(select 1 from app.track_metadata where track_key in (lpad('1',64,'0'),lpad('2',64,'0'),lpad('4',64,'0'))),'annotation restore does not resurrect purged metadata');
rollback;
