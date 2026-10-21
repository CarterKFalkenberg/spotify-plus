-- Synthetic scale regression. Each RPC-sized page reconciles once; no metadata
-- row trigger may turn one page into a complete-library scan per recording.
begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
select app.ensure_sources(1);
update app.sources set last_synced_at=now() where epoch=1 and id='liked';
select pg_temp.assert(not exists(select 1 from pg_trigger where tgrelid='app.track_metadata'::regclass and not tgisinternal),'metadata does not reconcile once per recording');
-- Ten thousand source recordings: 5000 logical songs, each with two releases.
-- Separate 100-record pages model bounded Spotify import commits.
do $$ declare page integer; begin
 for page in 0..99 loop
  insert into app.annotations(track_key,epoch)
   select lpad(to_hex(i),64,'0'),1 from generate_series(page*100+1,(page+1)*100) i;
  insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id,playable_uri,duration_ms)
   select lpad(to_hex(i),64,'0'),lpad(i::text,22,'0'),'Synthetic scale song '||(((i-1)%5000)+1),
    '[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic scale artist"}]'::jsonb,'Synthetic scale release',
    timestamptz '2026-01-01'+make_interval(secs=>i),'11111111-1111-4111-8111-111111111111',
    'spotify:track:'||lpad(i::text,22,'0'),180000 from generate_series(page*100+1,(page+1)*100) i;
  insert into app.source_memberships(epoch,source_id,track_key,added_at)
   select 1,'liked',lpad(to_hex(i),64,'0'),timestamptz '2026-01-01'+make_interval(secs=>i) from generate_series(page*100+1,(page+1)*100) i;
  perform app.refresh_source_pool(1);
 end loop;
end $$;
select pg_temp.assert((select count(*)=10000 from app.song_group_members),'all original opaque recording identities retained');
select pg_temp.assert((select count(*)=5000 from app.song_groups),'ten thousand aliases form five thousand exact groups');
select pg_temp.assert((select count(*)=5000 from app.filter_keys('{"membership":"active","untagged":true,"newOnly":false}')),'large library browser counts logical songs once');
select pg_temp.assert((select bool_and(representative_key=lpad(to_hex(i),64,'0')) from app.song_groups g join generate_series(1,5000) i on g.group_key=lpad(to_hex(i),64,'0')),'all first eligible representatives remain stable after later duplicate pages');
create temp table scale_results(k text primary key,v jsonb);
insert into scale_results values('tag',public.app_tag_create(1,'Synthetic scale tag'));
insert into scale_results values('action',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','add','tagId',(select v#>>'{tag,id}' from scale_results where k='tag'),
 'selection',jsonb_build_object('kind','filter','filter','{"membership":"active","untagged":true,"newOnly":false}'::jsonb,'expectedRevision',app.library_revision()))));
select pg_temp.assert((select v->>'selectedCount'='5000' and v->>'changedCount'='5000' from scale_results where k='action'),'large bulk action reports logical song count');
select pg_temp.assert((select count(*)=10000 from app.track_tags where present),'large bulk action persists annotations to every original identity');
select pg_temp.assert((select count(*)=5000 from app.query_targets(jsonb_build_object('version',1,'root',jsonb_build_object('op','tag','tagId',(select v#>>'{tag,id}' from scale_results where k='tag'))))),'large query snapshot deduplicates all release aliases');
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from scale_results where k='action'))->>'restoredCount'='5000','large undo processes logical groups once');
select pg_temp.assert(not exists(select 1 from app.track_tags where present),'large undo leaves every original identity consistent');
rollback;
