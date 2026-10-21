-- Source membership is independent of retained annotations and output snapshots.
alter table app.sync_runs add column skipped_count integer not null default 0;
alter table app.library_state add column sources_discovered_at timestamptz, add column sources_revision bigint not null default 0;
create table app.sources (
 epoch bigint not null,
 id text not null check(id='liked' or id ~ '^[A-Za-z0-9]{22}$'),
 kind text not null check(kind in ('liked','playlist')),
 name text not null,
 artwork_url text,
 spotify_url text,
 enabled boolean not null default true,
 available boolean not null default true,
 managed boolean not null default false,
 track_count integer not null default 0,
 imported_count integer not null default 0,
 skipped_count integer not null default 0,
 snapshot_id text,
 last_synced_at timestamptz,
 latest_completed_run_id uuid,
 error_code text,
 primary key(epoch,id)
);
create table app.source_memberships (
 epoch bigint not null,
 source_id text not null,
 track_key text not null references app.annotations(track_key) on delete cascade,
 added_at timestamptz not null,
 primary key(epoch,source_id,track_key),
 foreign key(epoch,source_id) references app.sources(epoch,id) on delete cascade
);
create index source_memberships_track on app.source_memberships(epoch,track_key);
create table app.source_scans (
 job_id uuid primary key references app.jobs(id) on delete cascade,
 epoch bigint not null,
 source_id text,
 next_offset integer not null default 0,
 pass integer not null default 1,
 snapshot_id text,
 total integer,
 received integer not null default 0,
 skipped integer not null default 0,
 invalid boolean not null default false,
 foreign key(epoch,source_id) references app.sources(epoch,id) on delete cascade
);
create table app.source_discovery_pages (
 job_id uuid not null references app.source_scans(job_id) on delete cascade,
 pass integer not null,
 page_offset integer not null,
 signature jsonb not null,
 primary key(job_id,pass,page_offset)
);
create table app.source_discovery_ids (
 job_id uuid not null references app.source_scans(job_id) on delete cascade,
 pass integer not null,
 source_id text not null,
 primary key(job_id,pass,source_id)
);
create table app.source_seen (
 job_id uuid not null references app.source_scans(job_id) on delete cascade,
 track_key text not null references app.annotations(track_key) on delete cascade,
 added_at timestamptz not null,
 primary key(job_id,track_key)
);
create function app.ensure_sources(p_epoch bigint) returns void language sql set search_path='' as $$
 insert into app.sources(epoch,id,kind,name,last_synced_at,latest_completed_run_id)
 select p_epoch,'liked','liked','Liked Songs',last_completed_at,completed_run_id from app.library_state where singleton and epoch=p_epoch
 on conflict(epoch,id) do nothing;
$$;
select app.ensure_sources(epoch) from app.library_state where singleton;
insert into app.source_memberships(epoch,source_id,track_key,added_at)
 select a.epoch,'liked',m.track_key,m.liked_at from app.track_metadata m join app.annotations a using(track_key) where m.removed_at is null;
create function app.refresh_source_pool(p_epoch bigint) returns void language plpgsql set search_path='' as $$
 declare changed integer;
 begin
  update app.track_metadata m set removed_at=case when exists(
   select 1 from app.source_memberships sm join app.sources s on s.epoch=sm.epoch and s.id=sm.source_id
   where sm.epoch=p_epoch and sm.track_key=m.track_key and s.enabled
  ) then null else coalesce(m.removed_at,now()) end
  where exists(select 1 from app.annotations a where a.track_key=m.track_key and a.epoch=p_epoch)
   and (m.removed_at is null) is distinct from exists(
    select 1 from app.source_memberships sm join app.sources s on s.epoch=sm.epoch and s.id=sm.source_id
    where sm.epoch=p_epoch and sm.track_key=m.track_key and s.enabled);
  get diagnostics changed=row_count;
  update app.library_state set library_revision=library_revision+case when changed>0 then 1 else 0 end,
   initial_sync_complete=sources_discovered_at is not null and not exists(select 1 from app.sources where epoch=p_epoch and enabled and available and last_synced_at is null)
   where singleton and epoch=p_epoch;
  if to_regprocedure('app.refresh_song_groups(bigint)') is not null then perform app.refresh_song_groups(p_epoch); end if;
 end;
