-- Additive fast tagging: all owner-facing work stays local and owner/revision locked.
alter table app.library_state add column completed_run_id uuid;
update app.library_state s set completed_run_id=(select r.id from app.sync_runs r where r.epoch=s.epoch and r.completed_at is not null order by r.completed_at desc limit 1) where s.singleton;
alter table app.tags add column deleted_at timestamptz;
alter table app.tags add column vocabulary_version bigint not null default 1;
alter table app.tags alter column normalized_name drop not null;
alter table app.tags add constraint tags_live_name check((deleted_at is null and normalized_name is not null) or (deleted_at is not null and normalized_name is null));
-- Deleted identity remains reserved by UUID; its normalized name is released.
create table app.vocabulary_deletes (
 action_id uuid primary key references app.tag_actions(id) on delete cascade,
 original_name text not null, original_normalized_name text not null
);
alter table app.vocabulary_deletes enable row level security;
create table app.vocabulary_changes (
 action_id uuid primary key references app.tag_actions(id) on delete cascade,
 before_tags jsonb not null, edges jsonb not null default '[]', queries jsonb not null default '[]'
);
alter table app.vocabulary_changes enable row level security;
create or replace function app.validate_query(p_query jsonb) returns void language plpgsql set search_path='' as $$
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
    if not exists(select 1 from app.tags where id=(n->>'tagId')::uuid and deleted_at is null and epoch=(select epoch from app.library_state where singleton)) then raise exception 'unknown_tag'; end if;
   elsif op in ('and','or') then
    if jsonb_typeof(n->'children') is distinct from 'array' or jsonb_array_length(n->'children')=0 then raise exception 'invalid_input'; end if;
   elsif op='not' then
    if not n ? 'child' then raise exception 'invalid_input'; end if;
   else raise exception 'invalid_input'; end if;
  end loop;
 end;
