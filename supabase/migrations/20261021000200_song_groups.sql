-- Exact duplicate recordings share annotations; links contain only opaque annotation identities.
-- Titles preserve punctuation and version suffixes. Artist identities are complete sets,
-- using Spotify IDs when present and normalized names only for missing IDs.
create table app.song_groups (
 group_key text primary key references app.annotations(track_key),
 epoch bigint not null,
 created_at timestamptz not null default clock_timestamp(),
 representative_key text references app.annotations(track_key)
);
create table app.song_group_members (
 track_key text primary key references app.annotations(track_key),
 group_key text not null references app.song_groups(group_key)
);
create index song_group_members_group on app.song_group_members(group_key);
create table app.song_action_groups (
 action_id uuid not null references app.tag_actions(id) on delete cascade,
 group_key text not null,
 member_keys text[] not null,
 primary key(action_id,group_key)
);
alter table app.song_groups enable row level security;
alter table app.song_group_members enable row level security;
alter table app.song_action_groups enable row level security;

create function app.song_group_key(p_key text) returns text language sql stable set search_path='' as $$
 select coalesce((select group_key from app.song_group_members where track_key=p_key),p_key);
$$;
create function app.song_representative(p_key text) returns text language sql stable set search_path='' as $$
 select coalesce((select representative_key from app.song_groups where group_key=app.song_group_key(p_key)),p_key);
$$;
create function app.song_identity(p_title text,p_artists jsonb) returns text language sql immutable set search_path='' as $$
 select case when app.normalized_label(p_title)<>'' and jsonb_array_length(p_artists)>0
 and not exists(select 1 from jsonb_array_elements(p_artists) a where coalesce(nullif(a->>'id',''),nullif(app.normalized_label(a->>'name'),'')) is null)
 then jsonb_build_array(app.normalized_label(p_title),(select jsonb_agg(identity order by identity) from
 (select distinct case when nullif(a->>'id','') is not null then 'id:'||(a->>'id') else 'name:'||app.normalized_label(a->>'name') end as identity
 from jsonb_array_elements(p_artists) a) artists))::text else null end;
$$;

create function app.refresh_song_groups(p_epoch bigint) returns void language plpgsql set search_path='' as $$
 declare bucket record; roots text[]; target text; prior text; candidate text; changed boolean:=false; affected integer;
 begin
  perform app.require_owner(p_epoch);
  insert into app.song_groups(group_key,epoch,representative_key)
   select track_key,p_epoch,track_key from app.annotations where epoch=p_epoch
   and not exists(select 1 from app.song_group_members s where s.track_key=app.annotations.track_key)
   on conflict(group_key) do nothing;
  insert into app.song_group_members(track_key,group_key)
   select track_key,track_key from app.annotations where epoch=p_epoch on conflict(track_key) do nothing;
  -- Existing links survive metadata retention and returning tracks. Newly discovered exact
  -- identities union complete components, preserving every original annotation assignment.
  for bucket in select app.song_identity(m.title,m.artists) identity,array_agg(m.track_key) keys
   from app.track_metadata m join app.annotations a using(track_key) join app.song_group_members sm using(track_key) where a.epoch=p_epoch
   group by app.song_identity(m.title,m.artists) having count(distinct sm.group_key)>1 and app.song_identity(m.title,m.artists) is not null loop
   select array_agg(distinct group_key order by group_key) into roots from app.song_group_members where track_key=any(bucket.keys);
   if cardinality(roots)>1 then
    select group_key into target from app.song_groups where group_key=any(roots) order by created_at,group_key limit 1;
    update app.song_group_members set group_key=target where group_key=any(roots) and group_key<>target;
    delete from app.song_groups where group_key=any(roots) and group_key<>target;
    changed:=true;
   end if;
  end loop;
  -- Acknowledgement belongs to the logical song too: another source/release
  -- must not turn an already seen song into a new-arrivals notification again.
  with acknowledged as (
   select sm.group_key,min(m.acknowledged_at) seen_at from app.song_group_members sm
   join app.track_metadata m using(track_key) join app.song_groups g using(group_key)
   where g.epoch=p_epoch and m.acknowledged_at is not null group by sm.group_key
  ) update app.track_metadata m set acknowledged_at=a.seen_at from app.song_group_members sm
   join acknowledged a using(group_key) where sm.track_key=m.track_key and m.acknowledged_at is null;
  -- Union preexisting conflicting annotations without deleting original identities.
  insert into app.track_tags(track_key,tag_id,present,version)
   select distinct dest.track_key,t.tag_id,true,1 from app.song_group_members src
   join app.track_tags t on t.track_key=src.track_key and t.present
   join app.tags tag on tag.id=t.tag_id and tag.deleted_at is null
   join app.song_group_members dest on dest.group_key=src.group_key
   join app.song_groups g on g.group_key=src.group_key and g.epoch=p_epoch
   on conflict(track_key,tag_id) do update set present=true,version=app.track_tags.version+1 where not app.track_tags.present;
  get diagnostics affected=row_count;
  if affected>0 then update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch; end if;
  with candidates as (
   select distinct on (sm.group_key) sm.group_key,m.track_key
   from app.song_group_members sm join app.song_groups g using(group_key)
   join app.track_metadata m using(track_key) where g.epoch=p_epoch
   order by sm.group_key,(m.removed_at is null) desc,(m.playable_uri is not null and m.duration_ms>0 and m.duration_ms<=86400000) desc,
    (m.track_key=g.representative_key) desc,m.track_key
  ) update app.song_groups g set representative_key=c.track_key from candidates c
   where g.group_key=c.group_key and g.representative_key is distinct from c.track_key;
  get diagnostics affected=row_count;
  changed:=changed or affected>0;
  if changed then update app.library_state set library_revision=library_revision+1 where singleton and epoch=p_epoch; end if;
 end;