$$;
create function app.enqueue_sources(p_epoch bigint,p_force boolean default false) returns boolean language plpgsql set search_path='' as $$
 declare sid text; jid uuid; queued boolean:=false;
 begin
  perform app.ensure_sources(p_epoch);
  if not exists(select 1 from app.jobs where epoch=p_epoch and kind='source_discovery' and state in ('queued','running','parked')) then
   insert into app.jobs(kind,epoch,priority) values('source_discovery',p_epoch,9) returning id into jid;
   insert into app.source_scans(job_id,epoch) values(jid,p_epoch); queued:=true;
  end if;
  for sid in select id from app.sources where epoch=p_epoch and kind='playlist' and enabled and
   (p_force or last_synced_at is null or last_synced_at<now()-interval '24 hours') loop
   if not exists(select 1 from app.jobs where epoch=p_epoch and kind='source_sync' and payload->>'sourceId'=sid and state in ('queued','running','parked')) then
    insert into app.jobs(kind,epoch,payload,priority) values('source_sync',p_epoch,jsonb_build_object('sourceId',sid),8) returning id into jid;
    insert into app.source_scans(job_id,epoch,source_id) values(jid,p_epoch,sid); queued:=true;
   end if;
  end loop;
  return queued;
 end;
$$;
create function public.app_sources_list(p_epoch bigint,p_search text default '',p_offset integer default 0,p_limit integer default 50) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare items jsonb; total bigint;
 begin
  perform app.require_owner(p_epoch); perform app.ensure_sources(p_epoch);
  if p_search is null or length(p_search)>200 or p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_input'; end if;
  select count(*) into total from app.sources where epoch=p_epoch and position(lower(p_search) in lower(name))>0;
  select coalesce(jsonb_agg(dto order by kind,id),'[]') into items from (
   select s.kind,s.id,jsonb_build_object('id',s.id,'kind',s.kind,'name',s.name,'artworkUrl',s.artwork_url,'spotifyUrl',s.spotify_url,
    'enabled',s.enabled,'available',s.available,'managed',s.managed,'trackCount',s.track_count,
    'uniqueCount',(select count(*) from app.source_memberships sm where sm.epoch=p_epoch and sm.source_id=s.id),
    'importedCount',s.imported_count,'skippedCount',s.skipped_count,'lastSyncedAt',s.last_synced_at,'errorCode',s.error_code,
    'syncStatus',case when not s.enabled then 'disabled' when s.error_code is not null then 'error'
     when exists(select 1 from app.jobs j where j.epoch=p_epoch and j.state in ('queued','running') and
      ((s.kind='liked' and j.kind='library_sync') or (j.kind='source_sync' and j.payload->>'sourceId'=s.id))) then 'syncing'
     when s.last_synced_at is null then 'pending' else 'complete' end) dto
   from app.sources s where s.epoch=p_epoch and position(lower(p_search) in lower(s.name))>0 order by kind,id offset p_offset limit p_limit
  ) page;
  return jsonb_build_object('items',items,'total',total,'enabledCount',(select count(*) from app.sources where epoch=p_epoch and enabled),
   'uniqueTrackCount',(select count(*) from app.track_metadata m join app.annotations a using(track_key) where a.epoch=p_epoch and m.removed_at is null),
   'importing',(select sources_discovered_at is null from app.library_state where singleton) or exists(select 1 from app.sources where epoch=p_epoch and enabled and available and last_synced_at is null),'revision',app.library_revision());
 end;