$$;
create or replace function public.app_tags_lookup(p_epoch bigint,p_tag_ids jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare ids uuid[]; rows jsonb;
 begin
  perform app.require_owner(p_epoch);
  if jsonb_typeof(p_tag_ids) is distinct from 'array' then raise exception 'invalid_input'; end if;
  if jsonb_array_length(p_tag_ids) not between 1 and 200 then raise exception 'invalid_input'; end if;
  if exists(select 1 from jsonb_array_elements(p_tag_ids) v where jsonb_typeof(v) is distinct from 'string'
   or not coalesce(v#>>'{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false)) then raise exception 'invalid_input'; end if;
  select array_agg(value::uuid order by ordinality) into ids from jsonb_array_elements_text(p_tag_ids) with ordinality;
  if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'invalid_input'; end if;
  if exists(select 1 from unnest(ids) requested where not exists(select 1 from app.tags t where t.id=requested and t.epoch=p_epoch and t.deleted_at is null)) then raise exception 'unknown_tag'; end if;
  select jsonb_agg(app.tag_dto(id) order by ordinality) into rows from unnest(ids) with ordinality as requested(id,ordinality);
  return jsonb_build_object('tags',rows,'revision',app.library_revision());
 end;
$$;
create or replace function public.app_tag_action(p_epoch bigint,p_session_hash text,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare keys text[]; v_tag_id uuid; resolved jsonb; desired boolean; action_id uuid; changed integer:=0; key text; old_edge app.track_tags; next_version bigint;
 begin
  perform app.require_owner(p_epoch);
  if not exists(select 1 from app.sessions where token_hash=p_session_hash and epoch=p_epoch and expires_at>now()) then raise exception 'inactive_epoch'; end if;
  if p_request->>'action' is null or p_request->>'action' not in ('add','remove') then raise exception 'invalid_input'; end if;
  desired:=p_request->>'action'='add';
  if (p_request ? 'tagId') = (p_request ? 'tagName') or (p_request ? 'tagName' and not desired) then raise exception 'invalid_input'; end if;
  -- Freeze the exact selection against the caller's revision BEFORE vocabulary creation
  -- changes the annotation revision. Any later error rolls both changes back together.
  keys:=app.selection_keys(p_epoch,p_request->'selection');
  if p_request ? 'tagName' then
   if cardinality(keys)=0 then raise exception 'unknown_track'; end if;
   resolved:=public.app_tag_create(p_epoch,p_request->>'tagName');
   v_tag_id:=(resolved->'tag'->>'id')::uuid;
  else
   v_tag_id:=(p_request->>'tagId')::uuid;
   if not exists(select 1 from app.tags where id=v_tag_id and epoch=p_epoch and deleted_at is null) then raise exception 'unknown_tag'; end if;
  end if;
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
  return jsonb_build_object('actionId',action_id,'tag',app.tag_dto(v_tag_id),'selectedCount',cardinality(keys),'changedCount',changed,'revision',app.library_revision());
 end;
$$;
create or replace function public.app_tag_create(p_epoch bigint,p_name text) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare tag_id uuid; created boolean:=false; normalized text;
 begin
  perform app.require_owner(p_epoch);
  p_name:=normalize(btrim(regexp_replace(p_name,'[[:space:]               　﻿]+',' ','g')),NFC);
  if p_name is null or length(p_name) not between 1 and 80 then raise exception 'invalid_input'; end if;
  normalized:=lower(p_name);
  insert into app.tags(epoch,name,normalized_name) values(p_epoch,p_name,normalized) on conflict(epoch,normalized_name) do nothing returning id into tag_id;
  if found then
   created:=true; update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch;
  else select id into tag_id from app.tags where epoch=p_epoch and normalized_name=normalized; end if;
  return jsonb_build_object('tag',app.tag_dto(tag_id),'created',created,'revision',app.library_revision());
 end;
$$;
create or replace function public.app_library_page_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_pass integer,p_offset integer,
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
  -- Progress follows the latest page total; invalid_pass remembers any earlier change.
  r.reported_total:=p_total;
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
   update app.library_state set initial_sync_complete=true,last_completed_at=now(),completed_run_id=r.id,head_signature=r.first_head,
    library_revision=library_revision+case when affected>0 or not initial_sync_complete or completed_run_id is distinct from r.id then 1 else 0 end where singleton and epoch=p_epoch;
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

create function app.normalized_label(p_text text) returns text language sql immutable set search_path='' as $$
 select lower(normalize(btrim(regexp_replace(p_text,'[[:space:]               　﻿]+',' ','g')),NFC));
$$;
create function app.track_decade(p_date text) returns text language sql immutable set search_path='' as $$
 select case when p_date ~ '^[0-9]{4}($|-)' then (((substring(p_date,1,4)::integer)/10)*10)::text else 'unknown' end;
$$;
create or replace function app.filter_keys(p_filter jsonb) returns table(track_key text,liked_at timestamptz)
 language sql stable set search_path='' as $$
 select m.track_key,m.liked_at from app.track_metadata m join app.annotations a using(track_key)
 where a.epoch=(select epoch from app.library_state where singleton)
 and ((p_filter->>'membership'='active' and m.removed_at is null) or (p_filter->>'membership'='removed' and m.removed_at is not null))
 and (not (p_filter->>'untagged')::boolean or not exists(select 1 from app.track_tags t where t.track_key=m.track_key and t.present))
 and (not (p_filter->>'newOnly')::boolean or (m.removed_at is null and m.acknowledged_at is null))
 and (not coalesce((p_filter->>'latestSyncOnly')::boolean,false) or (m.removed_at is null and m.added_run_id=(select completed_run_id from app.library_state where singleton)))
 and (p_filter->>'artistId' is null or exists(select 1 from jsonb_array_elements(m.artists) ar where ar->>'id'=p_filter->>'artistId'))
 and (p_filter->>'album' is null or app.normalized_label(m.album)=app.normalized_label(p_filter->>'album'))
 and (p_filter->>'decade' is null or app.track_decade(m.release_date)=p_filter->>'decade')
 and (coalesce(p_filter->>'search','')='' or position(lower(normalize(p_filter->>'search',NFC)) in
  lower(normalize(m.title||' '||m.album||' '||coalesce((select string_agg(ar->>'name',' ') from jsonb_array_elements(m.artists) ar),''),NFC)))>0)
 order by m.liked_at desc,m.track_key;
$$;

create or replace function public.app_library_search(p_epoch bigint,p_request jsonb) returns jsonb
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
    union all select m.track_key,app.normalized_label(m.album),m.album from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key) where grouping='album'
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
    case when sorting='oldest' then m.liked_at end asc,
    case when sorting='newest' then m.liked_at end desc,
    case sorting when 'title' then lower(normalize(m.title,NFC)) when 'album' then app.normalized_label(m.album) when 'artist' then lower(normalize(m.artists->0->>'name',NFC)) when 'year' then m.release_date when 'random' then md5(seed||m.track_key) end asc nulls last,k.track_key) as ord
    from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key)
  ), page as(select * from ordered order by ord offset off limit lim)
  select coalesce(jsonb_agg(app.track_dto(track_key) order by ord),'[]') into rows from page;
  return jsonb_build_object('revision',rev,'totalTracks',total,'groupBy',null,'tracks',rows,'nextCursor',app.next_cursor(p_epoch,'library',binding,off+lim,total));
 end;