$$;
create function app.song_added_at(p_key text) returns timestamptz language sql stable set search_path='' as $$
 select coalesce((select max(sm.added_at) from app.source_memberships sm join app.sources s on s.epoch=sm.epoch and s.id=sm.source_id
 where sm.track_key in (select track_key from app.song_group_members where group_key=app.song_group_key(p_key) union select p_key) and s.enabled),
 (select max(m.liked_at) from app.track_metadata m where m.track_key in (select track_key from app.song_group_members where group_key=app.song_group_key(p_key) union select p_key)));
$$;

create or replace function app.filter_keys(p_filter jsonb) returns table(track_key text,liked_at timestamptz)
 language sql stable set search_path='' as $$
 select m.track_key,app.song_added_at(m.track_key) from app.track_metadata m join app.annotations a using(track_key)
 where m.track_key=app.song_representative(m.track_key)
 and a.epoch=(select epoch from app.library_state where singleton)
 and ((p_filter->>'membership'='active' and m.removed_at is null) or (p_filter->>'membership'='removed' and m.removed_at is not null))
 and (not (p_filter->>'untagged')::boolean or not exists(select 1 from app.track_tags t where t.track_key=m.track_key and t.present))
 and (not (p_filter->>'newOnly')::boolean or (m.removed_at is null and m.acknowledged_at is null))
 and (not coalesce((p_filter->>'latestSyncOnly')::boolean,false) or (m.removed_at is null and m.added_run_id=(select completed_run_id from app.library_state where singleton)))
 and (p_filter->>'artistId' is null or exists(select 1 from jsonb_array_elements(m.artists) ar where ar->>'id'=p_filter->>'artistId'))
 and (p_filter->>'album' is null or app.album_identity(m.album)=p_filter->>'album')
 and (p_filter->>'decade' is null or app.track_decade(m.release_date)=p_filter->>'decade')
 and (coalesce(p_filter->>'search','')='' or position(lower(normalize(p_filter->>'search',NFC)) in
  lower(normalize(m.title||' '||m.album||' '||coalesce((select string_agg(ar->>'name',' ') from jsonb_array_elements(m.artists) ar),''),NFC)))>0)
 order by app.song_added_at(m.track_key) desc,m.track_key;
$$;

create or replace function app.query_targets(p_query jsonb)
 returns table(track_key text,playable_uri text,liked_at timestamptz,duration_ms bigint)
 language plpgsql stable set search_path='' as $$
 begin
  perform app.validate_query(p_query);
  return query select m.track_key,m.playable_uri,app.song_added_at(m.track_key),m.duration_ms
   from app.track_metadata m join app.annotations a using(track_key)
   where m.track_key=app.song_representative(m.track_key) and a.epoch=(select epoch from app.library_state where singleton) and m.removed_at is null
    and app.query_matches(p_query->'root',m.track_key)
   order by app.song_added_at(m.track_key) desc,m.track_key;
 end;