$$;
create function public.app_sources_selection(p_epoch bigint,p_ids jsonb,p_enabled boolean) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare changed integer;
 begin
  perform app.require_owner(p_epoch); perform app.ensure_sources(p_epoch);
  if p_enabled is null or jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids) not between 1 and 10000
   or exists(select 1 from jsonb_array_elements(p_ids) i where jsonb_typeof(i)<>'string') then raise exception 'invalid_input'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_ids) i where not exists(select 1 from app.sources where epoch=p_epoch and id=i)) then raise exception 'unknown_source'; end if;
  update app.sources set enabled=p_enabled where epoch=p_epoch and id in(select jsonb_array_elements_text(p_ids)) and enabled is distinct from p_enabled;
  get diagnostics changed=row_count;
  if changed>0 then
   update app.library_state set library_revision=library_revision+1,sources_revision=sources_revision+1 where singleton and epoch=p_epoch;
   perform app.refresh_source_pool(p_epoch);
   if p_enabled then
    perform app.enqueue_sources(p_epoch,false);
    if p_ids ? 'liked' then perform app.start_library_walk(p_epoch); end if;
   end if;
  end if;
  return jsonb_build_object('changedCount',changed,'revision',app.library_revision());
 end;
$$;
create function public.app_sources_sync(p_epoch bigint) returns jsonb language plpgsql security definer set search_path='' as $$
 declare queued boolean;
 begin
  perform app.require_owner(p_epoch,true); queued:=app.enqueue_sources(p_epoch,true);
  if exists(select 1 from app.sources where epoch=p_epoch and id='liked' and enabled) then perform app.start_library_walk(p_epoch); queued:=true; end if;
  return jsonb_build_object('queued',queued,'revision',app.library_revision());
 end;
$$;
create function public.app_source_job_state(p_epoch bigint,p_id uuid,p_lease uuid,p_encrypted_key text) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare j app.jobs; r app.source_scans; s app.sources;
 begin
  perform app.require_owner(p_epoch,true);
  select * into j from app.jobs where id=p_id and epoch=p_epoch and kind in ('source_sync','source_discovery') and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return null; end if;
  select * into r from app.source_scans where job_id=p_id for update;
  if not found then return null; end if;
  if p_encrypted_key is null or length(p_encrypted_key)>1024 then raise exception 'invalid_input'; end if;
  update app.library_state set encrypted_annotation_key=coalesce(encrypted_annotation_key,p_encrypted_key) where singleton and epoch=p_epoch;
  if r.source_id is not null then select * into s from app.sources where epoch=p_epoch and id=r.source_id; end if;
  return jsonb_build_object('terminal',r.snapshot_id is not null and r.received=r.total,'offset',r.next_offset,'snapshotId',r.snapshot_id,'sourceId',r.source_id,'enabled',coalesce(s.enabled,true),
   'previousSnapshotId',case when exists(select 1 from app.source_memberships sm where sm.epoch=p_epoch and sm.source_id=s.id and not exists(select 1 from app.track_metadata m where m.track_key=sm.track_key)) then null else s.snapshot_id end,'lastSyncedAt',s.last_synced_at,'accountId',(select account_id from app.account where singleton),
   'encryptedKey',(select encrypted_annotation_key from app.library_state where singleton));
 end;
