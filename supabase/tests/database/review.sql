-- Synthetic content only; all fixtures roll back.
begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
update app.jobs set state='done';
select app.ensure_sources(1);
insert into app.annotations values(repeat('1',64),1),(repeat('2',64),1);
insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id,duration_ms,playable_uri)
 values(repeat('1',64),repeat('1',22),'Synthetic one','[]','Synthetic album','2020-01-01',gen_random_uuid(),1000,'spotify:track:'||repeat('1',22)),
 (repeat('2',64),repeat('2',22),'Synthetic two','[]','Synthetic album','2021-01-01',gen_random_uuid(),1000,'spotify:track:'||repeat('2',22));
insert into app.source_memberships values(1,'liked',repeat('1',64),'2020-01-01'),(1,'liked',repeat('2',64),'2021-01-01');
insert into app.sources(epoch,id,kind,name) values(1,repeat('p',22),'playlist','Synthetic source');
insert into app.source_memberships values(1,repeat('p',22),repeat('1',64),'2022-01-01');
update app.sources set enabled=false where epoch=1;
select app.refresh_source_pool(1);
select app.review_ensure(1);
select pg_temp.assert(app.review_current(1)=repeat('1',64),'oldest exact track survives disabled Sources');
select pg_temp.assert(public.app_playback_track(1,repeat('1',64)) is not null,'review playback ignores Sources');
select pg_temp.assert(public.app_review_get(1)->'destinations'='[]','no initial destination configuration');
insert into app.review_destinations(epoch,id,name,owned,configured) values(1,repeat('p',22),'Synthetic owned',true,true),(1,repeat('q',22),'Synthetic preexisting',true,true);
-- Already-added-only Done is valid without a saved draft, but cached labels
-- cannot authorize an unlike or include an ineligible destination.
savepoint already_added_only;
do $$ declare oid uuid; jid uuid; lease uuid:='77777777-7777-4777-8777-777777777777'; begin
 begin perform public.app_review_command(1,'done',jsonb_build_object('revision','0','trackKey',repeat('1',64),'requestId',gen_random_uuid())); raise exception 'empty_done_accepted'; exception when raise_exception then if sqlerrm<>'invalid_action' then raise; end if; end;
 insert into app.review_memberships(epoch,track_key,playlist_id,status,snapshot_id,checked_at) values(1,repeat('1',64),repeat('q',22),'present','cached',now());
 update app.review_destinations set owned=false where id=repeat('q',22);
 begin perform public.app_review_command(1,'done',jsonb_build_object('revision','0','trackKey',repeat('1',64),'requestId',gen_random_uuid())); raise exception 'unowned_done_accepted'; exception when raise_exception then if sqlerrm<>'invalid_action' then raise; end if; end;
 update app.review_destinations set owned=true where id=repeat('q',22);
 perform public.app_review_command(1,'done',jsonb_build_object('revision','0','trackKey',repeat('1',64),'requestId',gen_random_uuid()));
 select s.active_id into oid from app.review_state s;
 select job_id into jid from app.review_operations where id=oid;
 perform pg_temp.assert((select count(*)=1 and bool_and(playlist_id=repeat('q',22) and state='pending') from app.review_operation_items where operation_id=oid),'already-added-only Done freezes its eligible destination for revalidation');
 perform pg_temp.assert(not exists(select 1 from app.review_memberships where epoch=1 and track_key=repeat('1',64)),'cached presence is cleared before worker confirmation');
 update app.jobs set state='running',lease_token=lease,lease_until=now()+interval '1 hour' where id=jid;
 perform pg_temp.assert(not public.app_review_authorize(1,jid,lease,oid,'unlike','DELETE','/me/library','spotify:track:'||repeat('1',22)),'already-added label never directly authorizes unlike');
 begin perform public.app_review_transition(1,jid,lease,'unlike_prepare'); raise exception 'unverified_done_accepted'; exception when raise_exception then if sqlerrm<>'invalid_action' then raise; end if; end;