$$;
create or replace function app.selection_keys(p_epoch bigint,p_selection jsonb) returns text[] language plpgsql set search_path='' as $$
 declare keys text[];
 begin
  if p_selection->>'kind'='filter' then
   perform app.require_revision(p_selection->'expectedRevision');
   select coalesce(array_agg(track_key),'{}'::text[]) into keys from app.filter_keys(p_selection->'filter');
  elsif p_selection->>'kind'='tracks' then
   select array_agg(value) into keys from jsonb_array_elements_text(p_selection->'trackKeys');
   if cardinality(keys) not between 1 and 200 or cardinality(keys)<>(select count(distinct k) from unnest(keys) k) then raise exception 'invalid_input'; end if;
  else raise exception 'invalid_input'; end if;
  if exists(select 1 from unnest(keys) k where not exists(select 1 from app.annotations a where a.track_key=k and a.epoch=p_epoch)) then raise exception 'unknown_track'; end if;
  select coalesce(array_agg(distinct app.song_representative(k)), '{}'::text[]) into keys from unnest(keys) k;
  return keys;
 end;
$$;
create or replace function public.app_tag_action(p_epoch bigint,p_session_hash text,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare keys text[]; logical_keys text[];  v_tag_id uuid; resolved jsonb; desired boolean; v_action_id uuid; changed integer:=0; key text; old_edge app.track_tags; next_version bigint;
 begin
  perform app.require_owner(p_epoch);
  if not exists(select 1 from app.sessions where token_hash=p_session_hash and epoch=p_epoch and expires_at>now()) then raise exception 'inactive_epoch'; end if;
  if p_request->>'action' is null or p_request->>'action' not in ('add','remove') then raise exception 'invalid_input'; end if;
  desired:=p_request->>'action'='add';
  if (p_request ? 'tagId') = (p_request ? 'tagName') or (p_request ? 'tagName' and not desired) then raise exception 'invalid_input'; end if;
  -- Freeze the exact selection against the caller's revision BEFORE vocabulary creation
  -- changes the annotation revision. Any later error rolls both changes back together.
  keys:=app.selection_keys(p_epoch,p_request->'selection');
  logical_keys:=keys;
  select coalesce(array_agg(a.track_key order by a.track_key),'{}'::text[]) into keys from app.annotations a
   where a.epoch=p_epoch and app.song_group_key(a.track_key)=any(array(select app.song_group_key(k) from unnest(logical_keys) k));
  if p_request ? 'tagName' then
   if cardinality(keys)=0 then raise exception 'unknown_track'; end if;
   resolved:=public.app_tag_create(p_epoch,p_request->>'tagName');
   v_tag_id:=(resolved->'tag'->>'id')::uuid;
  else
   v_tag_id:=(p_request->>'tagId')::uuid;
   if not exists(select 1 from app.tags where id=v_tag_id and epoch=p_epoch and deleted_at is null) then raise exception 'unknown_tag'; end if;
  end if;
  insert into app.tag_actions(epoch,session_hash,tag_id) values(p_epoch,p_session_hash,v_tag_id) returning id into v_action_id;
  insert into app.song_action_groups(action_id,group_key,member_keys)
   select v_action_id,app.song_group_key(k),array_agg(k order by k) from unnest(keys) k group by app.song_group_key(k);
  foreach key in array keys loop
   select * into old_edge from app.track_tags where track_key=key and app.track_tags.tag_id=v_tag_id;
   if coalesce(old_edge.present,false)=desired then continue; end if;
   next_version:=coalesce(old_edge.version,0)+1;
   insert into app.track_tags(track_key,tag_id,present,version) values(key,v_tag_id,desired,next_version)
    on conflict(track_key,tag_id) do update set present=excluded.present,version=excluded.version;
   insert into app.tag_action_edges values(v_action_id,key,coalesce(old_edge.present,false),next_version);
   changed:=changed+1;
  end loop;
  if changed>0 then
   update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch;
   if desired then update app.tags set last_used_at=now() where id=v_tag_id and epoch=p_epoch; end if;
  end if;
  return jsonb_build_object('actionId',v_action_id,'tag',app.tag_dto(v_tag_id),'selectedCount',cardinality(logical_keys),'changedCount',(select count(distinct app.song_group_key(e.track_key)) from app.tag_action_edges e where e.action_id=v_action_id),'revision',app.library_revision());
 end;
$$;
-- Undo each logical song atomically. A later edit or changed component skips that
-- complete song, so stale undo cannot leave aliases with conflicting annotations.
create or replace function app.app_tag_assignment_undo(p_epoch bigint,p_session_hash text,p_action_id uuid) returns jsonb
 language plpgsql set search_path='' as $$
 declare action app.tag_actions; entry record; current_keys text[]; total integer:=0; restored integer:=0;
 begin
  perform app.require_owner(p_epoch);
  if not exists(select 1 from app.sessions where token_hash=p_session_hash and epoch=p_epoch and expires_at>now()) then raise exception 'inactive_epoch'; end if;
  select * into action from app.tag_actions where id=p_action_id and epoch=p_epoch and session_hash=p_session_hash for update;
  if not found then raise exception 'unknown_action'; end if;
  if action.undone_at is not null then return jsonb_build_object('actionId',p_action_id,'restoredCount',0,'skippedCount',0,'revision',app.library_revision()); end if;
  -- Existing pre-migration journals remain valid and are checked as a group too.
  for entry in select app.song_group_key(e.track_key) group_key,array_agg(e.track_key) keys
   from app.tag_action_edges e where e.action_id=p_action_id group by app.song_group_key(e.track_key) loop
   total:=total+1;
   select array_agg(member.track_key order by member.track_key) into current_keys from (
    select sm.track_key from app.song_group_members sm where sm.group_key=entry.group_key
    union select entry.group_key where not exists(select 1 from app.song_group_members where track_key=entry.group_key)
   ) member;
   if exists(select 1 from app.song_action_groups g where g.action_id=p_action_id
    and g.group_key=any(current_keys) and g.member_keys is distinct from current_keys)
    or exists(select 1 from app.tag_action_edges e left join app.track_tags t on t.track_key=e.track_key and t.tag_id=action.tag_id
     where e.action_id=p_action_id and e.track_key=any(current_keys) and t.version is distinct from e.after_version)
    or exists(select 1 from unnest(current_keys) k where not exists(select 1 from app.tag_action_edges e where e.action_id=p_action_id and e.track_key=k))
    then continue; end if;
   update app.track_tags t set present=e.before_present,version=t.version+1 from app.tag_action_edges e
    where e.action_id=p_action_id and e.track_key=any(current_keys) and t.track_key=e.track_key and t.tag_id=action.tag_id;
   restored:=restored+1;
  end loop;
  update app.tag_actions set undone_at=now() where id=p_action_id and epoch=p_epoch;
  if restored>0 then update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch; end if;
  return jsonb_build_object('actionId',p_action_id,'restoredCount',restored,'skippedCount',total-restored,'revision',app.library_revision());
 end;
$$;

create or replace function app.tag_dto(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',t.id,'name',t.name,'lastUsedAt',t.last_used_at,
 'activeTrackCount',(select count(distinct app.song_group_key(e.track_key)) from app.track_tags e join app.track_metadata m using(track_key)
 where e.tag_id=t.id and e.present and m.removed_at is null)) from app.tags t where t.id=p_id;
$$;

create or replace function public.app_playback_track(p_epoch bigint,p_track_key text) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb;
 begin
  perform app.require_owner(p_epoch,true);
  if p_track_key is null or p_track_key !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input'; end if;
  select jsonb_build_object('uri',m.playable_uri,'durationMs',m.duration_ms) into result
   from app.track_metadata m join app.annotations a using(track_key)
   where m.track_key=app.song_representative(p_track_key) and a.epoch=p_epoch and m.removed_at is null
    and m.playable_uri is not null and m.duration_ms>0 and m.duration_ms<=86400000;
  return result;
 end;
$$;

create or replace function public.app_library_acknowledge(p_epoch bigint,p_track_keys jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare keys text[]; changed integer;
 begin
  perform app.require_owner(p_epoch);
  keys:=app.selection_keys(p_epoch,jsonb_build_object('kind','tracks','trackKeys',p_track_keys));
  select count(distinct app.song_group_key(m.track_key)) into changed from app.track_metadata m
   where app.song_group_key(m.track_key)=any(array(select app.song_group_key(k) from unnest(keys) k))
   and m.removed_at is null and m.acknowledged_at is null;
  update app.track_metadata set acknowledged_at=now()
   where app.song_group_key(track_key)=any(array(select app.song_group_key(k) from unnest(keys) k))
   and removed_at is null and acknowledged_at is null;
  if changed>0 then update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch; end if;
  return jsonb_build_object('changedCount',changed,'revision',app.library_revision());
 end;
$$;

-- Backup only opaque relationships and annotations; recording fingerprints and
-- Spotify metadata never enter the annotation snapshot.
alter function public.app_backup_prepare(bigint,uuid,uuid) rename to app_backup_prepare_before_song_groups;
create function public.app_backup_prepare(p_epoch bigint,p_id uuid,p_lease uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb; groups jsonb;
 begin
  result:=public.app_backup_prepare_before_song_groups(p_epoch,p_id,p_lease);
  if result is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('groupKey',group_key,'trackKeys',keys) order by group_key),'[]') into groups
   from (select g.group_key,jsonb_agg(m.track_key order by m.track_key) keys from app.song_groups g
    join app.song_group_members m using(group_key) where g.epoch=p_epoch group by g.group_key having count(*)>1) grouped;
  return jsonb_set(result,'{snapshot,songGroups}',groups);
 end;
$$;
alter function public.app_backup_restore(bigint,text,bigint,jsonb) rename to app_backup_restore_before_song_groups;
create function public.app_backup_restore(p_epoch bigint,p_owner text,p_expected_revision bigint,p_snapshot jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb; g jsonb; k text; total integer:=0; seen text[]:='{}'; roots text[]; target text;
 begin
  perform app.require_owner(p_epoch);
  if octet_length(p_snapshot::text)>4264933 then raise exception 'invalid_input'; end if;
  if p_snapshot ? 'songGroups' then
   if jsonb_typeof(p_snapshot->'songGroups') is distinct from 'array' then raise exception 'invalid_input'; end if;
   for g in select value from jsonb_array_elements(p_snapshot->'songGroups') loop
    if jsonb_typeof(g) is distinct from 'object' or (select count(*) from jsonb_object_keys(g))<>2
     or not g ?& array['groupKey','trackKeys'] or jsonb_typeof(g->'groupKey') is distinct from 'string'
     or not coalesce(g->>'groupKey' ~ '^[a-f0-9]{64}$',false)
     or jsonb_typeof(g->'trackKeys') is distinct from 'array' then raise exception 'invalid_input'; end if;
    if jsonb_array_length(g->'trackKeys')<1 or not g->'trackKeys' ? (g->>'groupKey') then raise exception 'invalid_input'; end if;
    if exists(select 1 from jsonb_array_elements(g->'trackKeys') member where jsonb_typeof(member) is distinct from 'string') then raise exception 'invalid_input'; end if;
    for k in select value from jsonb_array_elements_text(g->'trackKeys') loop
     total:=total+1;
     if total>100000 or k !~ '^[a-f0-9]{64}$' or k=any(seen)
      or exists(select 1 from app.annotations where track_key=k and epoch<>p_epoch) then raise exception 'invalid_input'; end if;
     seen:=array_append(seen,k);
    end loop;
   end loop;
  end if;
  result:=public.app_backup_restore_before_song_groups(p_epoch,p_owner,p_expected_revision,p_snapshot-'songGroups');
  -- Never sever links established since the snapshot; old snapshots remain supported.
  insert into app.annotations(track_key,epoch) select item.key,p_epoch from unnest(seen) item(key) on conflict(track_key) do nothing;
  perform app.refresh_song_groups(p_epoch);
  for g in select value from jsonb_array_elements(coalesce(p_snapshot->'songGroups','[]')) loop
   select array_agg(distinct app.song_group_key(value) order by app.song_group_key(value)) into roots from jsonb_array_elements_text(g->'trackKeys');
   select group_key into target from app.song_groups where group_key=any(roots) order by created_at,group_key limit 1;
   update app.song_group_members set group_key=target where group_key=any(roots);
   delete from app.song_groups where group_key=any(roots) and group_key<>target;
  end loop;
  perform app.refresh_song_groups(p_epoch);
  return result;
 end;
$$;

alter function app.purge_product_data() rename to purge_product_data_before_song_groups;
create function app.purge_product_data() returns void language plpgsql set search_path='' as $$
 begin
  delete from app.song_action_groups where action_id is not null;
  delete from app.song_group_members where track_key is not null;
  delete from app.song_groups where group_key is not null;
  perform app.purge_product_data_before_song_groups();
 end;
$$;

do $$ declare f record; begin
 if exists(select 1 from app.account where state in ('connected','reconnect')) then
  perform app.refresh_song_groups((select epoch from app.account));
 end if;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('app_tag_action','app_playback_track','app_library_acknowledge','app_backup_prepare','app_backup_restore') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
revoke all on function public.app_backup_prepare_before_song_groups(bigint,uuid,uuid),public.app_backup_restore_before_song_groups(bigint,text,bigint,jsonb) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';

-- Source provenance and source counts describe logical songs across all aliases.
create or replace function app.track_dto(p_key text) returns jsonb language sql stable set search_path='' as $$
 select jsonb_set(app.track_dto_before_sources(app.song_representative(p_key)),'{metadata,addedAt}',to_jsonb(app.song_added_at(p_key)))||jsonb_build_object('sources',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'name',s.name) order by s.kind,s.id)
 from app.sources s where s.enabled and exists(select 1 from app.source_memberships sm
 where sm.epoch=s.epoch and sm.source_id=s.id and sm.track_key in (select track_key from app.song_group_members where group_key=app.song_group_key(p_key) union select p_key))),'[]'::jsonb));