$$;
create function public.app_source_discovery_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_offset integer,p_total integer,p_received integer,p_next_offset integer,p_sources jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare r app.source_scans; row jsonb; is_managed boolean; changed boolean:=false; valid boolean; same boolean;
 begin
  perform app.require_owner(p_epoch,true);
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='source_discovery' and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return null; end if;
  select * into r from app.source_scans where job_id=p_id for update;
  if not found or r.next_offset<>p_offset then return null; end if;
  if p_total is null or p_total<0 or p_received is null or p_received not between 0 and 50 or jsonb_typeof(p_sources) is distinct from 'array' or jsonb_array_length(p_sources)<>p_received
   or (p_next_offset is not null and (p_next_offset<>p_offset+p_received or p_received=0)) then raise exception 'invalid_input'; end if;
  for row in select value from jsonb_array_elements(p_sources) loop
   if row->>'id' is null or row->>'id' !~ '^[A-Za-z0-9]{22}$' then raise exception 'invalid_input'; end if;
   insert into app.source_discovery_ids values(p_id,r.pass,row->>'id') on conflict do nothing;
   if not found then r.invalid:=true; end if;
   is_managed:=exists(select 1 from app.playlists where epoch=p_epoch and spotify_id=row->>'id');
   insert into app.sources(epoch,id,kind,name,artwork_url,spotify_url,enabled,managed,track_count)
    values(p_epoch,row->>'id','playlist',row->>'name',row->>'artworkUrl','https://open.spotify.com/playlist/'||(row->>'id'),not is_managed,is_managed,(row->>'total')::integer)
    on conflict(epoch,id) do update set name=excluded.name,artwork_url=excluded.artwork_url,track_count=excluded.track_count,managed=excluded.managed;
   changed:=true;
  end loop;
  insert into app.source_discovery_pages values(p_id,r.pass,p_offset,jsonb_build_object('total',p_total,'received',p_received,'sources',p_sources));
  update app.source_scans set next_offset=coalesce(p_next_offset,p_offset+p_received),total=p_total,received=received+p_received,
   invalid=r.invalid or (total is not null and total<>p_total) where job_id=p_id returning * into r;
  if changed then update app.library_state set library_revision=library_revision+1 where singleton and epoch=p_epoch; end if;
  perform app.refresh_source_pool(p_epoch);
  if p_next_offset is not null then return jsonb_build_object('done',false); end if;
  valid:=not r.invalid and r.received=r.total;
  same:=valid and r.pass>1 and not exists(
   (select page_offset,signature from app.source_discovery_pages where job_id=p_id and pass=r.pass
    except select page_offset,signature from app.source_discovery_pages where job_id=p_id and pass=r.pass-1)
   union all
   (select page_offset,signature from app.source_discovery_pages where job_id=p_id and pass=r.pass-1
    except select page_offset,signature from app.source_discovery_pages where job_id=p_id and pass=r.pass));
  if same then
   update app.library_state set sources_discovered_at=now(),last_completed_at=case when exists(select 1 from app.sources where epoch=p_epoch and id='liked' and enabled) then last_completed_at else now() end where singleton and epoch=p_epoch;
   perform app.enqueue_sources(p_epoch,true); perform app.refresh_source_pool(p_epoch);
   return jsonb_build_object('done',true);
  end if;
  update app.source_scans set next_offset=0,total=null,received=0,invalid=false,pass=pass+1 where job_id=p_id;
  delete from app.source_discovery_pages where job_id=p_id and (pass<r.pass or not valid);
  delete from app.source_discovery_ids where job_id=p_id and (pass<r.pass or not valid);
  return jsonb_build_object('done',false,'retryMs',case when not valid or r.pass%4=0 then 60000 else 0 end);
 end;
$$;