$$;

-- Small bounded edit distance, preserving accents/punctuation/emoji rather than transliterating.
create function app.tag_distance(a text,b text) returns integer language plpgsql immutable set search_path='' as $$
 declare prev integer[]; cur integer[]; i integer; j integer;
 begin
  if length(a)>80 or length(b)>80 then return 81; end if;
  prev:=array(select generate_series(0,length(b)));
  for i in 1..length(a) loop
   cur:=array[i];
   for j in 1..length(b) loop cur:=array_append(cur,least(cur[j]+1,prev[j+1]+1,prev[j]+case when substring(a,i,1)=substring(b,j,1) then 0 else 1 end)); end loop;
   prev:=cur;
  end loop;
  return prev[length(b)+1];
 end;
$$;
create or replace function public.app_tags_search(p_epoch bigint,p_search text default '',p_limit integer default 20) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare rows jsonb; total bigint; normalized text:=lower(normalize(btrim(regexp_replace(p_search,'[[:space:]               　﻿]+',' ','g')),NFC));
 begin
  perform app.require_owner(p_epoch);
  if p_limit is null or p_limit not between 1 and 100 or p_search is null or length(p_search)>200 then raise exception 'invalid_input'; end if;
  with candidates as (
   select t.id,t.normalized_name,app.tag_dto(t.id) as dto,
    case when t.normalized_name=normalized then 0 when starts_with(t.normalized_name,normalized) then 1 when position(normalized in t.normalized_name)>0 then 2 else 3 end as rank,
    app.tag_distance(t.normalized_name,normalized) as distance
   from app.tags t where t.epoch=p_epoch and t.deleted_at is null
  ), matches as (select * from candidates where rank<3 or (length(normalized)>=3 and distance<=2)), page as (
   select * from matches order by rank,case when rank=3 then distance else 0 end,(dto->>'activeTrackCount')::bigint desc,normalized_name,id limit p_limit
  ) select (select count(*) from matches),coalesce(jsonb_agg(dto order by rank,case when rank=3 then distance else 0 end,(dto->>'activeTrackCount')::bigint desc,normalized_name,id),'[]') into total,rows from page;
  return jsonb_build_object('tags',rows,'hasMore',total>p_limit,'revision',app.library_revision());
 end;