$$;
alter function public.app_sources_list(bigint,text,integer,integer) rename to app_sources_list_before_song_groups;
create function public.app_sources_list(p_epoch bigint,p_search text default '',p_offset integer default 0,p_limit integer default 50) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb; rows jsonb;
 begin
  result:=public.app_sources_list_before_song_groups(p_epoch,p_search,p_offset,p_limit);
  select coalesce(jsonb_agg(item||jsonb_build_object('uniqueCount',(select count(distinct app.song_group_key(sm.track_key)) from app.source_memberships sm where sm.epoch=p_epoch and sm.source_id=item->>'id')) order by ord),'[]') into rows
   from jsonb_array_elements(result->'items') with ordinality v(item,ord);
  return result||jsonb_build_object('items',rows,'uniqueTrackCount',(select count(*) from app.filter_keys('{"membership":"active","untagged":false,"newOnly":false}'::jsonb)));
 end;
$$;
revoke all on function public.app_sources_list(bigint,text,integer,integer) from public,anon,authenticated;
grant execute on function public.app_sources_list(bigint,text,integer,integer) to service_role;
revoke all on function public.app_sources_list_before_song_groups(bigint,text,integer,integer) from public,anon,authenticated,service_role;
revoke all on app.song_groups,app.song_group_members,app.song_action_groups from public,anon,authenticated;
notify pgrst,'reload schema';