end $$;
rollback to already_added_only;
savepoint selected_and_already_added;
insert into app.review_memberships(epoch,track_key,playlist_id,status,snapshot_id,checked_at) values(1,repeat('1',64),repeat('q',22),'present','cached',now());
select public.app_review_command(1,'draft',jsonb_build_object('revision','0','trackKey',repeat('1',64),'destinationIds',jsonb_build_array(repeat('p',22))));
select public.app_review_command(1,'done',jsonb_build_object('revision','1','trackKey',repeat('1',64),'requestId',gen_random_uuid()));
select pg_temp.assert((select count(*)=2 from app.review_operation_items where operation_id=(select active_id from app.review_state)),'Done unions explicit choices with eligible already-added destinations');
rollback to selected_and_already_added;
select public.app_review_command(1,'draft',jsonb_build_object('revision','0','trackKey',repeat('1',64),'destinationIds',jsonb_build_array(repeat('p',22),repeat('q',22))));
select pg_temp.assert((select not enabled from app.sources where id=repeat('p',22)),'destinations do not enable Sources');
select public.app_review_command(1,'done',jsonb_build_object('revision','1','trackKey',repeat('1',64),'requestId','11111111-1111-4111-8111-111111111111'));
-- Same command replays its receipt even after client revision advances.
select public.app_review_command(1,'done',jsonb_build_object('revision','1','trackKey',repeat('1',64),'requestId','11111111-1111-4111-8111-111111111111'));
select pg_temp.assert((select count(*)=1 from app.review_operations),'Done idempotent');
create temp table before_done_sync as select j.id,r.pass from app.jobs j join app.sync_runs r on r.job_id=j.id where j.kind='library_sync' and j.state='queued';
update app.jobs set state='running',lease_token='55555555-5555-4555-8555-555555555555',lease_until=now()+interval '1 hour' where id in(select id from before_done_sync);
update app.jobs set state='running',lease_token='22222222-2222-4222-8222-222222222222',lease_until=now()+interval '1 hour' where kind='review';
do $$ declare o app.review_operations; j uuid; lease uuid:='22222222-2222-4222-8222-222222222222'; begin
 select * into o from app.review_operations; j:=o.job_id;
 perform pg_temp.assert(public.app_review_worker(1,j,gen_random_uuid()) is null,'stale lease rejects state');
 perform pg_temp.assert(not public.app_review_authorize(1,j,lease,o.id,'append','POST','/playlists/'||repeat('p',22)||'/items',o.uri),'no append without intent');
 perform public.app_review_scan(1,j,lease,repeat('p',22),jsonb_build_object('status','absent','snapshotId','before','offset',0,'observed',0,'occurrences',0,'total',0));
 perform public.app_review_scan(1,j,lease,repeat('q',22),jsonb_build_object('status','present','snapshotId','preexisting','offset',1,'observed',1,'occurrences',1,'total',1));
 perform public.app_review_transition(1,j,lease,'preexisting',repeat('q',22));
 perform public.app_review_transition(1,j,lease,'append_intent',repeat('p',22));
 perform pg_temp.assert(public.app_review_authorize(1,j,lease,o.id,'append','POST','/playlists/'||repeat('p',22)||'/items',o.uri),'exact active append intent allowed');
 perform pg_temp.assert(not public.app_review_authorize(1,j,lease,o.id,'append','POST','/playlists/'||repeat('q',22)||'/items',o.uri),'preexisting destination cannot append');
 perform pg_temp.assert(not public.app_review_authorize(1,j,lease,o.id,'unlike','DELETE','/me/library',o.uri),'cannot unlike before confirmation');
 perform public.app_review_transition(1,j,lease,'append_uncertain',repeat('p',22));
 perform pg_temp.assert(not public.app_review_authorize(1,j,lease,o.id,'append','POST','/playlists/'||repeat('p',22)||'/items',o.uri),'ambiguous POST cannot replay');
 begin perform public.app_review_transition(1,j,lease,'unlike_prepare'); raise exception 'unresolved_unlike_accepted'; exception when raise_exception then if sqlerrm<>'invalid_action' then raise; end if; end;
 -- Reconcile presence, never infer dispatch attribution from it.
 perform public.app_review_scan(1,j,lease,repeat('p',22),jsonb_build_object('status','present','snapshotId','after','offset',1,'observed',1,'occurrences',1,'total',1));
 perform public.app_review_transition(1,j,lease,'unlike_prepare');
 perform public.app_review_transition(1,j,lease,'unlike_intent');
 perform pg_temp.assert(public.app_review_authorize(1,j,lease,o.id,'unlike','DELETE','/me/library',o.uri),'Done can unlike only matching URI');
 perform pg_temp.assert(not public.app_review_authorize(1,j,lease,o.id,'unlike','DELETE','/me/library','spotify:track:'||repeat('2',22)),'other version remains guarded');
 perform public.app_review_transition(1,j,lease,'completed');
 perform pg_temp.assert(not exists(select 1 from app.source_memberships where source_id='liked' and track_key=o.track_key),'Done removes liked membership');
 perform pg_temp.assert(exists(select 1 from app.source_memberships where source_id=repeat('p',22) and track_key=o.track_key),'Done retains independent playlist membership');
