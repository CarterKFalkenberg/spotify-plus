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
create function pg_temp.import_scale_page(page integer) returns void language plpgsql as $$ begin
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
end $$;
-- Each page and each interactive RPC must fit below ServiceDatabase's five-second
-- abort deadline. Separate statements give every import page its own budget.
set local statement_timeout='4s';
select pg_temp.import_scale_page(0);
select pg_temp.import_scale_page(1);
select pg_temp.import_scale_page(2);
select pg_temp.import_scale_page(3);
select pg_temp.import_scale_page(4);
select pg_temp.import_scale_page(5);
select pg_temp.import_scale_page(6);
select pg_temp.import_scale_page(7);
select pg_temp.import_scale_page(8);
select pg_temp.import_scale_page(9);
select pg_temp.import_scale_page(10);
select pg_temp.import_scale_page(11);
select pg_temp.import_scale_page(12);
select pg_temp.import_scale_page(13);
select pg_temp.import_scale_page(14);
select pg_temp.import_scale_page(15);
select pg_temp.import_scale_page(16);
select pg_temp.import_scale_page(17);
select pg_temp.import_scale_page(18);
select pg_temp.import_scale_page(19);
select pg_temp.import_scale_page(20);
select pg_temp.import_scale_page(21);
select pg_temp.import_scale_page(22);
select pg_temp.import_scale_page(23);
select pg_temp.import_scale_page(24);
select pg_temp.import_scale_page(25);
select pg_temp.import_scale_page(26);
select pg_temp.import_scale_page(27);
select pg_temp.import_scale_page(28);
select pg_temp.import_scale_page(29);
select pg_temp.import_scale_page(30);
select pg_temp.import_scale_page(31);
select pg_temp.import_scale_page(32);
select pg_temp.import_scale_page(33);
select pg_temp.import_scale_page(34);
select pg_temp.import_scale_page(35);
select pg_temp.import_scale_page(36);
select pg_temp.import_scale_page(37);
select pg_temp.import_scale_page(38);
select pg_temp.import_scale_page(39);
select pg_temp.import_scale_page(40);
select pg_temp.import_scale_page(41);
select pg_temp.import_scale_page(42);
select pg_temp.import_scale_page(43);
select pg_temp.import_scale_page(44);
select pg_temp.import_scale_page(45);
select pg_temp.import_scale_page(46);
select pg_temp.import_scale_page(47);
select pg_temp.import_scale_page(48);
select pg_temp.import_scale_page(49);
select pg_temp.import_scale_page(50);
select pg_temp.import_scale_page(51);
select pg_temp.import_scale_page(52);
select pg_temp.import_scale_page(53);
select pg_temp.import_scale_page(54);
select pg_temp.import_scale_page(55);
select pg_temp.import_scale_page(56);
select pg_temp.import_scale_page(57);
select pg_temp.import_scale_page(58);
select pg_temp.import_scale_page(59);
select pg_temp.import_scale_page(60);
select pg_temp.import_scale_page(61);
select pg_temp.import_scale_page(62);
select pg_temp.import_scale_page(63);
select pg_temp.import_scale_page(64);
select pg_temp.import_scale_page(65);
select pg_temp.import_scale_page(66);
select pg_temp.import_scale_page(67);
select pg_temp.import_scale_page(68);
select pg_temp.import_scale_page(69);
select pg_temp.import_scale_page(70);
select pg_temp.import_scale_page(71);
select pg_temp.import_scale_page(72);
select pg_temp.import_scale_page(73);
select pg_temp.import_scale_page(74);
select pg_temp.import_scale_page(75);
select pg_temp.import_scale_page(76);
select pg_temp.import_scale_page(77);
select pg_temp.import_scale_page(78);
select pg_temp.import_scale_page(79);
select pg_temp.import_scale_page(80);
select pg_temp.import_scale_page(81);
select pg_temp.import_scale_page(82);
select pg_temp.import_scale_page(83);
select pg_temp.import_scale_page(84);
select pg_temp.import_scale_page(85);
select pg_temp.import_scale_page(86);
select pg_temp.import_scale_page(87);
select pg_temp.import_scale_page(88);
select pg_temp.import_scale_page(89);
select pg_temp.import_scale_page(90);
select pg_temp.import_scale_page(91);
select pg_temp.import_scale_page(92);
select pg_temp.import_scale_page(93);
select pg_temp.import_scale_page(94);
select pg_temp.import_scale_page(95);
select pg_temp.import_scale_page(96);
select pg_temp.import_scale_page(97);
select pg_temp.import_scale_page(98);
select pg_temp.import_scale_page(99);
-- Steady-state statistics matter: freshly inserted, unanalyzed tables can hide
-- a generic JSON-filter plan that becomes quadratic after autovacuum analyzes
-- a real library. Exercise interactive RPC deadlines with accurate row counts.
analyze app.annotations,app.track_metadata,app.song_group_members,app.song_groups,
 app.source_memberships,app.sources,app.track_tags;