create or replace function public.app_library_page_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_pass integer,p_offset integer,
 p_total integer,p_received integer,p_next_offset integer,p_rows jsonb,p_unresolved integer,p_head jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare r app.sync_runs; row jsonb; key text; liked timestamptz; observed integer; valid boolean; same boolean; changed boolean:=false; affected integer;
 begin
  perform app.require_owner(p_epoch,true);
  perform app.ensure_sources(p_epoch);
  if not exists(select 1 from app.sources where epoch=p_epoch and id='liked' and enabled) then return jsonb_build_object('done',true); end if;
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='library_sync' and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return null; end if;
  select * into r from app.sync_runs where job_id=p_id and epoch=p_epoch for update;
  if not found or r.completed_at is not null or r.pass<>p_pass or r.next_offset<>p_offset then return null; end if;
  if p_total is null or p_total<0 or p_received is null or p_received not between 0 and 50 or p_unresolved is null or p_unresolved<0
   or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)+p_unresolved+coalesce((p_head->>'skipped')::integer,0)<>p_received
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
   insert into app.source_memberships(epoch,source_id,track_key,added_at) values(p_epoch,'liked',key,liked)
    on conflict(epoch,source_id,track_key) do update set added_at=excluded.added_at;
  end loop;
  update app.sync_runs set reported_total=r.reported_total,received_count=received_count+p_received,skipped_count=skipped_count+coalesce((p_head->>'skipped')::integer,0),invalid_pass=r.invalid_pass,
   next_offset=coalesce(p_next_offset,p_offset+p_received),first_head=case when p_offset=0 then p_head else first_head end
   where id=r.id returning * into r;
  update app.sources set imported_count=r.received_count,track_count=r.reported_total,skipped_count=r.skipped_count where epoch=p_epoch and id='liked';
  if changed then update app.library_state set library_revision=library_revision+1 where singleton and epoch=p_epoch; end if;
  perform app.refresh_source_pool(p_epoch);
  if p_next_offset is not null then return jsonb_build_object('done',false,'retryMs',0); end if;
  select count(*) into observed from app.sync_seen where run_id=r.id and pass=r.pass;
  valid:=not r.invalid_pass and r.received_count=r.reported_total and observed+r.skipped_count=r.reported_total;
  same:=valid and r.prior_valid_pass=r.pass-1 and not exists(
   (select track_key,liked_at from app.sync_seen where run_id=r.id and pass=r.pass
    except select track_key,liked_at from app.sync_seen where run_id=r.id and pass=r.prior_valid_pass)
   union all
   (select track_key,liked_at from app.sync_seen where run_id=r.id and pass=r.prior_valid_pass
    except select track_key,liked_at from app.sync_seen where run_id=r.id and pass=r.pass)
  );
  if same then
   delete from app.source_memberships sm where sm.epoch=p_epoch and sm.source_id='liked'
    and not exists(select 1 from app.sync_seen where run_id=r.id and pass=r.pass and track_key=sm.track_key);
   update app.sources set latest_completed_run_id=r.id,last_synced_at=now(),track_count=r.reported_total,imported_count=r.reported_total,skipped_count=r.skipped_count,error_code=null where epoch=p_epoch and id='liked';
   get diagnostics affected=row_count;
   update app.library_state set initial_sync_complete=true,last_completed_at=now(),completed_run_id=r.id,head_signature=r.first_head,
    library_revision=library_revision+case when affected>0 or not initial_sync_complete or completed_run_id is distinct from r.id then 1 else 0 end where singleton and epoch=p_epoch;
   update app.sync_runs set completed_at=now() where id=r.id;
   delete from app.sync_seen where run_id=r.id;
   perform app.refresh_source_pool(p_epoch);
   return jsonb_build_object('done',true,'retryMs',0);
  end if;
  update app.sync_runs set pass=pass+1,next_offset=0,reported_total=null,received_count=0,skipped_count=0,invalid_pass=false,
   prior_valid_pass=case when valid then r.pass else null end,first_head=null where id=r.id;
  delete from app.sync_seen where run_id=r.id and (pass<r.pass or not valid);
  return jsonb_build_object('done',false,'retryMs',case when not valid or r.pass%4=0 then 60000 else 0 end);
 end;
$$;