end $$;
select pg_temp.assert(public.app_library_page_commit(1,id,'55555555-5555-4555-8555-555555555555',pass,0,0,0,null,'[]',0,'{}') is null,'pre-Done scan cannot commit after completion') from before_done_sync;
select pg_temp.assert(not exists(select 1 from app.source_memberships where source_id='liked' and track_key=repeat('1',64)),'stale pre-Done scan does not resurrect unlike');
-- Capture a pre-Undo scan. Undo must cancel it before it can erase restoration.
create temp table stale_sync as select j.id,j.lease_token,r.pass from app.jobs j join app.sync_runs r on r.job_id=j.id where j.kind='library_sync' and j.state='queued';
update app.jobs set state='running',lease_token='33333333-3333-4333-8333-333333333333',lease_until=now()+interval '1 hour' where id in(select id from stale_sync);
select public.app_review_command(1,'undo',jsonb_build_object('revision',(select revision::text from app.review_state),'operationId',(select undo_id from app.review_state),'requestId','44444444-4444-4444-8444-444444444444'));
update app.jobs set state='running',lease_token='22222222-2222-4222-8222-222222222222',lease_until=now()+interval '1 hour' where kind='review' and state='queued';
do $$ declare o app.review_operations; lease uuid:='22222222-2222-4222-8222-222222222222'; begin
 select * into o from app.review_operations;
 perform public.app_review_transition(1,o.job_id,lease,'restore_intent');
 perform pg_temp.assert(public.app_review_authorize(1,o.job_id,lease,o.id,'restore','PUT','/me/library',o.uri),'most recent Undo restore allowed');
 perform public.app_review_transition(1,o.job_id,lease,'undone');
 perform pg_temp.assert(app.review_current(1)=o.track_key,'Undo returns exact track for correction');
 perform pg_temp.assert((select reversal_incomplete from app.review_operations where id=o.id),'unattributable addition reported honestly');
 perform pg_temp.assert((select state='preexisting' from app.review_operation_items where operation_id=o.id and playlist_id=repeat('q',22)),'Undo retains preexisting membership');
 perform pg_temp.assert(not public.app_review_authorize(1,o.job_id,lease,o.id,'restore','PUT','/me/library',o.uri),'completed Undo cannot restore again');
