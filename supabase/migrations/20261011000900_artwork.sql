-- URL-only cache. Images stay on Spotify's CDN; expiration yields a placeholder.
create table app.artwork (
 epoch bigint not null, kind text not null check(kind in ('artist','playlist')),
 spotify_id text not null check(spotify_id ~ '^[A-Za-z0-9]{22}$'),
 url text check(url is null or (length(url)<=4096 and url ~ '^https://[^/@#]+(/[^#]*)?$')),
 refresh_after timestamptz not null default now(), requested_at timestamptz not null default now(),
 pending boolean not null default true,
 primary key(epoch,kind,spotify_id)
);
alter table app.artwork enable row level security;
create function app.artwork_relevant(p_epoch bigint,p_kind text,p_spotify_id text) returns boolean
 language sql stable set search_path='' as $$
 select case p_kind when 'artist' then exists(
  select 1 from app.track_metadata m cross join lateral jsonb_array_elements(m.artists) ar where ar->>'id'=p_spotify_id)
 when 'playlist' then exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=p_spotify_id and p.status<>'removed') else false end;
$$;
create function app.request_artwork(p_epoch bigint,p_kind text,p_spotify_id text) returns text
 language plpgsql set search_path='' as $$
 declare cached app.artwork;
 begin
  if p_spotify_id is null or not app.artwork_relevant(p_epoch,p_kind,p_spotify_id) then return null; end if;
  -- Account lock serializes queue creation and prevents work after disconnect.
  perform 1 from app.account where epoch=p_epoch and state='connected' for update;
  if not found then return null; end if;
  insert into app.artwork(epoch,kind,spotify_id) values(p_epoch,p_kind,p_spotify_id)
   on conflict(epoch,kind,spotify_id) do update set requested_at=now(),
    pending=app.artwork.pending or app.artwork.refresh_after<=now();
  select * into strict cached from app.artwork where epoch=p_epoch and kind=p_kind and spotify_id=p_spotify_id;
  if cached.pending and not exists(select 1 from app.jobs where epoch=p_epoch and kind='artwork' and state in ('queued','running','parked')) then
   perform public.app_job_enqueue('artwork',p_epoch,'{}',-10);
  end if;
  return case when cached.refresh_after>now() then cached.url else null end;
 end;
$$;

-- Wrap the existing search to retain pagination/filter semantics and hydrate
-- only visible artist groups, rather than fan out over the whole library.
alter function public.app_library_search(bigint,jsonb) rename to app_library_search_before_artwork;
create function public.app_library_search(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb; rows jsonb:='[]'; g jsonb; image text; artwork_pending boolean:=false;
 begin
  perform 1 from app.account where epoch=p_epoch for update;
  result:=public.app_library_search_before_artwork(p_epoch,p_request);
  if result->>'groupBy' is null then return result||jsonb_build_object('artworkPending',false); end if;
  for g in select value from jsonb_array_elements(result->'groups') loop
   image:=null;
   if result->>'groupBy'='artist' then
    image:=app.request_artwork(p_epoch,'artist',g->>'artistId');
    artwork_pending:=artwork_pending or exists(select 1 from app.artwork a where a.epoch=p_epoch and a.kind='artist' and a.spotify_id=g->>'artistId' and a.pending);
   elsif result->>'groupBy'='album' then
    select m.artwork_url into image from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key)
     where app.album_identity(m.album)=g->>'value' and m.artwork_url is not null order by m.track_key limit 1;
   end if;
   rows:=rows||jsonb_build_array(g||jsonb_build_object('artworkUrl',image));
  end loop;
  return result||jsonb_build_object('groups',rows,'artworkPending',artwork_pending);
 end;
$$;
alter function app.playlist_dto(app.playlists) rename to playlist_dto_before_artwork;
create function app.playlist_dto(p app.playlists) returns jsonb language sql stable set search_path='' as $$
 select app.playlist_dto_before_artwork(p)||jsonb_build_object('artworkUrl',
  (select url from app.artwork a where a.epoch=p.epoch and a.kind='playlist' and a.spotify_id=p.spotify_id and a.refresh_after>now()));
$$;
alter function public.app_playlist_list(bigint,text,integer) rename to app_playlist_list_before_artwork;
create function public.app_playlist_list(p_epoch bigint,p_cursor text default null,p_limit integer default 50) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb; g jsonb; spotify_id text;
 begin
  perform 1 from app.account where epoch=p_epoch for update;
  result:=public.app_playlist_list_before_artwork(p_epoch,p_cursor,p_limit);
  for g in select value from jsonb_array_elements(result->'playlists') loop
   select p.spotify_id into spotify_id from app.playlists p where p.id=(g->>'id')::uuid and p.epoch=p_epoch;
   if g->>'status'='ready' then perform app.request_artwork(p_epoch,'playlist',spotify_id); end if;
  end loop;
  return result;
 end;
$$;

create function public.app_artwork_work(p_epoch bigint,p_id uuid,p_lease uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare target jsonb;
 begin
  perform 1 from app.account where epoch=p_epoch and state='connected' for update;
  if not found then return null; end if;
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='artwork' and state='running'
   and lease_token=p_lease and lease_until>clock_timestamp() for update;
  if not found then return null; end if;
  perform public.app_job_renew(p_id,p_lease);
  select jsonb_build_object('kind',a.kind,'spotifyId',a.spotify_id) into target from app.artwork a
   where a.epoch=p_epoch and a.pending and app.artwork_relevant(p_epoch,a.kind,a.spotify_id)
   order by a.requested_at desc,a.kind,a.spotify_id limit 1;
  if target is null then
   -- Finish under the same account/job locks as the empty read. A later browse
   -- must see a finished job and enqueue a successor for newly pending targets.
   perform public.app_job_finish(p_id,p_lease,'done');
  end if;
  return target;
 end;
$$;
create function public.app_artwork_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_kind text,p_spotify_id text,p_url text) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  perform 1 from app.account where epoch=p_epoch and state='connected' for update;
  if not found then return false; end if;
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='artwork' and state='running'
   and lease_token=p_lease and lease_until>clock_timestamp() for update;
  if not found then return false; end if;
  if not app.artwork_relevant(p_epoch,p_kind,p_spotify_id) then
   delete from app.artwork where epoch=p_epoch and kind=p_kind and spotify_id=p_spotify_id;
   return true;
  end if;
  update app.artwork set url=p_url,pending=false,
   refresh_after=now()+case when p_url is null then interval '5 minutes' when p_kind='playlist' then interval '4 hours' else interval '24 hours' end
   where epoch=p_epoch and kind=p_kind and spotify_id=p_spotify_id;
  return found;
 end;
$$;
alter function app.library_maintenance() rename to library_maintenance_before_artwork;
create function app.library_maintenance() returns void language plpgsql set search_path='' as $$
 begin
  perform app.library_maintenance_before_artwork();
  delete from app.artwork where requested_at<=now()-interval '90 days'
   or not app.artwork_relevant(epoch,kind,spotify_id);
 end;
$$;
alter function app.purge_product_data() rename to purge_product_data_before_artwork;
create function app.purge_product_data() returns void language plpgsql set search_path='' as $$
 begin
  delete from app.artwork where epoch is not null;
  perform app.purge_product_data_before_artwork();
 end;
$$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('app_library_search','app_playlist_list','app_artwork_work','app_artwork_commit') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
revoke all on function public.app_library_search_before_artwork(bigint,jsonb), public.app_playlist_list_before_artwork(bigint,text,integer) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