create function public.app_source_page_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_offset integer,p_total integer,p_received integer,p_next_offset integer,p_snapshot text,p_rows jsonb,p_skipped integer,p_unresolved integer) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare r app.source_scans; row jsonb; key text; liked timestamptz; old_effective timestamptz; new_effective timestamptz;
 begin
  perform app.require_owner(p_epoch,true);
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='source_sync' and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return null; end if;
  select * into r from app.source_scans where job_id=p_id for update;
  if not found or r.next_offset<>p_offset then return null; end if;
  if not exists(select 1 from app.sources where epoch=p_epoch and id=r.source_id and enabled) then return jsonb_build_object('done',true); end if;
  if p_total is null or p_total<0 or p_received is null or p_received not between 0 and 50 or p_skipped is null or p_skipped<0 or p_unresolved is null or p_unresolved<0
   or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)+p_skipped+p_unresolved<>p_received
   or p_snapshot is null or p_snapshot='' or (p_next_offset is not null and (p_next_offset<>p_offset+p_received or p_received=0)) then raise exception 'invalid_input'; end if;
  if r.snapshot_id is not null and r.snapshot_id<>p_snapshot then raise exception 'stale_revision'; end if;
  for row in select value from jsonb_array_elements(p_rows) loop
   key:=row->>'trackKey';
   liked:=case when coalesce((row->>'addedAtMissing')::boolean,false) then
    coalesce((select added_at from app.source_memberships where epoch=p_epoch and source_id=r.source_id and track_key=key),now())
    else (row->>'likedAt')::timestamptz end;
   liked:=greatest(liked,(select added_at from app.source_seen where job_id=p_id and track_key=key));
   select max(sm.added_at) into old_effective from app.source_memberships sm join app.sources s on s.epoch=sm.epoch and s.id=sm.source_id where sm.epoch=p_epoch and sm.track_key=key and s.enabled;
   select greatest(liked,max(sm.added_at)) into new_effective from app.source_memberships sm join app.sources s on s.epoch=sm.epoch and s.id=sm.source_id where sm.epoch=p_epoch and sm.track_key=key and sm.source_id<>r.source_id and s.enabled;
   if key is null or key !~ '^[0-9a-f]{64}$' or liked is null then raise exception 'invalid_input'; end if;
   insert into app.annotations(track_key,epoch) values(key,p_epoch) on conflict(track_key) do nothing;
   if not exists(select 1 from app.annotations where track_key=key and epoch=p_epoch) then raise exception 'unknown_track'; end if;
   insert into app.track_metadata(track_key,spotify_id,title,artists,album,release_date,duration_ms,explicit,artwork_url,spotify_url,playable_uri,liked_at,added_run_id)
    values(key,row->>'spotifyId',row->>'title',row->'artists',row->>'album',row->>'releaseDate',(row->>'durationMs')::bigint,
     (row->>'explicit')::boolean,row->>'artworkUrl',row->>'spotifyUrl',row->>'playableUri',liked,p_id)
    on conflict(track_key) do update set spotify_id=excluded.spotify_id,title=excluded.title,artists=excluded.artists,album=excluded.album,
     release_date=excluded.release_date,duration_ms=excluded.duration_ms,explicit=excluded.explicit,artwork_url=excluded.artwork_url,spotify_url=excluded.spotify_url,
     playable_uri=excluded.playable_uri,liked_at=case when exists(select 1 from app.source_memberships sm where sm.epoch=p_epoch and sm.source_id='liked' and sm.track_key=excluded.track_key) then app.track_metadata.liked_at else greatest(app.track_metadata.liked_at,excluded.liked_at) end,removed_at=null,
     acknowledged_at=case when app.track_metadata.removed_at is not null or old_effective is distinct from new_effective then null else app.track_metadata.acknowledged_at end,
     added_run_id=case when app.track_metadata.removed_at is not null or old_effective is distinct from new_effective then p_id else app.track_metadata.added_run_id end
    where (app.track_metadata.spotify_id,app.track_metadata.title,app.track_metadata.artists,app.track_metadata.album,app.track_metadata.release_date,
     app.track_metadata.duration_ms,app.track_metadata.explicit,app.track_metadata.artwork_url,app.track_metadata.spotify_url,app.track_metadata.playable_uri,app.track_metadata.liked_at,app.track_metadata.removed_at)
     is distinct from (excluded.spotify_id,excluded.title,excluded.artists,excluded.album,excluded.release_date,excluded.duration_ms,excluded.explicit,excluded.artwork_url,excluded.spotify_url,excluded.playable_uri,excluded.liked_at,null::timestamptz);

   insert into app.source_seen(job_id,track_key,added_at) values(p_id,key,liked) on conflict(job_id,track_key) do update set added_at=greatest(app.source_seen.added_at,excluded.added_at);
   insert into app.source_memberships(epoch,source_id,track_key,added_at) values(p_epoch,r.source_id,key,liked)
    on conflict(epoch,source_id,track_key) do update set added_at=excluded.added_at;
  end loop;
  update app.source_scans set snapshot_id=p_snapshot,total=p_total,received=received+p_received,skipped=skipped+p_skipped,
   invalid=invalid or p_unresolved>0 or (total is not null and total<>p_total),next_offset=coalesce(p_next_offset,p_offset+p_received) where job_id=p_id;
  update app.sources set available=true,error_code=null,imported_count=p_offset+p_received,track_count=p_total where epoch=p_epoch and id=r.source_id;
  update app.library_state set library_revision=library_revision+1 where singleton and epoch=p_epoch;
  perform app.refresh_source_pool(p_epoch);
  return jsonb_build_object('done',false,'terminal',p_next_offset is null);
 end;