create or replace function public.app_tags_manage_preview(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare ids uuid[]; collision uuid; assignments bigint; active bigint; unions bigint; action text:=p_request->>'action'; normalized text;
 begin
  perform app.require_owner(p_epoch); perform app.require_revision(p_request->'expectedRevision');
  if action='merge' then
   perform public.app_tags_lookup(p_epoch,p_request->'sourceIds');
   perform public.app_tags_lookup(p_epoch,jsonb_build_array(p_request->>'targetId'));
   select array_agg(value::uuid) into ids from jsonb_array_elements_text((p_request->'sourceIds')||jsonb_build_array(p_request->>'targetId'));
   if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'invalid_input'; end if;
  elsif action in ('rename','delete') then
   perform public.app_tags_lookup(p_epoch,jsonb_build_array(p_request->>'tagId'));
   ids:=array[(p_request->>'tagId')::uuid];
   if action='rename' then
    normalized:=lower(normalize(btrim(regexp_replace(p_request->>'name','[[:space:]               　﻿]+',' ','g')),NFC));
    if normalized is null or length(normalized) not between 1 and 80 then raise exception 'invalid_input'; end if;
    select t.id into collision from app.tags t where t.epoch=p_epoch and t.deleted_at is null and t.normalized_name=normalized and t.id<>ids[1];
   end if;
  else raise exception 'invalid_input'; end if;
  select count(distinct (app.song_group_key(e.track_key),e.tag_id)),count(distinct app.song_group_key(e.track_key)) filter(where m.track_key is not null and m.removed_at is null),count(distinct app.song_group_key(e.track_key)) into assignments,active,unions
   from app.track_tags e left join app.track_metadata m using(track_key) where e.tag_id=any(ids) and e.present;
  return jsonb_build_object('revision',app.library_revision(),'assignmentCount',assignments,'activeTrackCount',active,'unionCount',unions,'collisionTag',case when collision is null then null else app.tag_dto(collision) end);
 end;
$$;

create or replace function public.app_library_search_before_artwork(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare rev jsonb; binding jsonb; off integer; lim integer; total bigint; groups_count bigint; rows jsonb;
  grouping text:=p_request->>'groupBy'; sorting text:=coalesce(p_request->>'sort','newest'); seed text:=p_request->>'seed';
 begin
  perform app.require_owner(p_epoch); rev:=app.library_revision();
  if sorting not in ('newest','oldest','title','artist','album','year','random') or (sorting='random')<>(seed is not null)
   or (grouping is not null and grouping not in ('artist','album','decade')) then raise exception 'invalid_input'; end if;
  binding:=jsonb_build_object('filter',p_request->'filter','groupBy',grouping,'sort',sorting,'seed',seed);
  lim:=(p_request->>'limit')::integer;
  if lim is null or lim not between 1 and 100 then raise exception 'invalid_input'; end if;
  off:=app.page_offset(p_epoch,'library',binding,p_request->>'cursor');
  select count(*) into total from app.filter_keys(p_request->'filter');
  if grouping is not null then
   with entries as (
    select m.track_key,ar->>'id' as value,ar->>'name' as name from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key)
    cross join lateral jsonb_array_elements(m.artists) ar where grouping='artist' and ar->>'id' is not null
     and (p_request->'filter'->>'artistId' is null or ar->>'id'=p_request->'filter'->>'artistId')
    union all select m.track_key,app.album_identity(m.album),case when app.normalized_label(m.album)='' then 'Album unavailable' else m.album end from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key) where grouping='album'
    union all select m.track_key,app.track_decade(m.release_date),app.track_decade(m.release_date) from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key) where grouping='decade'
   ), groups as (
    select value,min(name) as name,count(distinct track_key) as count,count(distinct track_key) filter(where exists(select 1 from app.track_tags t where t.track_key=entries.track_key and t.present)) as tagged from entries group by value
   ), page as (select * from groups order by count desc,value offset off limit lim)
   select (select count(*) from groups),coalesce(jsonb_agg(jsonb_build_object('value',value,'name',name,'trackCount',count,'taggedCount',tagged,
    'selection',jsonb_build_object('kind','filter','filter',(p_request->'filter')||jsonb_build_object(case grouping when 'artist' then 'artistId' when 'album' then 'album' else 'decade' end,case when grouping='decade' and value<>'unknown' then to_jsonb(value::integer) else to_jsonb(value) end),'expectedRevision',rev))
    ||case when grouping='artist' then jsonb_build_object('artistId',value) else '{}'::jsonb end order by count desc,value),'[]') into groups_count,rows from page;
   return jsonb_build_object('revision',rev,'totalTracks',total,'groupBy',grouping,'groups',rows,'totalGroups',groups_count,'nextCursor',app.next_cursor(p_epoch,'library',binding,off+lim,groups_count));
  end if;
  with ordered as (
   select k.track_key,row_number() over(order by
    case when sorting='oldest' then k.liked_at end asc,
    case when sorting='newest' then k.liked_at end desc,
    case sorting when 'title' then lower(normalize(m.title,NFC)) when 'album' then app.normalized_label(m.album) when 'artist' then lower(normalize(m.artists->0->>'name',NFC)) when 'year' then m.release_date when 'random' then md5(seed||m.track_key) end asc nulls last,k.track_key) as ord
    from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key)
  ), page as(select * from ordered order by ord offset off limit lim)
  select coalesce(jsonb_agg(app.track_dto(track_key) order by ord),'[]') into rows from page;
  return jsonb_build_object('revision',rev,'totalTracks',total,'groupBy',null,'tracks',rows,'nextCursor',app.next_cursor(p_epoch,'library',binding,off+lim,total));
 end;
