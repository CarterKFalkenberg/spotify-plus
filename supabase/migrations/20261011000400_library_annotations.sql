-- Library state, retained annotations, transactional tagging and cached query evaluation.
-- Every public RPC is service-role only; the API supplies the authenticated epoch.
create table app.library_state (
 singleton boolean primary key default true check(singleton),
 epoch bigint not null,
 library_revision bigint not null default 0,
 annotation_revision bigint not null default 0,
 encrypted_annotation_key text,
 initial_sync_complete boolean not null default false,
 last_completed_at timestamptz,
 last_probe_at timestamptz,
 head_signature jsonb,
 latest_run_id uuid
);
create table app.annotations (
 track_key text primary key check(track_key ~ '^[0-9a-f]{64}$'),
 epoch bigint not null
);
create table app.track_metadata (
 track_key text primary key references app.annotations(track_key),
 spotify_id text not null unique check(spotify_id ~ '^[A-Za-z0-9]{22}$'),
 title text not null,
 artists jsonb not null check(jsonb_typeof(artists)='array'),
 album text not null,
 release_date text,
 duration_ms bigint check(duration_ms>=0),
 explicit boolean,
 artwork_url text,
 spotify_url text,
 playable_uri text check(playable_uri ~ '^spotify:track:[A-Za-z0-9]{22}$'),
 liked_at timestamptz not null,
 removed_at timestamptz,
 acknowledged_at timestamptz,
 added_run_id uuid not null
);
create index metadata_liked on app.track_metadata(liked_at desc,track_key) where removed_at is null;
create table app.tags (
 id uuid primary key default gen_random_uuid(),
 epoch bigint not null,
 name text not null check(length(name) between 1 and 80),
 normalized_name text not null,
 last_used_at timestamptz,
 unique(epoch,normalized_name)
);
-- Tombstones make changed-only undo detect later removal/re-add edits.
create table app.track_tags (
 track_key text not null references app.annotations(track_key),
 tag_id uuid not null references app.tags(id),
 present boolean not null,
 version bigint not null default 1,
 primary key(track_key,tag_id)
);
create index track_tags_present on app.track_tags(tag_id,track_key) where present;
create table app.tag_actions (
 id uuid primary key default gen_random_uuid(),
 epoch bigint not null,
 session_hash text not null,
 tag_id uuid not null references app.tags(id),
 created_at timestamptz not null default now(),
 undone_at timestamptz
);
create table app.tag_action_edges (
 action_id uuid not null references app.tag_actions(id) on delete cascade,
 track_key text not null references app.annotations(track_key),
 before_present boolean not null,
 after_version bigint not null,
 primary key(action_id,track_key)
);
create table app.page_cursors (
 token text primary key,
 epoch bigint not null,
 route text not null,
 binding jsonb not null,
 revision jsonb not null,
 row_offset integer not null check(row_offset>=0),
 expires_at timestamptz not null default now()+interval '30 minutes'
);
create table app.sync_runs (
 id uuid primary key default gen_random_uuid(),
 epoch bigint not null,
 job_id uuid not null unique,
 pass integer not null default 1,
 next_offset integer not null default 0,
 reported_total integer,
 received_count integer not null default 0,
 invalid_pass boolean not null default false,
 prior_valid_pass integer,
 first_head jsonb,
 completed_at timestamptz,
 created_at timestamptz not null default now()
);
create table app.sync_seen (
 run_id uuid not null references app.sync_runs(id) on delete cascade,
 pass integer not null,
 track_key text not null,
 liked_at timestamptz not null,
 primary key(run_id,pass,track_key)
);

-- Shared with playlist transactions. Lock order is account, library_state, then domain rows.
-- Cached browsing/tag editing stay available to a valid reconnect session.
create function app.require_owner(p_epoch bigint,p_connected boolean default false) returns void
 language plpgsql set search_path='' as $$
 begin
  perform 1 from app.account where singleton and epoch=p_epoch
   and (state='connected' or (not p_connected and state='reconnect')) for share;
  if not found then raise exception 'inactive_epoch'; end if;
  perform 1 from app.library_state where singleton and epoch=p_epoch for update;
  if not found then raise exception 'inactive_epoch'; end if;
 end;
$$;
create function app.library_revision() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('library',library_revision::text,'annotations',annotation_revision::text)
 from app.library_state where singleton;
$$;
create function app.require_revision(p_revision jsonb) returns void language plpgsql set search_path='' as $$
 begin
  if p_revision is distinct from app.library_revision() then raise exception 'stale_revision'; end if;
 end;