end $$;
select pg_temp.assert(public.app_library_page_commit(1,id,'33333333-3333-4333-8333-333333333333',pass,0,0,0,null,'[]',0,'{}') is null,'stale scan cannot erase Undo') from stale_sync;
select pg_temp.assert(exists(select 1 from app.source_memberships where source_id='liked' and track_key=repeat('1',64)),'stale scan leaves restored membership');
-- Definitively settled failures can return to their saved draft. Ambiguous
-- sends and a live worker lease cannot expose cancellation.
savepoint cancellation;
do $$ declare oid uuid; jid uuid; revision text; begin
 select s.revision::text into revision from app.review_state s;
 perform public.app_review_command(1,'draft',jsonb_build_object('revision',revision,'trackKey',repeat('1',64),'destinationIds',jsonb_build_array(repeat('p',22))));
 select s.revision::text into revision from app.review_state s;
 perform public.app_review_command(1,'done',jsonb_build_object('revision',revision,'trackKey',repeat('1',64),'requestId','66666666-6666-4666-8666-666666666666'));
 select s.active_id into oid from app.review_state s;
 select job_id into jid from app.review_operations where id=oid;
 update app.review_operations set status='needs_attention',error_code='destination_unavailable' where id=oid;
 update app.jobs set state='done' where id=jid;
 perform pg_temp.assert((app.review_operation_dto(oid)->>'canCancel')::boolean,'settled unavailable destination can cancel');
 update app.review_operation_items set state='unconfirmed' where operation_id=oid;
 perform pg_temp.assert(not (app.review_operation_dto(oid)->>'canCancel')::boolean,'ambiguous addition cannot cancel');
 update app.review_operation_items set state='confirmed',snapshot_id='confirmed' where operation_id=oid;
 update app.jobs set state='running',lease_until=now()+interval '1 hour',lease_token=gen_random_uuid() where id=jid;
 perform pg_temp.assert(not (app.review_operation_dto(oid)->>'canCancel')::boolean,'live lease cannot cancel');
 update app.jobs set state='done',lease_token=null,lease_until=null where id=jid;
 select s.revision::text into revision from app.review_state s;
 perform public.app_review_command(1,'cancel',jsonb_build_object('revision',revision,'operationId',oid));
 perform pg_temp.assert((select active_id is null from app.review_state),'cancel clears active failure');
 perform pg_temp.assert((select status='cancelled' from app.review_operations where id=oid),'cancel retains operation evidence');
 perform pg_temp.assert((select state='confirmed' from app.review_operation_items where operation_id=oid),'cancel preserves acknowledged addition evidence');
 perform pg_temp.assert(exists(select 1 from app.review_receipts where request_id='66666666-6666-4666-8666-666666666666'),'cancel retains idempotency receipt');
 perform pg_temp.assert(exists(select 1 from app.review_drafts where track_key=repeat('1',64)),'cancel restores saved draft for correction');
 perform pg_temp.assert(exists(select 1 from app.source_memberships where source_id='liked' and track_key=repeat('1',64)),'cancel never unlikes');
end $$;
rollback to cancellation;
-- Stale clients, accidental Discard and changed request identities fail atomically.
do $$ declare revision text; begin
 select s.revision::text into revision from app.review_state s;
 begin perform public.app_review_command(1,'skip',jsonb_build_object('revision','0','trackKey',repeat('1',64))); raise exception 'stale_accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
 begin perform public.app_review_command(1,'discard',jsonb_build_object('revision',revision,'trackKey',repeat('1',64),'requestId',gen_random_uuid(),'confirmation',false)); raise exception 'discard_accepted'; exception when raise_exception then if sqlerrm<>'invalid_input' then raise; end if; end;
 begin perform public.app_review_command(1,'discard',jsonb_build_object('revision',revision,'trackKey',repeat('1',64),'requestId','11111111-1111-4111-8111-111111111111','confirmation',true)); raise exception 'conflict_accepted'; exception when raise_exception then if sqlerrm<>'request_conflict' then raise; end if; end;
 perform public.app_review_command(1,'skip',jsonb_build_object('revision',revision,'trackKey',repeat('1',64)));
 perform pg_temp.assert(app.review_current(1)=repeat('2',64),'Skip advances oldest backlog');
 perform pg_temp.assert((public.app_review_get(1)->>'skipped')::integer=1,'GET resumes session skips');
 select s.revision::text into revision from app.review_state s;
 perform public.app_review_command(1,'session',jsonb_build_object('revision',revision));
 perform pg_temp.assert(not exists(select 1 from app.review_skips),'explicit new session restores skipped eligibility');
 perform public.app_review_command(1,'skip',jsonb_build_object('revision',(select s.revision::text from app.review_state s),'trackKey',app.review_current(1)));
 perform pg_temp.assert(app.review_current(1)=repeat('1',64),'restored skipped track remains eligible after older track');
 select s.revision::text into revision from app.review_state s;
 perform public.app_review_command(1,'discard',jsonb_build_object('revision',revision,'trackKey',repeat('1',64),'requestId',gen_random_uuid(),'confirmation',true));
 perform pg_temp.assert((select count(*)=0 from app.review_operation_items i join app.review_state s on s.active_id=i.operation_id),'Discard never copies saved destination selections');
end $$;
select pg_temp.assert(not has_function_privilege('anon','public.app_review_command(bigint,text,jsonb)','execute'),'browser cannot call review RPC');
rollback;