select pg_temp.assert((select count(*)=10000 from app.song_group_members),'all original opaque recording identities retained');
select pg_temp.assert((select count(*)=5000 from app.song_groups),'ten thousand aliases form five thousand exact groups');
select pg_temp.assert((select count(*)=5000 from app.filter_keys('{"membership":"active","untagged":true,"newOnly":false}')),'large library browser counts logical songs once');
select pg_temp.assert((select bool_and(representative_key=lpad(to_hex(i),64,'0')) from app.song_groups g join generate_series(1,5000) i on g.group_key=lpad(to_hex(i),64,'0')),'all first eligible representatives remain stable after later duplicate pages');
create temp table scale_results(k text primary key,v jsonb);
insert into scale_results values('status',public.app_library_status(1));
select pg_temp.assert((select v->>'activeCount'='5000' from scale_results where k='status'),'large status counts logical songs');
insert into scale_results values('sources',public.app_sources_list(1,'',0,50));
select pg_temp.assert((select v->>'uniqueTrackCount'='5000' and jsonb_array_length(v->'items')=1 and v#>>'{items,0,uniqueCount}'='5000' from scale_results where k='sources'),'large Sources page counts shared songs once');
insert into scale_results values('search',public.app_library_search(1,jsonb_build_object(
 'filter','{"membership":"active","untagged":true,"newOnly":false}'::jsonb,'sort','newest','limit',50)));
select pg_temp.assert((select v->>'totalTracks'='5000' and jsonb_array_length(v->'tracks')=50 from scale_results where k='search'),'large search counts logical songs with a bounded page');
insert into scale_results values('tag',public.app_tag_create(1,'Synthetic scale tag'));
insert into scale_results values('action',public.app_tag_action(1,repeat('b',64),jsonb_build_object('action','add','tagId',(select v#>>'{tag,id}' from scale_results where k='tag'),
 'selection',jsonb_build_object('kind','filter','filter','{"membership":"active","untagged":true,"newOnly":false}'::jsonb,'expectedRevision',app.library_revision()))));
select pg_temp.assert((select v->>'selectedCount'='5000' and v->>'changedCount'='5000' from scale_results where k='action'),'large bulk action reports logical song count');
select pg_temp.assert((select count(*)=10000 from app.track_tags where present),'large bulk action persists annotations to every original identity');
select pg_temp.assert((select count(*)=5000 from app.query_targets(jsonb_build_object('version',1,'root',jsonb_build_object('op','tag','tagId',(select v#>>'{tag,id}' from scale_results where k='tag'))))),'large query snapshot deduplicates all release aliases');
select pg_temp.assert(public.app_tag_undo(1,repeat('b',64),(select (v->>'actionId')::uuid from scale_results where k='action'))->>'restoredCount'='5000','large undo processes logical groups once');
select pg_temp.assert(not exists(select 1 from app.track_tags where present),'large undo leaves every original identity consistent');
rollback;