$$;
create function public.app_tags_vocabulary(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare rows jsonb; total bigint; off integer; lim integer:=(p_request->>'limit')::integer; sorting text:=p_request->>'sort'; binding jsonb:=p_request-'cursor'-'limit';
 begin
  perform app.require_owner(p_epoch);
  if lim is null or lim not between 1 and 100 or sorting not in ('name','mostUsed','lastUsed','unused') then raise exception 'invalid_input'; end if;
  off:=app.page_offset(p_epoch,'vocabulary',binding,p_request->>'cursor');
  with tags as(select t.*,app.tag_dto(t.id) as dto,(select count(*) from app.track_tags e where e.tag_id=t.id and e.present) as assignments from app.tags t
   where t.epoch=p_epoch and t.deleted_at is null and position(lower(normalize(p_request->>'search',NFC)) in t.normalized_name)>0),
  ordered as(select *,row_number() over(order by case when sorting='mostUsed' then (dto->>'activeTrackCount')::bigint end desc nulls last,case when sorting='lastUsed' then last_used_at end desc nulls last,normalized_name,id) as ord from tags where sorting<>'unused' or assignments=0),
  page as(select * from ordered order by ord offset off limit lim)
  select (select count(*) from ordered),coalesce(jsonb_agg(dto order by ord),'[]') into total,rows from page;
  return jsonb_build_object('tags',rows,'hasMore',off+lim<total,'nextCursor',app.next_cursor(p_epoch,'vocabulary',binding,off+lim,total),'revision',app.library_revision());
 end;
$$;
create function public.app_tags_selection(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare keys text[]; ids jsonb:=p_request->'tagIds'; rows jsonb;
 begin
  perform app.require_owner(p_epoch); perform app.require_revision(p_request->'expectedRevision');
  perform public.app_tags_lookup(p_epoch,ids); keys:=app.selection_keys(p_epoch,p_request->'selection');
  select jsonb_agg(jsonb_build_object('tag',app.tag_dto(id::uuid),'assignedCount',assigned,'state',case when assigned=0 then 'none' when assigned=cardinality(keys) then 'all' else 'some' end) order by ord) into rows
   from (select v.id,v.ord,(select count(*) from app.track_tags e where e.tag_id=v.id::uuid and e.present and e.track_key=any(keys)) as assigned from jsonb_array_elements_text(ids) with ordinality v(id,ord)) counts;
  return jsonb_build_object('revision',app.library_revision(),'selectedCount',cardinality(keys),'tags',rows);
 end;
$$;

create function public.app_tags_manage_preview(p_epoch bigint,p_request jsonb) returns jsonb
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
  select count(*),count(distinct e.track_key) filter(where m.track_key is not null and m.removed_at is null),count(distinct e.track_key) into assignments,active,unions
   from app.track_tags e left join app.track_metadata m using(track_key) where e.tag_id=any(ids) and e.present;
  return jsonb_build_object('revision',app.library_revision(),'assignmentCount',assignments,'activeTrackCount',active,'unionCount',unions,'collisionTag',case when collision is null then null else app.tag_dto(collision) end);
 end;
$$;
-- Snapshot playlist membership and operation intent never change with vocabulary.
create function app.rewrite_tag_node(p_node jsonb,p_sources uuid[],p_target uuid) returns jsonb
 language plpgsql immutable set search_path='' as $$
 declare children jsonb;
 begin
  if p_node->>'op'='tag' then
   if (p_node->>'tagId')::uuid=any(p_sources) then return jsonb_build_object('op','tag','tagId',p_target); end if;
   return p_node;
  elsif p_node->>'op'='not' then return jsonb_build_object('op','not','child',app.rewrite_tag_node(p_node->'child',p_sources,p_target));
  else
   select jsonb_agg(app.rewrite_tag_node(value,p_sources,p_target) order by ordinality) into children from jsonb_array_elements(p_node->'children') with ordinality;
   return jsonb_build_object('op',p_node->>'op','children',children);
  end if;
 end;
$$;
create function public.app_tags_manage(p_epoch bigint,p_session_hash text,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare preview jsonb; ids uuid[]; target uuid; action text:=p_request->>'action'; aid uuid; changed integer:=0; affected integer; original app.tags; rewritten jsonb; p app.playlists; before_tags jsonb; edges jsonb:='[]'; queries jsonb:='[]';
 begin
  perform app.require_owner(p_epoch);
  if not exists(select 1 from app.sessions where token_hash=p_session_hash and epoch=p_epoch and expires_at>now()) then raise exception 'inactive_epoch'; end if;
  preview:=public.app_tags_manage_preview(p_epoch,p_request);
  if action='rename' then
   target:=(p_request->>'tagId')::uuid;
   if preview->'collisionTag'<>'null'::jsonb then return preview||jsonb_build_object('actionId',null,'changedCount',0,'tag',app.tag_dto(target)); end if;
   select jsonb_build_array(jsonb_build_object('id',t.id,'name',t.name,'normalized',t.normalized_name,'version',t.vocabulary_version+1)) into before_tags from app.tags t where t.id=target;
   update app.tags set name=normalize(btrim(regexp_replace(p_request->>'name','[[:space:]               　﻿]+',' ','g')),NFC), normalized_name=lower(normalize(btrim(regexp_replace(p_request->>'name','[[:space:]               　﻿]+',' ','g')),NFC)),vocabulary_version=vocabulary_version+1
    where id=target and epoch=p_epoch and name is distinct from normalize(btrim(regexp_replace(p_request->>'name','[[:space:]               　﻿]+',' ','g')),NFC);
   get diagnostics changed=row_count;
   -- Name is rendered from current tag identity; mark stored playlist/list revisions.
   if changed>0 then
    insert into app.tag_actions(epoch,session_hash,tag_id) values(p_epoch,p_session_hash,target) returning id into aid;
    insert into app.vocabulary_changes(action_id,before_tags) values(aid,before_tags);
    update app.playlists set revision=revision+1 where epoch=p_epoch and query::text like '%'||target::text||'%';
    get diagnostics affected=row_count; if affected>0 then perform app.playlists_changed(); end if;
   end if;
  elsif action='delete' then
   target:=(p_request->>'tagId')::uuid;
   if p_request->'confirmedAssignmentCount' is distinct from preview->'assignmentCount' then raise exception 'stale_revision'; end if;
   select * into original from app.tags where id=target and epoch=p_epoch;
   insert into app.tag_actions(epoch,session_hash,tag_id) values(p_epoch,p_session_hash,target) returning id into aid;
   insert into app.vocabulary_deletes values(aid,original.name,original.normalized_name);
   with updated as(update app.track_tags set present=false,version=version+1 where tag_id=target and present returning track_key,version)
    insert into app.tag_action_edges(action_id,track_key,before_present,after_version) select aid,track_key,true,version from updated;
   get diagnostics changed=row_count;
   update app.tags set deleted_at=now(),vocabulary_version=vocabulary_version+1,normalized_name=null where id=target and epoch=p_epoch;
   changed:=changed+1;
  else
   target:=(p_request->>'targetId')::uuid;
   select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_request->'sourceIds');
   insert into app.tag_actions(epoch,session_hash,tag_id) values(p_epoch,p_session_hash,target) returning id into aid;
   select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'normalized',t.normalized_name,'version',t.vocabulary_version+1,'deleted',t.deleted_at)) into before_tags from app.tags t where t.id=any(ids||target);
   -- Journal only edges that will change; absence is the same false before-state.
   select coalesce(jsonb_agg(jsonb_build_object('key',key,'tagId',tag_id,'before',present,'version',version+1)),'[]') into edges from (
    select e.track_key as key,e.tag_id,e.present,e.version from app.track_tags e where e.tag_id=any(ids) and e.present
    union all select distinct e.track_key,target,coalesce(d.present,false),coalesce(d.version,0) from app.track_tags e left join app.track_tags d on d.track_key=e.track_key and d.tag_id=target where e.tag_id=any(ids) and e.present and not coalesce(d.present,false)
   ) changed_edges;
   -- Even an already-present destination edge gains a later merge contribution.
   -- Fence earlier ordinary assignment undo without recording a false presence change.
   update app.track_tags d set version=d.version+1 where d.tag_id=target and d.present
    and exists(select 1 from app.track_tags e where e.track_key=d.track_key and e.tag_id=any(ids) and e.present);
   -- Changed-only destination union records only absent destination edges.
   insert into app.track_tags(track_key,tag_id,present,version)
    select distinct e.track_key,target,true,1 from app.track_tags e where e.tag_id=any(ids) and e.present
    on conflict(track_key,tag_id) do update set present=true,version=app.track_tags.version+1 where not app.track_tags.present;
   get diagnostics changed=row_count;
   update app.track_tags set present=false,version=version+1 where tag_id=any(ids) and present;
   get diagnostics affected=row_count; changed:=changed+affected;
   update app.tags set deleted_at=now(),vocabulary_version=vocabulary_version+1,name='Deleted tag',normalized_name=null where id=any(ids) and epoch=p_epoch;
   -- The name column has a nonempty constraint: use a fixed private tombstone label.
   for p in select * from app.playlists where epoch=p_epoch loop
    rewritten:=jsonb_build_object('version',1,'root',app.rewrite_tag_node(p.query->'root',ids,target));
    if rewritten<>p.query then
     queries:=queries||jsonb_build_array(jsonb_build_object('id',p.id,'before',p.query,'after',rewritten,'revision',p.revision+1));
     update app.playlists set query=rewritten,revision=revision+1 where id=p.id; perform app.playlists_changed();
    end if;
   end loop;
   update app.tags set last_used_at=now(),vocabulary_version=vocabulary_version+1 where id=target and epoch=p_epoch;
   insert into app.vocabulary_changes values(aid,before_tags,edges,queries);
   changed:=changed+cardinality(ids);
  end if;
  if changed>0 then update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch; end if;
  return preview||jsonb_build_object('revision',app.library_revision(),'actionId',aid,'changedCount',changed,'tag',case when action='delete' then null else app.tag_dto(target) end);
 end;