$$;
create function app.track_dto(p_key text) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('trackKey',a.track_key,'tagIds',coalesce((select jsonb_agg(t.tag_id order by t.tag_id)
  from app.track_tags t where t.track_key=a.track_key and t.present),'[]'::jsonb),
  'metadata',case when m.track_key is null then null else jsonb_build_object(
   'title',m.title,'artists',m.artists,'album',m.album,'releaseDate',m.release_date,'durationMs',m.duration_ms,
   'explicit',m.explicit,'artworkUrl',m.artwork_url,'spotifyUrl',m.spotify_url,'playableUri',m.playable_uri,
   'likedAt',m.liked_at,'removedAt',m.removed_at,'acknowledgedAt',m.acknowledged_at) end)
 from app.annotations a left join app.track_metadata m using(track_key) where a.track_key=p_key;
$$;
create function app.tag_dto(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',t.id,'name',t.name,'lastUsedAt',t.last_used_at,
  'activeTrackCount',(select count(*) from app.track_tags e join app.track_metadata m using(track_key)
   where e.tag_id=t.id and e.present and m.removed_at is null)) from app.tags t where t.id=p_id;
$$;
create function app.filter_keys(p_filter jsonb) returns table(track_key text,liked_at timestamptz)
 language sql stable set search_path='' as $$
 select m.track_key,m.liked_at from app.track_metadata m join app.annotations a using(track_key)
 where a.epoch=(select epoch from app.library_state where singleton)
 and ((p_filter->>'membership'='active' and m.removed_at is null) or (p_filter->>'membership'='removed' and m.removed_at is not null))
 and (not (p_filter->>'untagged')::boolean or not exists(select 1 from app.track_tags t where t.track_key=m.track_key and t.present))
 and (not (p_filter->>'newOnly')::boolean or (m.removed_at is null and m.acknowledged_at is null))
 and (p_filter->>'artistId' is null or exists(select 1 from jsonb_array_elements(m.artists) ar where ar->>'id'=p_filter->>'artistId'))
 and (coalesce(p_filter->>'search','')='' or position(lower(normalize(p_filter->>'search',NFC)) in
  lower(normalize(m.title||' '||m.album||' '||coalesce((select string_agg(ar->>'name',' ') from jsonb_array_elements(m.artists) ar),''),NFC)))>0)
 order by m.liked_at desc,m.track_key;