$$;

revoke all on function public.app_library_search_before_artwork(bigint,jsonb) from public,anon,authenticated,service_role;
-- Vocabulary actions keep component membership snapshots too. A newly arriving
-- alias is a later edit: undo may restore the vocabulary identity while skipping
-- that complete song's assignments instead of restoring only its older aliases.
alter function public.app_tags_manage(bigint,text,jsonb) rename to app_tags_manage_before_song_groups;
create function public.app_tags_manage(p_epoch bigint,p_session_hash text,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb; aid uuid;
 begin
  result:=public.app_tags_manage_before_song_groups(p_epoch,p_session_hash,p_request);
  aid:=(result->>'actionId')::uuid;
  if aid is not null then
   insert into app.song_action_groups(action_id,group_key,member_keys)
    select aid,groups.group_key,array_agg(a.track_key order by a.track_key) from (
     select distinct app.song_group_key(e.track_key) group_key from app.tag_action_edges e where e.action_id=aid
     union select distinct app.song_group_key(edge->>'key') from app.vocabulary_changes v
      cross join lateral jsonb_array_elements(v.edges) edge where v.action_id=aid
    ) groups cross join lateral (
     select sm.track_key from app.song_group_members sm where sm.group_key=groups.group_key
     union select groups.group_key where not exists(select 1 from app.song_group_members where track_key=groups.group_key)
    ) a group by groups.group_key;
  end if;
  return result;
 end;
$$;
alter function public.app_tag_undo(bigint,text,uuid) rename to app_tag_undo_before_song_groups;
create function public.app_tag_undo(p_epoch bigint,p_session_hash text,p_action_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare action app.tag_actions; conflicts text[]; result jsonb; filtered jsonb;
 begin
  perform app.require_owner(p_epoch);
  if not exists(select 1 from app.sessions where token_hash=p_session_hash and epoch=p_epoch and expires_at>now()) then raise exception 'inactive_epoch'; end if;
  select * into action from app.tag_actions where id=p_action_id and epoch=p_epoch and session_hash=p_session_hash for update;
  if not found then raise exception 'unknown_action'; end if;
  if action.undone_at is not null or not (exists(select 1 from app.vocabulary_deletes where action_id=p_action_id)
   or exists(select 1 from app.vocabulary_changes where action_id=p_action_id)) then
   return public.app_tag_undo_before_song_groups(p_epoch,p_session_hash,p_action_id);
  end if;
  select coalesce(array_agg(distinct app.song_group_key(g.member_keys[1])),'{}'::text[]) into conflicts
   from app.song_action_groups g where g.action_id=p_action_id and g.member_keys is distinct from
    (select array_agg(sm.track_key order by sm.track_key) from app.song_group_members sm
     where sm.group_key=app.song_group_key(g.member_keys[1]));
  -- Pre-migration vocabulary undo has no component snapshot. Keep its original
  -- behavior for singletons and conservatively skip newly grouped assignments.
  if not exists(select 1 from app.song_action_groups where action_id=p_action_id) then
   select coalesce(array_agg(distinct group_key),'{}'::text[]) into conflicts from (
    select app.song_group_key(e.track_key) group_key from app.tag_action_edges e where e.action_id=p_action_id
    union select app.song_group_key(edge->>'key') from app.vocabulary_changes v
     cross join lateral jsonb_array_elements(v.edges) edge where v.action_id=p_action_id
   ) affected where (select count(*) from app.annotations a where a.epoch=p_epoch and app.song_group_key(a.track_key)=affected.group_key)>1;
  end if;
  if cardinality(conflicts)>0 then
   -- These journals are session-scoped and terminal after undo. Removing skipped
   -- edges fences the underlying changed-only version checks for complete songs.
   delete from app.tag_action_edges where action_id=p_action_id and app.song_group_key(track_key)=any(conflicts);
   select coalesce(jsonb_agg(edge),'[]') into filtered from app.vocabulary_changes v
    cross join lateral jsonb_array_elements(v.edges) edge where v.action_id=p_action_id
     and not app.song_group_key(edge->>'key')=any(conflicts);
   update app.vocabulary_changes set edges=filtered where action_id=p_action_id;
  end if;
  result:=public.app_tag_undo_before_song_groups(p_epoch,p_session_hash,p_action_id);
  return result||jsonb_build_object('skippedCount',(result->>'skippedCount')::integer+cardinality(conflicts));
 end;
$$;
revoke all on function public.app_tags_manage(bigint,text,jsonb),public.app_tag_undo(bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.app_tags_manage(bigint,text,jsonb),public.app_tag_undo(bigint,text,uuid) to service_role;
revoke all on function public.app_tags_manage_before_song_groups(bigint,text,jsonb),public.app_tag_undo_before_song_groups(bigint,text,uuid) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