$$;

-- Preserve the original assignment undo; tombstones may never resurrect an edge.
alter function public.app_tag_undo(bigint,text,uuid) rename to app_tag_assignment_undo;
alter function public.app_tag_assignment_undo(bigint,text,uuid) set schema app;
revoke all on function app.app_tag_assignment_undo(bigint,text,uuid) from public,anon,authenticated,service_role;
create function public.app_tag_undo(p_epoch bigint,p_session_hash text,p_action_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare action app.tag_actions; deleted app.vocabulary_deletes; restored integer:=0; total integer; tag app.tags; journal app.vocabulary_changes; entry jsonb; skipped integer:=0; conflict boolean:=false; affected integer;
 begin
  perform app.require_owner(p_epoch);
  if not exists(select 1 from app.sessions where token_hash=p_session_hash and epoch=p_epoch and expires_at>now()) then raise exception 'inactive_epoch'; end if;
  select * into action from app.tag_actions where id=p_action_id and epoch=p_epoch and session_hash=p_session_hash for update;
  if not found then raise exception 'unknown_action'; end if;
  if action.undone_at is not null then return jsonb_build_object('actionId',p_action_id,'restoredCount',0,'skippedCount',0,'revision',app.library_revision()); end if;
  select * into journal from app.vocabulary_changes where action_id=p_action_id;
  if found then
   total:=jsonb_array_length(journal.before_tags)+jsonb_array_length(journal.edges)+jsonb_array_length(journal.queries);
   -- Dependent merge restoration is all-or-nothing for vocabulary identities. Edge
   -- and query versions are then independent, so later edits are never overwritten.
   for entry in select value from jsonb_array_elements(journal.before_tags) loop
    if not exists(select 1 from app.tags t where t.id=(entry->>'id')::uuid and t.epoch=p_epoch and t.vocabulary_version=(entry->>'version')::bigint)
     or exists(select 1 from app.tags t where t.epoch=p_epoch and t.normalized_name=entry->>'normalized' and t.id<>(entry->>'id')::uuid) then conflict:=true; end if;
   end loop;
   if not conflict then
    for entry in select value from jsonb_array_elements(journal.before_tags) loop
     update app.tags set name=entry->>'name',normalized_name=entry->>'normalized',deleted_at=(entry->>'deleted')::timestamptz,vocabulary_version=vocabulary_version+1 where id=(entry->>'id')::uuid and epoch=p_epoch;
     restored:=restored+1;
    end loop;
    for entry in select value from jsonb_array_elements(journal.edges) loop
     update app.track_tags set present=(entry->>'before')::boolean,version=version+1 where track_key=entry->>'key' and tag_id=(entry->>'tagId')::uuid and version=(entry->>'version')::bigint;
     get diagnostics affected=row_count; restored:=restored+affected;
    end loop;
    for entry in select value from jsonb_array_elements(journal.queries) loop
     update app.playlists set query=entry->'before',revision=revision+1 where id=(entry->>'id')::uuid and epoch=p_epoch and query=entry->'after' and revision=(entry->>'revision')::bigint;
     get diagnostics affected=row_count; restored:=restored+affected; if affected>0 then perform app.playlists_changed(); end if;
    end loop;
    update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch;
   end if;
   update app.tag_actions set undone_at=now() where id=p_action_id and epoch=p_epoch;
   return jsonb_build_object('actionId',p_action_id,'restoredCount',restored,'skippedCount',total-restored,'revision',app.library_revision());
  end if;
  select * into deleted from app.vocabulary_deletes where action_id=p_action_id;
  select * into tag from app.tags where id=action.tag_id and epoch=p_epoch;
  if deleted.action_id is null and tag.deleted_at is null then return app.app_tag_assignment_undo(p_epoch,p_session_hash,p_action_id); end if;
  select count(*) into total from app.tag_action_edges where action_id=p_action_id;
  if deleted.action_id is not null and tag.deleted_at is not null then
   if exists(select 1 from app.tags where epoch=p_epoch and normalized_name=deleted.original_normalized_name and id<>tag.id) then raise exception 'request_conflict'; end if;
   update app.tags set deleted_at=null,name=deleted.original_name,vocabulary_version=vocabulary_version+1,normalized_name=deleted.original_normalized_name where id=tag.id and epoch=p_epoch;
   update app.track_tags t set present=true,version=t.version+1 from app.tag_action_edges e
    where e.action_id=p_action_id and t.track_key=e.track_key and t.tag_id=tag.id and t.version=e.after_version;
   get diagnostics restored=row_count;
   -- Restoring even an unused deleted identity is a vocabulary change.
   update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch;
  end if;
  update app.tag_actions set undone_at=now() where id=p_action_id and epoch=p_epoch;
  return jsonb_build_object('actionId',p_action_id,'restoredCount',restored,'skippedCount',total-restored,'revision',app.library_revision());
 end;
$$;
-- Daily maintenance bounds delete undo to the originating active session. Names are
-- erased once no recovery action remains; UUID tombstones keep deleted query leaves invalid.
alter function app.library_maintenance() rename to library_maintenance_core;
create function app.library_maintenance() returns void language plpgsql set search_path='' as $$
 begin
  perform app.library_maintenance_core();
  update app.tags t set name='Deleted tag' where t.deleted_at is not null and t.name<>'Deleted tag'
   and not exists(select 1 from app.tag_actions a join app.vocabulary_deletes d on d.action_id=a.id where a.tag_id=t.id);
 end;
$$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and p.proname like 'app\_%' escape '\' loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst, 'reload schema';
create function public.app_library_facets(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb; rows jsonb; cursor_value text;
 begin
  perform app.require_owner(p_epoch);
  -- Facet tokens cannot be replayed as library tokens, and vice versa.
  cursor_value:=p_request->>'cursor';
  if cursor_value is not null then
   perform app.page_offset(p_epoch,'facets',p_request-'cursor'-'limit',cursor_value);
   update app.page_cursors set route='library',binding=jsonb_build_object('filter',p_request->'filter','groupBy',p_request->>'facet','sort','newest','seed',null) where token=cursor_value;
  end if;
  result:=public.app_library_search(p_epoch,jsonb_build_object('filter',p_request->'filter','groupBy',p_request->>'facet','cursor',cursor_value,'limit',p_request->'limit'));
  if p_request->>'cursor' is not null then update app.page_cursors set route='facets',binding=p_request-'cursor'-'limit' where token=p_request->>'cursor'; end if;
  cursor_value:=result->>'nextCursor';
  if cursor_value is not null then update app.page_cursors set route='facets',binding=p_request-'cursor'-'limit' where token=cursor_value; end if;
  select coalesce(jsonb_agg(jsonb_build_object('value',value->>'value','name',value->>'name','trackCount',value->'trackCount') order by ordinality),'[]') into rows from jsonb_array_elements(result->'groups') with ordinality;
  return jsonb_build_object('facet',p_request->>'facet','revision',result->'revision','options',rows,'totalOptions',result->'totalGroups','nextCursor',cursor_value);
 end;
$$;
revoke all on function public.app_library_facets(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.app_library_facets(bigint,jsonb) to service_role;
notify pgrst, 'reload schema';
