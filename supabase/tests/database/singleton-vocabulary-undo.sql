-- Opaque singleton annotations and synthetic vocabulary; every fixture rolls back.
begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
insert into app.annotations select lpad(i::text,64,'0'),1 from generate_series(1,4) i;
insert into app.tags(id,epoch,name,normalized_name) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'Target','target'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'Source','source');
insert into app.track_tags(track_key,tag_id,present)
 select lpad(i::text,64,'0'),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true from generate_series(1,3) i;
insert into app.track_tags(track_key,tag_id,present) values(lpad('1',64,'0'),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
insert into app.playlists(id,epoch,name,query,retention,track_count,status) values(
 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,'Synthetic query',
 '{"version":1,"root":{"op":"not","child":{"op":"tag","tagId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}}}',
 'pinned',1,'ready');
do $$
declare merged jsonb; undone jsonb; deleted jsonb; q jsonb; scenario text;
begin
 select query into q from app.playlists where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 for scenario in select unnest(array['ungrouped','singleton_rows','new_alias']) loop
  merged:=public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','merge','sourceIds',jsonb_build_array('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),'targetId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','expectedRevision',app.library_revision()));
  perform pg_temp.assert((select count(*)=3 from app.song_action_groups where action_id=(merged->>'actionId')::uuid),'vocabulary action snapshots every opaque singleton');
  if scenario<>'ungrouped' then
   insert into app.song_groups(group_key,epoch,representative_key)
    select lpad(i::text,64,'0'),1,lpad(i::text,64,'0') from generate_series(1,3) i;
   insert into app.song_group_members(track_key,group_key)
    select lpad(i::text,64,'0'),lpad(i::text,64,'0') from generate_series(1,3) i;
  end if;
  if scenario='new_alias' then
   insert into app.song_group_members(track_key,group_key) values(lpad('4',64,'0'),lpad('1',64,'0'));
   insert into app.track_tags(track_key,tag_id,present) values(lpad('4',64,'0'),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  end if;
  undone:=public.app_tag_undo(1,repeat('b',64),(merged->>'actionId')::uuid);
  perform pg_temp.assert((select query=q from app.playlists where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'),'merge undo restores nested query identity');
  if scenario='new_alias' then
   perform pg_temp.assert(undone->>'skippedCount'='1','real alias arrival still conflicts with entire old component');
   perform pg_temp.assert(not exists(select 1 from app.track_tags where track_key in (lpad('1',64,'0'),lpad('4',64,'0')) and tag_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and present),'conflicting component cannot partially restore source');
   perform pg_temp.assert((select count(*)=2 from app.track_tags where track_key in (lpad('1',64,'0'),lpad('4',64,'0')) and tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'later target assignments survive component conflict');
  else
   perform pg_temp.assert(undone->>'skippedCount'='0','unchanged singleton vocabulary undo skips nothing: '||scenario);
   perform pg_temp.assert((select count(*)=3 from app.track_tags where tag_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and present),'unchanged singleton merge restores all source assignments');
   perform pg_temp.assert((select count(*)=1 from app.track_tags where tag_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and present),'preexisting target assignment survives changed-only merge undo');
   deleted:=public.app_tags_manage(1,repeat('b',64),jsonb_build_object('action','delete','tagId','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','confirmedAssignmentCount',3,'expectedRevision',app.library_revision()));
   undone:=public.app_tag_undo(1,repeat('b',64),(deleted->>'actionId')::uuid);
   perform pg_temp.assert(undone->>'restoredCount'='3' and undone->>'skippedCount'='0','singleton delete undo restores all changed assignments');
  end if;
  delete from app.song_group_members where track_key is not null;
  delete from app.song_groups where group_key is not null;
 end loop;
end $$;
rollback;
