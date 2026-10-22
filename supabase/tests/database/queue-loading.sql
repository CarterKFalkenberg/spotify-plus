begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
insert into app.annotations select lpad(i::text,64,'0'),1 from generate_series(1,5) i;
insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id,playable_uri,duration_ms)
 select lpad(i::text,64,'0'),lpad(i::text,22,'0'),case when i<3 then 'Synthetic duplicate' else 'Synthetic song '||i end,
 '[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic"}]'::jsonb,'Synthetic album',
 timestamptz '2026-01-01'+make_interval(days=>i),'11111111-1111-4111-8111-111111111111','spotify:track:'||lpad(i::text,22,'0'),180000 from generate_series(1,5) i;
select app.refresh_song_groups(1);
create temp table results(k text primary key,v jsonb);
insert into results values('filter','{"membership":"active","untagged":true,"newOnly":false}');
insert into results values('capture',public.app_queue_snapshot(1,jsonb_build_object('filter',(select v from results where k='filter'),'sort','newest','seed',null)));
select pg_temp.assert((select jsonb_array_length(v->'trackKeys')=4 and v#>>'{trackKeys,0}'=lpad('5',64,'0') and v#>>'{trackKeys,3}'=lpad('1',64,'0') from results where k='capture'),'capture respects logical identity and newest source addition ordering');
insert into results values('random',public.app_queue_snapshot(1,jsonb_build_object('filter',(select v from results where k='filter'),'sort','random','seed','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')));
select pg_temp.assert((select v->'trackKeys' from results where k='random')=public.app_queue_snapshot(1,jsonb_build_object('filter',(select v from results where k='filter'),'sort','random','seed','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))->'trackKeys','random order repeats with retained seed');
insert into results values('selection',jsonb_build_object('kind','filter','filter',(select v from results where k='filter'),'expectedRevision',app.library_revision()));
insert into results values('tag',public.app_tag_create(1,'Synthetic queue tag'));
select public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','add','tagId',(select v#>>'{tag,id}' from results where k='tag'),'selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('5',64,'0')))));
select pg_temp.assert(public.app_queue_tracks(1,jsonb_build_object('trackKeys',(select v->'trackKeys' from results where k='capture')))#>>'{entries,0,track,tagIds,0}'=(select v#>>'{tag,id}' from results where k='tag'),'hydration preserves captured membership after own tag invalidates untagged filter');
do $$ begin
 begin perform public.app_queue_snapshot(1,jsonb_build_object('filter',(select v from results where k='filter'),'sort','newest','seed',null,'selection',(select v from results where k='selection'))); raise exception 'stale selection accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end;
 begin perform public.app_queue_tracks(999,jsonb_build_object('trackKeys',jsonb_build_array(lpad('1',64,'0')))); raise exception 'wrong epoch accepted'; exception when raise_exception then if sqlerrm<>'inactive_epoch' then raise; end if; end;
 begin perform public.app_queue_tracks(1,'{"trackKeys":[]}'::jsonb); raise exception 'empty request accepted'; exception when raise_exception then if sqlerrm<>'invalid_input' then raise; end if; end;
end $$;
-- A removed representative resolves through its original captured component.
update app.track_metadata set removed_at=now() where track_key=lpad('1',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(public.app_queue_tracks(1,jsonb_build_object('trackKeys',jsonb_build_array(lpad('1',64,'0'))))#>>'{entries,0,key}'=lpad('1',64,'0') and public.app_queue_tracks(1,jsonb_build_object('trackKeys',jsonb_build_array(lpad('1',64,'0'))))#>>'{entries,0,track,trackKey}'=lpad('2',64,'0'),'hydration retains captured slot and returns current representative identity');
update app.track_metadata set removed_at=now() where track_key=lpad('2',64,'0');
select app.refresh_song_groups(1);
select pg_temp.assert(jsonb_array_length(public.app_queue_tracks(1,jsonb_build_object('trackKeys',jsonb_build_array(lpad('1',64,'0'))))->'entries')=0,'last membership loss omits captured song');
select pg_temp.assert(jsonb_array_length(public.app_queue_snapshot(1,jsonb_build_object('filter',(select v from results where k='filter'),'sort','oldest','seed',null,'selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array(lpad('3',64,'0')))))->'trackKeys')=1,'explicit capture selection intersects matching active songs');
rollback;