$$;
create function public.app_source_finish(p_epoch bigint,p_id uuid,p_lease uuid,p_snapshot text,p_error text default null) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare r app.source_scans; valid boolean;
 begin
  perform app.require_owner(p_epoch,true);
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='source_sync' and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return null; end if;
  select * into r from app.source_scans where job_id=p_id for update;
  if not found then return null; end if;
  if not exists(select 1 from app.sources where epoch=p_epoch and id=r.source_id and enabled) then return jsonb_build_object('done',true); end if;
  if p_error is not null then
   if p_error not in ('forbidden','not_found','response','network') then raise exception 'invalid_input'; end if;
   update app.sources set error_code=p_error,available=case when p_error in ('forbidden','not_found') then false else available end where epoch=p_epoch and id=r.source_id;
   update app.library_state set library_revision=library_revision+1 where singleton and epoch=p_epoch;
   perform app.refresh_source_pool(p_epoch);
   return jsonb_build_object('done',true);
  end if;
  -- Unchanged snapshots avoid all item reads; otherwise validate the complete walk
  -- against both metadata snapshots. Counts alone do not establish a snapshot.
  if r.snapshot_id is null and exists(select 1 from app.sources where epoch=p_epoch and id=r.source_id and snapshot_id=p_snapshot and last_synced_at is not null) then
   if exists(select 1 from app.sources where epoch=p_epoch and id=r.source_id and latest_completed_run_id is distinct from p_id) then
    update app.library_state set library_revision=library_revision+1 where singleton and epoch=p_epoch;
   end if;
   update app.sources set available=true,error_code=null,last_synced_at=now(),latest_completed_run_id=p_id where epoch=p_epoch and id=r.source_id;
   return jsonb_build_object('done',true);
  end if;
  valid:=not r.invalid and r.snapshot_id=p_snapshot and r.received=r.total;
  if valid then
   delete from app.source_memberships sm where sm.epoch=p_epoch and sm.source_id=r.source_id
    and not exists(select 1 from app.source_seen seen where seen.job_id=p_id and seen.track_key=sm.track_key);
   update app.sources set available=true,error_code=null,last_synced_at=now(),latest_completed_run_id=p_id,snapshot_id=p_snapshot,skipped_count=r.skipped,track_count=r.total,imported_count=r.received where epoch=p_epoch and id=r.source_id;
   update app.library_state set library_revision=library_revision+1 where singleton and epoch=p_epoch;
   perform app.refresh_source_pool(p_epoch);
   delete from app.source_seen where job_id=p_id;
   return jsonb_build_object('done',true);
  end if;
  update app.source_scans set next_offset=0,snapshot_id=null,total=null,received=0,skipped=0,invalid=false where job_id=p_id;
  delete from app.source_seen where job_id=p_id;
  update app.sources set error_code='source_changed' where epoch=p_epoch and id=r.source_id;
  return jsonb_build_object('done',false,'retryMs',60000);
 end;
$$;
-- Integrate discovery with the existing ambient/manual/daily scheduling path.
alter function app.start_library_walk(bigint) rename to start_liked_walk;
create function app.start_library_walk(p_epoch bigint) returns uuid language plpgsql set search_path='' as $$
 begin
  perform app.ensure_sources(p_epoch);
  perform app.enqueue_sources(p_epoch,false);
  if exists(select 1 from app.sources where epoch=p_epoch and id='liked' and enabled) then return app.start_liked_walk(p_epoch); end if;
  return null;
 end;