$$;
-- Validate every branch before matching: an unknown leaf under NOT/short circuit is an error.
create function app.validate_query(p_query jsonb) returns void language plpgsql set search_path='' as $$
 declare item record; count_nodes integer:=0; n jsonb; op text;
 begin
  if jsonb_typeof(p_query) is distinct from 'object' or p_query->'version' is distinct from '1'::jsonb
   or (select count(*) from jsonb_object_keys(p_query))<>2 then raise exception 'invalid_input'; end if;
  for item in with recursive nodes(node,depth) as (
   select p_query->'root',1
   union all
   select c.child,nodes.depth+1 from nodes cross join lateral (
    select value as child from jsonb_array_elements(case when jsonb_typeof(nodes.node->'children')='array' then nodes.node->'children' else '[]'::jsonb end)
    union all select nodes.node->'child' where nodes.node->>'op'='not'
   ) c where nodes.depth<=12
  ) select * from nodes loop
   count_nodes:=count_nodes+1; n:=item.node; op:=n->>'op';
   if count_nodes>128 or item.depth>12 or jsonb_typeof(n) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(n))<>2 then raise exception 'invalid_input'; end if;
   if op='tag' then
    if not coalesce(n->>'tagId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false) then raise exception 'invalid_input'; end if;
    if not exists(select 1 from app.tags where id=(n->>'tagId')::uuid and epoch=(select epoch from app.library_state where singleton)) then raise exception 'unknown_tag'; end if;
   elsif op in ('and','or') then
    if jsonb_typeof(n->'children') is distinct from 'array' or jsonb_array_length(n->'children')=0 then raise exception 'invalid_input'; end if;
   elsif op='not' then
    if not n ? 'child' then raise exception 'invalid_input'; end if;
   else raise exception 'invalid_input'; end if;
  end loop;
 end;
$$;
create function app.query_matches(p_node jsonb,p_key text) returns boolean language plpgsql stable set search_path='' as $$
 declare result boolean; child jsonb;
 begin
  case p_node->>'op'
   when 'tag' then return exists(select 1 from app.track_tags where track_key=p_key and tag_id=(p_node->>'tagId')::uuid and present);
   when 'not' then return not app.query_matches(p_node->'child',p_key);
   when 'and' then
    result:=true;
    for child in select value from jsonb_array_elements(p_node->'children') loop result:=result and app.query_matches(child,p_key); end loop;
    return result;
   when 'or' then
    result:=false;
    for child in select value from jsonb_array_elements(p_node->'children') loop result:=result or app.query_matches(child,p_key); end loop;
    return result;
   else raise exception 'invalid_input';
  end case;
 end;
$$;
-- Includes unavailable matches (playable_uri null) for preview. Writes must filter them.
create function app.query_targets(p_query jsonb)
 returns table(track_key text,playable_uri text,liked_at timestamptz,duration_ms bigint)
 language plpgsql stable set search_path='' as $$
 begin
  perform app.validate_query(p_query);
  return query select m.track_key,m.playable_uri,m.liked_at,m.duration_ms
   from app.track_metadata m join app.annotations a using(track_key)
   where a.epoch=(select epoch from app.library_state where singleton) and m.removed_at is null
    and app.query_matches(p_query->'root',m.track_key)
   order by m.liked_at desc,m.track_key;
 end;
$$;
create function app.page_offset(p_epoch bigint,p_route text,p_binding jsonb,p_cursor text) returns integer
 language plpgsql set search_path='' as $$
 declare offset_value integer;
 begin
  if p_cursor is null then return 0; end if;
  select row_offset into offset_value from app.page_cursors where token=p_cursor and epoch=p_epoch
   and route=p_route and binding=p_binding and revision=app.library_revision() and expires_at>now();
  if not found then raise exception 'stale_revision'; end if;
  return offset_value;
 end;
$$;
create function app.next_cursor(p_epoch bigint,p_route text,p_binding jsonb,p_offset integer,p_total bigint) returns text
 language plpgsql set search_path='' as $$
 declare token_value text;
 begin
  if p_offset>=p_total then return null; end if;
  delete from app.page_cursors where expires_at<=now();
  token_value:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  insert into app.page_cursors(token,epoch,route,binding,revision,row_offset)
   values(token_value,p_epoch,p_route,p_binding,app.library_revision(),p_offset);
  return token_value;
 end;
$$;
create function public.app_library_search(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare rev jsonb; binding jsonb; offset_value integer; limit_value integer; total bigint; groups_count bigint; rows jsonb;
 begin
  perform app.require_owner(p_epoch);
  rev:=app.library_revision(); binding:=jsonb_build_object('filter',p_request->'filter','groupBy',p_request->'groupBy');
  limit_value:=(p_request->>'limit')::integer;
  if limit_value is null or limit_value not between 1 and 100 then raise exception 'invalid_input'; end if;
  offset_value:=app.page_offset(p_epoch,'library',binding,p_request->>'cursor');
  select count(*) into total from app.filter_keys(p_request->'filter');
  if p_request->>'groupBy'='artist' then
   with groups as (
    select ar->>'id' as id,min(ar->>'name') as name,count(distinct m.track_key) as count,
     count(distinct m.track_key) filter(where exists(select 1 from app.track_tags t where t.track_key=m.track_key and t.present)) as tagged
    from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key)
     cross join lateral jsonb_array_elements(m.artists) ar
    where ar->>'id' is not null and (p_request->'filter'->>'artistId' is null or ar->>'id'=p_request->'filter'->>'artistId') group by ar->>'id'
   ), page as (select * from groups order by count desc,id offset offset_value limit limit_value)
   select (select count(*) from groups),coalesce(jsonb_agg(jsonb_build_object('artistId',id,'name',name,'trackCount',count,'taggedCount',tagged,
    'selection',jsonb_build_object('kind','filter','filter',(p_request->'filter')||jsonb_build_object('artistId',id),'expectedRevision',rev)) order by count desc,id),'[]'::jsonb)
    into groups_count,rows from page;
   return jsonb_build_object('revision',rev,'totalTracks',total,'groupBy','artist','groups',rows,'totalGroups',groups_count,
    'nextCursor',app.next_cursor(p_epoch,'library',binding,offset_value+limit_value,groups_count));
  end if;
  select coalesce(jsonb_agg(app.track_dto(track_key) order by liked_at desc,track_key),'[]'::jsonb) into rows
   from (select * from app.filter_keys(p_request->'filter') offset offset_value limit limit_value) page;
  return jsonb_build_object('revision',rev,'totalTracks',total,'groupBy',null,'tracks',rows,
   'nextCursor',app.next_cursor(p_epoch,'library',binding,offset_value+limit_value,total));
 end;
$$;
create function public.app_query_preview(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare binding jsonb:=p_request->'query'; offset_value integer; limit_value integer; total bigint; playable bigint; duration bigint; rows jsonb;
 begin
  perform app.require_owner(p_epoch);
  perform app.validate_query(binding);
  limit_value:=(p_request->>'limit')::integer;
  if limit_value is null or limit_value not between 1 and 100 then raise exception 'invalid_input'; end if;
  offset_value:=app.page_offset(p_epoch,'preview',binding,p_request->>'cursor');
  select count(*),count(playable_uri),coalesce(sum(duration_ms) filter(where playable_uri is not null),0) into total,playable,duration from app.query_targets(binding);
  select coalesce(jsonb_agg(app.track_dto(track_key) order by liked_at desc,track_key),'[]'::jsonb) into rows
   from (select * from app.query_targets(binding) offset offset_value limit limit_value) page;
  return jsonb_build_object('query',binding,'revision',app.library_revision(),'generationReady',(select initial_sync_complete from app.library_state where singleton),
   'matchedCount',total,'playableCount',playable,'excludedCount',total-playable,'durationMs',duration,'tracks',rows,
   'nextCursor',app.next_cursor(p_epoch,'preview',binding,offset_value+limit_value,total));
 end;
$$;
create function public.app_tags_search(p_epoch bigint,p_search text default '',p_limit integer default 20) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare rows jsonb; total bigint;
 begin
  perform app.require_owner(p_epoch);
  if p_limit is null or p_limit not between 1 and 100 or p_search is null or length(p_search)>200 then raise exception 'invalid_input'; end if;
  select count(*) into total from app.tags where epoch=p_epoch and position(lower(normalize(p_search,NFC)) in normalized_name)>0;
  select coalesce(jsonb_agg(dto order by exact desc,usage desc,normalized_name,id),'[]'::jsonb) into rows from (
   select t.id,t.normalized_name,app.tag_dto(t.id) as dto,t.normalized_name=lower(normalize(p_search,NFC)) as exact,
    (select count(*) from app.track_tags e join app.track_metadata m using(track_key) where e.tag_id=t.id and e.present and m.removed_at is null) as usage
   from app.tags t where t.epoch=p_epoch and position(lower(normalize(p_search,NFC)) in t.normalized_name)>0
   order by exact desc,usage desc,t.normalized_name,t.id limit p_limit) page;
  return jsonb_build_object('tags',rows,'hasMore',total>p_limit,'revision',app.library_revision());
 end;
$$;
create function public.app_tag_create(p_epoch bigint,p_name text) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare tag_id uuid; created boolean:=false; normalized text;
 begin
  perform app.require_owner(p_epoch);
  p_name:=normalize(regexp_replace(btrim(p_name),'[[:space:]]+',' ','g'),NFC);
  if p_name is null or length(p_name) not between 1 and 80 then raise exception 'invalid_input'; end if;
  normalized:=lower(p_name);
  insert into app.tags(epoch,name,normalized_name) values(p_epoch,p_name,normalized) on conflict(epoch,normalized_name) do nothing returning id into tag_id;
  if found then
   created:=true; update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch;
  else select id into tag_id from app.tags where epoch=p_epoch and normalized_name=normalized; end if;
  return jsonb_build_object('tag',app.tag_dto(tag_id),'created',created,'revision',app.library_revision());
 end;
$$;
create function app.selection_keys(p_epoch bigint,p_selection jsonb) returns text[] language plpgsql set search_path='' as $$
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
  return keys;
 end;
$$;
create function public.app_tag_action(p_epoch bigint,p_session_hash text,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare keys text[]; v_tag_id uuid:=(p_request->>'tagId')::uuid; desired boolean; action_id uuid; changed integer:=0; key text; old_edge app.track_tags; next_version bigint;
 begin
  perform app.require_owner(p_epoch);
  if not exists(select 1 from app.sessions where token_hash=p_session_hash and epoch=p_epoch and expires_at>now()) then raise exception 'inactive_epoch'; end if;
  if not exists(select 1 from app.tags where id=v_tag_id and epoch=p_epoch) then raise exception 'unknown_tag'; end if;
  if p_request->>'action' not in ('add','remove') then raise exception 'invalid_input'; end if;
  desired:=p_request->>'action'='add'; keys:=app.selection_keys(p_epoch,p_request->'selection');
  insert into app.tag_actions(epoch,session_hash,tag_id) values(p_epoch,p_session_hash,v_tag_id) returning id into action_id;
  foreach key in array keys loop
   select * into old_edge from app.track_tags where track_key=key and app.track_tags.tag_id=v_tag_id;
   if coalesce(old_edge.present,false)=desired then continue; end if;
   next_version:=coalesce(old_edge.version,0)+1;
   insert into app.track_tags(track_key,tag_id,present,version) values(key,v_tag_id,desired,next_version)
    on conflict(track_key,tag_id) do update set present=excluded.present,version=excluded.version;
   insert into app.tag_action_edges values(action_id,key,coalesce(old_edge.present,false),next_version);
   changed:=changed+1;
  end loop;
  if changed>0 then
   update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch;
   if desired then update app.tags set last_used_at=now() where id=v_tag_id and epoch=p_epoch; end if;
  end if;
  return jsonb_build_object('actionId',action_id,'selectedCount',cardinality(keys),'changedCount',changed,'revision',app.library_revision());
 end;
$$;
create function public.app_tag_undo(p_epoch bigint,p_session_hash text,p_action_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare action app.tag_actions; restored integer; total integer;
 begin
  perform app.require_owner(p_epoch);
  select * into action from app.tag_actions where id=p_action_id and epoch=p_epoch and session_hash=p_session_hash and created_at>now()-interval '24 hours' for update;
  if not found then raise exception 'unknown_action'; end if;
  if action.undone_at is not null then return jsonb_build_object('actionId',p_action_id,'restoredCount',0,'skippedCount',0,'revision',app.library_revision()); end if;
  select count(*) into total from app.tag_action_edges where action_id=p_action_id;
  update app.track_tags t set present=e.before_present,version=t.version+1 from app.tag_action_edges e
   where e.action_id=p_action_id and t.track_key=e.track_key and t.tag_id=action.tag_id and t.version=e.after_version;
  get diagnostics restored=row_count;
  update app.tag_actions set undone_at=now() where id=p_action_id and epoch=p_epoch;
  if restored>0 then update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch; end if;
  return jsonb_build_object('actionId',p_action_id,'restoredCount',restored,'skippedCount',total-restored,'revision',app.library_revision());
 end;
$$;
create function public.app_library_acknowledge(p_epoch bigint,p_track_keys jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare keys text[]; changed integer;
 begin
  perform app.require_owner(p_epoch);
  keys:=app.selection_keys(p_epoch,jsonb_build_object('kind','tracks','trackKeys',p_track_keys));
  update app.track_metadata set acknowledged_at=now() where track_key=any(keys) and removed_at is null and acknowledged_at is null;
  get diagnostics changed=row_count;
  if changed>0 then update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch; end if;
  return jsonb_build_object('changedCount',changed,'revision',app.library_revision());
 end;
$$;

create function app.library_status() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('revision',app.library_revision(),'initialSyncComplete',s.initial_sync_complete,
  'syncPhase',case when r.id is null or r.completed_at is not null then 'idle' when r.pass=1 then 'importing' else 'verifying' end,
  'importedCount',case when r.id is null or r.completed_at is not null then (select count(*) from app.track_metadata where removed_at is null)
   else (select count(*) from app.sync_seen where run_id=r.id and pass=r.pass) end,
  'reportedTotal',r.reported_total,'activeCount',(select count(*) from app.track_metadata where removed_at is null),
  'untaggedCount',(select count(*) from app.track_metadata m where m.removed_at is null and not exists(select 1 from app.track_tags t where t.track_key=m.track_key and t.present)),
  'newCount',(select count(*) from app.track_metadata where removed_at is null and acknowledged_at is null),
  'lastCompletedAt',s.last_completed_at,'blockedBy',case when a.state='reconnect' then 'reconnect'
   when p.cooldown_until>now() then case when p.cooldown_kind='quota' then 'quota' else 'rateLimited' end
   when j.last_error is not null then 'unavailable' else null end)
 from app.library_state s join app.account a on a.epoch=s.epoch cross join app.spotify_pacing p
 left join app.sync_runs r on r.id=s.latest_run_id left join app.jobs j on j.id=r.job_id where s.singleton;
$$;
create function public.app_library_status(p_epoch bigint) returns jsonb language plpgsql security definer set search_path='' as $$
 begin perform app.require_owner(p_epoch); return app.library_status(); end;
$$;
create function app.start_library_walk(p_epoch bigint) returns uuid language plpgsql set search_path='' as $$
 declare job_id uuid; run_id uuid;
 begin
  select id into job_id from app.jobs where epoch=p_epoch and kind='library_sync' and state in ('queued','running','parked') order by created_at limit 1;
  if found then return job_id; end if;
  insert into app.jobs(kind,epoch,priority) values('library_sync',p_epoch,10) returning id into job_id;
  insert into app.sync_runs(epoch,job_id) values(p_epoch,job_id) returning id into run_id;
  update app.library_state set latest_run_id=run_id where singleton and epoch=p_epoch;
  return job_id;
 end;
$$;
create function app.library_connected() returns trigger language plpgsql set search_path='' as $$
 begin
  if new.state='connected' then
   insert into app.library_state(singleton,epoch) values(true,new.epoch) on conflict(singleton) do nothing;
   if not exists(select 1 from app.library_state where singleton and epoch=new.epoch) then raise exception 'inactive_epoch'; end if;
   if not (select initial_sync_complete from app.library_state where singleton) then perform app.start_library_walk(new.epoch); end if;
  end if;
  return new;
 end;
$$;
create trigger library_connected after update of state on app.account for each row execute function app.library_connected();
-- Upgrade an already-connected foundation without requiring another Spotify consent.
insert into app.library_state(singleton,epoch) select true,epoch from app.account where singleton and state in ('connected','reconnect');
do $$ declare a app.account; begin
 select * into a from app.account where singleton;
 if a.state='connected' then perform app.start_library_walk(a.epoch); end if;
end $$;
create function public.app_library_sync(p_epoch bigint,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
 begin
  perform app.require_owner(p_epoch);
  if p_reason not in ('app-open','manual') then raise exception 'invalid_input'; end if;
  if not exists(select 1 from app.account where singleton and epoch=p_epoch and state='connected') then return app.library_status(); end if;
  if p_reason='manual' then perform app.start_library_walk(p_epoch);
  elsif exists(select 1 from app.library_state where singleton and epoch=p_epoch and (last_probe_at is null or last_probe_at<=now()-interval '15 minutes')) then
   update app.library_state set last_probe_at=now() where singleton and epoch=p_epoch;
   if not exists(select 1 from app.jobs where epoch=p_epoch and kind in ('library_sync','library_probe') and state in ('queued','running','parked')) then
    insert into app.jobs(kind,epoch) values('library_probe',p_epoch);
   end if;
  end if;
  return app.library_status();
 end;
$$;
-- A worker claim never creates annotation identities without its current lease/owner fence.
create function public.app_library_job_state(p_epoch bigint,p_id uuid,p_lease uuid,p_encrypted_key text) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare j app.jobs; r app.sync_runs;
 begin
  perform app.require_owner(p_epoch,true);
  select * into j from app.jobs where id=p_id and epoch=p_epoch and kind in ('library_sync','library_probe')
   and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return null; end if;
  if p_encrypted_key is null or length(p_encrypted_key)>1024 then raise exception 'invalid_input'; end if;
  update app.library_state set encrypted_annotation_key=coalesce(encrypted_annotation_key,p_encrypted_key) where singleton and epoch=p_epoch;
  if j.kind='library_sync' then
   select * into r from app.sync_runs where job_id=j.id and epoch=p_epoch;
   if not found then return null; end if;
  end if;
  return jsonb_build_object('encryptedKey',(select encrypted_annotation_key from app.library_state where singleton),
   'offset',coalesce(r.next_offset,0),'pass',coalesce(r.pass,0),'runId',r.id,'completed',r.completed_at is not null);
 end;
$$;
create function public.app_library_probe_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_head jsonb,p_complete boolean) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  perform app.require_owner(p_epoch,true);
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='library_probe' and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return false; end if;
  -- A matching head/total is only a hint. The daily verified walk always remains due.
  if not p_complete or p_head is distinct from (select head_signature from app.library_state where singleton) then perform app.start_library_walk(p_epoch); end if;
  return true;
 end;
$$;
create function public.app_library_page_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_pass integer,p_offset integer,
 p_total integer,p_received integer,p_next_offset integer,p_rows jsonb,p_unresolved integer,p_head jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare r app.sync_runs; row jsonb; key text; liked timestamptz; observed integer; valid boolean; same boolean; changed boolean:=false; affected integer;
 begin
  perform app.require_owner(p_epoch,true);
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='library_sync' and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return null; end if;
  select * into r from app.sync_runs where job_id=p_id and epoch=p_epoch for update;
  if not found or r.completed_at is not null or r.pass<>p_pass or r.next_offset<>p_offset then return null; end if;
  if p_total is null or p_total<0 or p_received is null or p_received not between 0 and 50 or p_unresolved is null or p_unresolved<0
   or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)+p_unresolved<>p_received
   or (p_next_offset is not null and (p_next_offset<>p_offset+p_received or p_received=0)) then raise exception 'invalid_input'; end if;
  r.invalid_pass:=r.invalid_pass or p_unresolved>0 or (r.reported_total is not null and r.reported_total<>p_total);
  r.reported_total:=coalesce(r.reported_total,p_total);
  foreach key in array array(select value->>'trackKey' from jsonb_array_elements(p_rows)) loop
   if key is null or key !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input'; end if;
  end loop;
  for row in select value from jsonb_array_elements(p_rows) loop
   key:=row->>'trackKey'; liked:=(row->>'likedAt')::timestamptz;
   if liked is null or row->>'spotifyId' is null then raise exception 'invalid_input'; end if;
   insert into app.sync_seen values(r.id,r.pass,key,liked) on conflict(run_id,pass,track_key) do nothing;
   if not found then r.invalid_pass:=true; end if;
   insert into app.annotations(track_key,epoch) values(key,p_epoch) on conflict(track_key) do nothing;
   if not exists(select 1 from app.annotations where track_key=key and epoch=p_epoch) then raise exception 'unknown_track'; end if;
   insert into app.track_metadata(track_key,spotify_id,title,artists,album,release_date,duration_ms,explicit,artwork_url,spotify_url,playable_uri,liked_at,added_run_id)
    values(key,row->>'spotifyId',row->>'title',row->'artists',row->>'album',row->>'releaseDate',(row->>'durationMs')::bigint,
     (row->>'explicit')::boolean,row->>'artworkUrl',row->>'spotifyUrl',row->>'playableUri',liked,r.id)
    on conflict(track_key) do update set spotify_id=excluded.spotify_id,title=excluded.title,artists=excluded.artists,album=excluded.album,
     release_date=excluded.release_date,duration_ms=excluded.duration_ms,explicit=excluded.explicit,artwork_url=excluded.artwork_url,spotify_url=excluded.spotify_url,
     playable_uri=excluded.playable_uri,liked_at=excluded.liked_at,removed_at=null,
     acknowledged_at=case when app.track_metadata.removed_at is not null or app.track_metadata.liked_at<>excluded.liked_at then null else app.track_metadata.acknowledged_at end,
     added_run_id=case when app.track_metadata.removed_at is not null or app.track_metadata.liked_at<>excluded.liked_at then r.id else app.track_metadata.added_run_id end
    where (app.track_metadata.spotify_id,app.track_metadata.title,app.track_metadata.artists,app.track_metadata.album,app.track_metadata.release_date,
     app.track_metadata.duration_ms,app.track_metadata.explicit,app.track_metadata.artwork_url,app.track_metadata.spotify_url,app.track_metadata.playable_uri,app.track_metadata.liked_at,app.track_metadata.removed_at)
     is distinct from (excluded.spotify_id,excluded.title,excluded.artists,excluded.album,excluded.release_date,excluded.duration_ms,excluded.explicit,excluded.artwork_url,excluded.spotify_url,excluded.playable_uri,excluded.liked_at,null::timestamptz);
   changed:=changed or found;
  end loop;
  update app.sync_runs set reported_total=r.reported_total,received_count=received_count+p_received,invalid_pass=r.invalid_pass,
   next_offset=coalesce(p_next_offset,p_offset+p_received),first_head=case when p_offset=0 then p_head else first_head end
   where id=r.id returning * into r;
  if changed then update app.library_state set library_revision=library_revision+1 where singleton and epoch=p_epoch; end if;
  if p_next_offset is not null then return jsonb_build_object('done',false,'retryMs',0); end if;
  select count(*) into observed from app.sync_seen where run_id=r.id and pass=r.pass;
  valid:=not r.invalid_pass and r.received_count=r.reported_total and observed=r.reported_total;
  same:=valid and r.prior_valid_pass=r.pass-1 and not exists(
   (select track_key,liked_at from app.sync_seen where run_id=r.id and pass=r.pass
    except select track_key,liked_at from app.sync_seen where run_id=r.id and pass=r.prior_valid_pass)
   union all
   (select track_key,liked_at from app.sync_seen where run_id=r.id and pass=r.prior_valid_pass
    except select track_key,liked_at from app.sync_seen where run_id=r.id and pass=r.pass)
  );
  if same then
   update app.track_metadata m set removed_at=now() where m.removed_at is null and not exists(select 1 from app.sync_seen where run_id=r.id and pass=r.pass and track_key=m.track_key);
   get diagnostics affected=row_count;
   update app.library_state set initial_sync_complete=true,last_completed_at=now(),head_signature=r.first_head,
    library_revision=library_revision+case when affected>0 or not initial_sync_complete then 1 else 0 end where singleton and epoch=p_epoch;
   update app.sync_runs set completed_at=now() where id=r.id;
   delete from app.sync_seen where run_id=r.id;
   return jsonb_build_object('done',true,'retryMs',0);
  end if;
  update app.sync_runs set pass=pass+1,next_offset=0,reported_total=null,received_count=0,invalid_pass=false,
   prior_valid_pass=case when valid then r.pass else null end,first_head=null where id=r.id;
  delete from app.sync_seen where run_id=r.id and (pass<r.pass or not valid);
  return jsonb_build_object('done',false,'retryMs',case when not valid or r.pass%4=0 then 60000 else 0 end);
 end;
$$;
-- Called from the useful scheduler maintenance job; cron invokes that job even with a closed browser.
create function app.library_maintenance() returns void language plpgsql set search_path='' as $$
 declare a app.account; deleted integer;
 begin
  select * into a from app.account where singleton for share;
  if a.state not in ('connected','reconnect') then return; end if;
  perform 1 from app.library_state where singleton and epoch=a.epoch for update;
  if not found then return; end if;
  delete from app.track_metadata where removed_at<=now()-interval '90 days';
  get diagnostics deleted=row_count;
  if deleted>0 then update app.library_state set library_revision=library_revision+1 where singleton and epoch=a.epoch; end if;
  delete from app.page_cursors where expires_at<=now();
  delete from app.tag_actions where epoch=a.epoch and created_at<=now()-interval '24 hours';
  delete from app.sync_runs where epoch=a.epoch and completed_at<now()-interval '7 days' and id is distinct from (select latest_run_id from app.library_state where singleton);
  if a.state='connected' and exists(select 1 from app.library_state where singleton and (last_completed_at is null or last_completed_at<=now()-interval '24 hours')) then
   perform app.start_library_walk(a.epoch);
  end if;
 end;
$$;
create or replace function public.app_maintenance(p_id uuid,p_lease uuid,p_sha text) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  -- Account first avoids the inverse of disconnect's account -> jobs lock order.
  perform 1 from app.account where singleton for share;
  perform 1 from app.library_state where singleton for update;
  perform 1 from app.jobs where id=p_id and lease_token=p_lease and kind='scheduler_ping' and state='running' and lease_until>now() for update;
  if not found then return false; end if;
  perform app.library_maintenance();
  delete from app.sessions where expires_at<=now();
  delete from app.oauth_states where expires_at<=now();
  delete from app.jobs where state in ('done','cancelled') and created_at<now()-interval '7 days';
  update app.runtime_health set jobs_sha=p_sha,last_maintenance_at=now() where singleton;
  return true;
 end;
$$;
-- Extend the existing purge, retaining only the foundation's minimal login configuration.
create or replace function app.purge_product_data() returns void language sql set search_path='' as $$
 delete from app.tag_actions where epoch <= (select epoch from app.account where singleton);
 delete from app.track_tags where track_key in (select track_key from app.annotations where epoch <= (select epoch from app.account where singleton));
 delete from app.tags where epoch <= (select epoch from app.account where singleton);
 delete from app.track_metadata where track_key in (select track_key from app.annotations where epoch <= (select epoch from app.account where singleton));
 delete from app.annotations where epoch <= (select epoch from app.account where singleton);
 delete from app.sync_runs where epoch <= (select epoch from app.account where singleton);
 delete from app.page_cursors where epoch <= (select epoch from app.account where singleton);
 delete from app.library_state where singleton and epoch <= (select epoch from app.account where singleton);
 delete from app.credentials where singleton;
 delete from app.sessions where epoch <= (select epoch from app.account where singleton);
 delete from app.oauth_states where epoch <= (select epoch from app.account where singleton);
$$;

do $$ declare t record; f record; begin
 for t in select tablename from pg_tables where schemaname='app' loop
  execute format('alter table app.%I enable row level security',t.tablename);
 end loop;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on p.pronamespace=n.oid
  where n.nspname='public' and p.proname like 'app\_%' escape '\' loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst, 'reload schema';