$$;
-- Retain app-open debounce while extending the ambient probe to playlist sources.
alter function public.app_library_sync(bigint,text) rename to app_liked_library_sync;
create function public.app_library_sync(p_epoch bigint,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
 declare due boolean; result jsonb;
 begin
  perform app.require_owner(p_epoch);
  select p_reason='manual' or last_probe_at is null or last_probe_at<=now()-interval '15 minutes' into due from app.library_state where singleton and epoch=p_epoch;
  result:=public.app_liked_library_sync(p_epoch,p_reason);
  if due and exists(select 1 from app.account where singleton and state='connected') then perform app.enqueue_sources(p_epoch,true); end if;
  return app.library_status();
 end;
$$;
-- Refuse disabled Liked Songs before any provider request, including a queued probe.
alter function public.app_library_job_state(bigint,uuid,uuid,text) rename to app_liked_job_state;
create function public.app_library_job_state(p_epoch bigint,p_id uuid,p_lease uuid,p_encrypted_key text) returns jsonb language plpgsql security definer set search_path='' as $$
 declare result jsonb;
 begin
  result:=public.app_liked_job_state(p_epoch,p_id,p_lease,p_encrypted_key);
  if result is null then return null; end if;
  perform app.ensure_sources(p_epoch);
  if not exists(select 1 from app.sources where epoch=p_epoch and id='liked' and enabled) then return result||jsonb_build_object('completed',true); end if;
  return result;
 end;
$$;
alter function app.purge_product_data() rename to purge_before_sources;
create function app.purge_product_data() returns void language plpgsql set search_path='' as $$
 begin
  delete from app.source_scans where epoch<=(select epoch from app.account where singleton);
  delete from app.sources where epoch<=(select epoch from app.account where singleton);
  perform app.purge_before_sources();
 end;
$$;
alter function app.library_status() rename to liked_library_status;
create function app.library_status() returns jsonb language sql stable set search_path='' as $$
 select app.liked_library_status()||jsonb_build_object('sourcesRevision',(select sources_revision::text from app.library_state where singleton),
 'syncPhase',case when exists(select 1 from app.sources where enabled and available and last_synced_at is null) then 'importing'
  when exists(select 1 from app.sources where id='liked' and enabled) then app.liked_library_status()->>'syncPhase' else 'idle' end,
 'importedCount',(select coalesce(sum(imported_count),0) from app.sources where enabled),
 'reportedTotal',(select coalesce(sum(track_count),0) from app.sources where enabled),'activeCount',(select count(*) from app.filter_keys('{"membership":"active","search":"","untagged":false,"newOnly":false}'::jsonb)),
 'newCount',(select count(*) from app.filter_keys('{"membership":"active","search":"","untagged":false,"newOnly":true}'::jsonb)),
 'untaggedCount',(select count(*) from app.filter_keys('{"membership":"active","search":"","untagged":true,"newOnly":false}'::jsonb)));
$$;
alter function app.track_dto(text) rename to track_dto_before_sources;
create function app.track_dto(p_key text) returns jsonb language sql stable set search_path='' as $$
 select jsonb_set(app.track_dto_before_sources(p_key),'{metadata,addedAt}',coalesce(to_jsonb(coalesce((select max(sm.added_at) from app.source_memberships sm join app.sources s on s.epoch=sm.epoch and s.id=sm.source_id where sm.track_key=p_key and s.enabled),(select liked_at from app.track_metadata where track_key=p_key))), 'null'::jsonb))||jsonb_build_object('sources',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'name',s.name) order by s.kind,s.id)
 from app.source_memberships sm join app.sources s on s.epoch=sm.epoch and s.id=sm.source_id where sm.track_key=p_key and s.enabled),'[]'::jsonb));
$$;
-- All state and credentials remain accessible only through fenced service RPCs.
revoke all on app.sources,app.source_memberships,app.source_scans,app.source_seen,app.source_discovery_pages,app.source_discovery_ids from public,anon,authenticated;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('app_sources_list','app_sources_selection','app_sources_sync','app_source_job_state','app_source_discovery_commit','app_source_page_commit','app_source_finish','app_library_job_state','app_liked_job_state','app_library_sync','app_liked_library_sync') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

do $$ declare a app.account; begin
 select * into a from app.account where singleton;
 if a.state='connected' then perform app.enqueue_sources(a.epoch,true); perform app.refresh_source_pool(a.epoch); end if;
end $$;
notify pgrst, 'reload schema';

create function public.app_token_scope_proof(p_epoch bigint) returns text language plpgsql security definer set search_path='' as $$
 begin
  perform app.require_owner(p_epoch);
  return (select encrypted_tokens from app.credentials where singleton and epoch=p_epoch);
 end;
$$;
revoke all on function public.app_token_scope_proof(bigint) from public,anon,authenticated;
grant execute on function public.app_token_scope_proof(bigint) to service_role;
