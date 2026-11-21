-- Accepted November 21 review workflow. All runtime entry points are owner/epoch
-- fenced; playlist POST intent is committed before dispatch and never replayed
-- after an ambiguous response or reclaimed lease. Spotify has no remote fencing.
create table app.review_state (
 epoch bigint primary key,
 session_id uuid not null default gen_random_uuid(),
 revision bigint not null default 0,
 active_id uuid,
 last_id uuid,
 undo_id uuid,
 focus_track text,
 discovered_at timestamptz
);
create table app.review_destinations (
 epoch bigint not null,
 id text not null check(id ~ '^[A-Za-z0-9]{22}$'),
 name text not null,
 artwork_url text,
 owned boolean not null default false,
 available boolean not null default true,
 configured boolean not null default false,
 primary key(epoch,id)
);
create table app.review_drafts (
 epoch bigint not null,
 track_key text not null references app.annotations(track_key) on delete cascade,
 destination_ids jsonb not null default '[]' check(jsonb_typeof(destination_ids)='array'),
 revision bigint not null default 0,
 primary key(epoch,track_key)
);
create table app.review_skips (
 epoch bigint not null,
 session_id uuid not null,
 track_key text not null references app.annotations(track_key) on delete cascade,
 primary key(epoch,session_id,track_key)
);
create table app.review_operations (
 id uuid primary key default gen_random_uuid(),
 epoch bigint not null,
 request_id uuid not null,
 track_key text not null references app.annotations(track_key) on delete cascade,
 uri text not null check(uri ~ '^spotify:track:[A-Za-z0-9]{22}$'),
 kind text not null check(kind in ('done','discard')),
 status text not null default 'queued' check(status in ('queued','adding','unliking','completed','undoing','undone','cancelled','needs_attention')),
 phase text not null default 'adding' check(phase in ('adding','unlike_pending','unlike_sending','unlike_check','restore_pending','restore_sending','restore_check','reversing','terminal')),
 error_code text,
 verification_started_at timestamptz,
 ever_unlike_intent boolean not null default false,
 -- One library command at a time. Only an acknowledged response (or an initial
 -- no-send observation) permits completion; reads cannot settle a lost send.
 library_write_state text not null default 'not_sent' check(library_write_state in ('not_sent','sending','acknowledged','not_needed')),
 library_write_acknowledged_at timestamptz,
 job_id uuid references app.jobs(id) on delete set null,
 undo_request_id uuid,
 reversal_incomplete boolean not null default false,
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 unique(epoch,request_id), unique(epoch,undo_request_id)
);
-- Idempotency receipts retain only local annotation/action identities when an
-- older operation's Spotify-derived URI/snapshot evidence is superseded.
create table app.review_receipts (
 epoch bigint not null, request_id uuid not null, command text not null,
 track_key text, operation_id uuid not null,
 primary key(epoch,request_id)
);
revoke all on app.review_receipts from public,anon,authenticated;
create unique index review_single_active on app.review_operations(epoch) where status in ('queued','adding','unliking','undoing','needs_attention');
create table app.review_operation_items (
 operation_id uuid not null references app.review_operations(id) on delete cascade,
 playlist_id text not null,
 state text not null default 'pending' check(state in ('pending','sending','confirmed','preexisting','unconfirmed','reverse_sending','reverse_check','reversed','reversal_unavailable')),
 snapshot_id text,
 reverse_snapshot_id text,
 primary key(operation_id,playlist_id)
);
create table app.review_memberships (
 epoch bigint not null,
 track_key text not null references app.annotations(track_key) on delete cascade,
 playlist_id text not null,
 status text not null default 'unknown' check(status in ('unknown','checking','present','absent','unavailable')),
 snapshot_id text,
 next_offset integer not null default 0,
 observed integer not null default 0,
 occurrences integer not null default 0,
 total integer,
 error_code text,
 checked_at timestamptz,
 primary key(epoch,track_key,playlist_id)
);
-- Durable exact-URI scan checkpoints. A completed cache is not a freshness
-- proof: observed Spotify metadata snapshots can lag actual item changes.
create table app.review_playlist_cache (
 epoch bigint not null, playlist_id text not null, snapshot_id text not null,
 status text not null check(status in ('checking','ready')),
 next_offset integer not null default 0, observed integer not null default 0, total integer,
 primary key(epoch,playlist_id)
);
create table app.review_playlist_uris (
 epoch bigint not null, playlist_id text not null, uri text not null,
 occurrences integer not null check(occurrences>0),
 primary key(epoch,playlist_id,uri),
 foreign key(epoch,playlist_id) references app.review_playlist_cache(epoch,playlist_id) on delete cascade
);
revoke all on app.review_playlist_cache,app.review_playlist_uris from public,anon,authenticated;
-- No browser role can read Spotify metadata or durable authorization records.
revoke all on app.review_state,app.review_destinations,app.review_drafts,app.review_skips,app.review_operations,app.review_operation_items,app.review_memberships from public,anon,authenticated;

create function app.review_ensure(p_epoch bigint) returns void language sql set search_path='' as $$
 insert into app.review_state(epoch) values(p_epoch) on conflict do nothing;
$$;
create function app.review_current(p_epoch bigint) returns text language sql stable set search_path='' as $$
 select sm.track_key from app.source_memberships sm join app.track_metadata m using(track_key)
 join app.review_state s on s.epoch=sm.epoch
 where sm.epoch=p_epoch and sm.source_id='liked'
 and not exists(select 1 from app.review_skips k where k.epoch=p_epoch and k.session_id=s.session_id and k.track_key=sm.track_key)
 order by (sm.track_key=s.focus_track) desc,sm.added_at,sm.track_key limit 1;
$$;
create function app.review_operation_dto(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',o.id,'trackKey',o.track_key,'kind',o.kind,'status',o.status,'errorCode',o.error_code,
 'completedDestinations',(select count(*) from app.review_operation_items i where i.operation_id=o.id and i.state in ('confirmed','preexisting')),
 'totalDestinations',(select count(*) from app.review_operation_items i where i.operation_id=o.id),'reversalIncomplete',o.reversal_incomplete,
 'canCancel',o.status='needs_attention' and o.phase in ('adding','unlike_pending') and not o.ever_unlike_intent
  and not exists(select 1 from app.review_operation_items i where i.operation_id=o.id and i.state in ('sending','unconfirmed'))
  and not exists(select 1 from app.jobs j where j.id=o.job_id and j.state='running' and j.lease_until>now()))
 from app.review_operations o where o.id=p_id;
$$;
create function app.review_destination_dto(p_epoch bigint,p_key text,p_all boolean default false) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'artworkUrl',d.artwork_url,'spotifyUrl','https://open.spotify.com/playlist/'||d.id,
 'configured',d.configured,'available',(p_all or d.configured) and d.available and d.owned and not exists(select 1 from app.playlists p where p.epoch=d.epoch and p.spotify_id=d.id),
 'membership',coalesce(m.status,'unknown'),'errorCode',case when not d.configured then 'destination_not_configured' when not d.available or not d.owned then 'destination_unavailable' else m.error_code end) order by d.name,d.id),'[]'::jsonb)
 from app.review_destinations d left join app.review_memberships m on m.epoch=d.epoch and m.playlist_id=d.id and m.track_key=p_key
 where d.epoch=p_epoch and (d.configured or coalesce((select destination_ids ? d.id from app.review_drafts where epoch=p_epoch and track_key=p_key),false) or (p_all and d.owned and d.available and not exists(select 1 from app.playlists p where p.epoch=d.epoch and p.spotify_id=d.id)));
$$;
create function app.review_dto(p_epoch bigint) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('sessionId',s.session_id,'revision',s.revision::text,
 'remaining',(select count(*) from app.source_memberships sm where sm.epoch=p_epoch and sm.source_id='liked' and not exists(select 1 from app.review_skips k where k.epoch=p_epoch and k.session_id=s.session_id and k.track_key=sm.track_key)),
 'skipped',(select count(*) from app.review_skips k join app.source_memberships sm on sm.epoch=k.epoch and sm.track_key=k.track_key and sm.source_id='liked' where k.epoch=p_epoch and k.session_id=s.session_id),
 'current',app.track_dto_before_sources(app.review_current(p_epoch)),
 'destinations',app.review_destination_dto(p_epoch,app.review_current(p_epoch)),
 'draft',(select jsonb_build_object('trackKey',d.track_key,'destinationIds',d.destination_ids,'revision',d.revision::text) from app.review_drafts d where d.epoch=p_epoch and d.track_key=app.review_current(p_epoch)),
 'operation',app.review_operation_dto(coalesce(s.active_id,(select id from app.review_operations where id=s.last_id and status='undone'))),'undo',app.review_operation_dto(s.undo_id),
 'syncStatus',case when exists(select 1 from app.sources where epoch=p_epoch and id='liked' and last_synced_at is not null) then 'ready' else 'pending' end,
 'discoveryStatus',case when s.discovered_at is null then 'pending' else 'ready' end)
 from app.review_state s where s.epoch=p_epoch;
$$;
create function app.review_enqueue_checks(p_epoch bigint) returns void language plpgsql set search_path='' as $$
 declare key text:=app.review_current(p_epoch);
 begin
  if key is null or exists(select 1 from app.review_state where epoch=p_epoch and active_id is not null) then return; end if;
  insert into app.review_memberships(epoch,track_key,playlist_id)
   select p_epoch,key,id from app.review_destinations where epoch=p_epoch and configured on conflict do nothing;
  if exists(select 1 from app.review_memberships m join app.review_destinations d on d.epoch=m.epoch and d.id=m.playlist_id where m.epoch=p_epoch and m.track_key=key and d.configured and (m.checked_at is null or m.checked_at<now()-interval '5 minutes'))
   and not exists(select 1 from app.jobs where epoch=p_epoch and kind='review_check' and payload->>'trackKey'=key and state in ('queued','running','parked')) then
   insert into app.jobs(kind,epoch,payload,priority) values('review_check',p_epoch,jsonb_build_object('trackKey',key),7);
  end if;
 end;
$$;
create function public.app_review_get(p_epoch bigint,p_destinations boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
 begin
  perform app.require_owner(p_epoch); perform app.review_ensure(p_epoch);
  if exists(select 1 from app.account where singleton and state='connected') then
   perform app.review_enqueue_checks(p_epoch);
   if not exists(select 1 from app.sources where epoch=p_epoch and id='liked' and last_synced_at is not null) then perform app.start_library_walk(p_epoch); end if;
   if (select discovered_at from app.review_state where epoch=p_epoch) is null then perform app.enqueue_sources(p_epoch,false); end if;
  end if;
  if p_destinations then return jsonb_build_object('revision',(select revision::text from app.review_state where epoch=p_epoch),
   'items',app.review_destination_dto(p_epoch,app.review_current(p_epoch),true),'discoveryStatus',case when (select discovered_at from app.review_state where epoch=p_epoch) is null then 'pending' else 'ready' end); end if;
  return app.review_dto(p_epoch);
 end;
$$;
create function public.app_review_command(p_epoch bigint,p_command text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
 declare s app.review_state; key text; ids jsonb; oid uuid; jid uuid; o app.review_operations; rid uuid; receipt app.review_receipts;
 begin
  perform app.require_owner(p_epoch,true); perform app.review_ensure(p_epoch);
  select * into s from app.review_state where epoch=p_epoch for update;
  if p_command not in ('destinations','draft','session','skip','done','discard','undo','retry','cancel') or jsonb_typeof(p_input) is distinct from 'object' then raise exception 'invalid_input'; end if;
  if p_command in ('done','discard','undo') then
   rid:=(p_input->>'requestId')::uuid;
   select * into receipt from app.review_receipts where epoch=p_epoch and request_id=rid;
   if found then
    if receipt.command<>p_command or (p_command<>'undo' and receipt.track_key is distinct from p_input->>'trackKey') or (p_command='undo' and receipt.operation_id::text is distinct from p_input->>'operationId') then raise exception 'request_conflict'; end if;
    return app.review_dto(p_epoch);
   end if;
  end if;
  if p_command in ('done','discard') then
   rid:=(p_input->>'requestId')::uuid;
   select * into o from app.review_operations where epoch=p_epoch and request_id=rid;
   if found then
    if o.kind<>p_command or o.track_key is distinct from p_input->>'trackKey' then raise exception 'request_conflict'; end if;
    return app.review_dto(p_epoch);
   end if;
  elsif p_command='undo' then
   rid:=(p_input->>'requestId')::uuid;
   select * into o from app.review_operations where epoch=p_epoch and undo_request_id=rid;
   if found then
    if o.id::text is distinct from p_input->>'operationId' then raise exception 'request_conflict'; end if;
    return app.review_dto(p_epoch);
   end if;
  end if;
  if p_input->>'revision' is distinct from s.revision::text then raise exception 'stale_revision'; end if;
  if s.active_id is not null and p_command not in ('retry','cancel') then raise exception 'playlist_busy'; end if;
  key:=p_input->>'trackKey';
  if p_command in ('draft','skip','done','discard') and (key is null or key is distinct from app.review_current(p_epoch)) then raise exception 'unknown_track'; end if;
  if p_command in ('destinations','draft') then
   ids:=p_input->'destinationIds';
   if jsonb_typeof(ids) is distinct from 'array' or jsonb_array_length(ids)>100 or exists(select 1 from jsonb_array_elements_text(ids) x where x !~ '^[A-Za-z0-9]{22}$')
    or (select count(*) from jsonb_array_elements_text(ids))<>(select count(distinct value) from jsonb_array_elements_text(ids)) then raise exception 'invalid_input'; end if;
   if exists(select 1 from jsonb_array_elements_text(ids) x where not exists(select 1 from app.review_destinations d where d.epoch=p_epoch and d.id=x and d.owned and d.available and (p_command='destinations' or d.configured) and not exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=d.id))) then raise exception 'unknown_playlist'; end if;
   if p_command='destinations' then
    -- Drafts survive reconfiguration; removed selected destinations stay visible
    -- in their draft and block Done until the user deliberately edits it.
    update app.review_destinations set configured=ids ? id where epoch=p_epoch;
    delete from app.review_playlist_cache c where c.epoch=p_epoch and not (ids ? c.playlist_id);
    delete from app.review_memberships m where m.epoch=p_epoch and not (ids ? m.playlist_id);
   else
    insert into app.review_drafts(epoch,track_key,destination_ids,revision) values(p_epoch,key,ids,s.revision+1)
     on conflict(epoch,track_key) do update set destination_ids=excluded.destination_ids,revision=excluded.revision;
   end if;
  elsif p_command='session' then
   update app.review_state set session_id=gen_random_uuid(),focus_track=null where epoch=p_epoch;
   delete from app.review_skips where epoch=p_epoch;
  elsif p_command='skip' then
   insert into app.review_skips values(p_epoch,s.session_id,key) on conflict do nothing;
   update app.review_state set focus_track=null where epoch=p_epoch;
  elsif p_command in ('done','discard') then
   if rid is null or (p_command='discard' and p_input->'confirmation' is distinct from 'true'::jsonb) then raise exception 'invalid_input'; end if;
   ids:=coalesce((select destination_ids from app.review_drafts where epoch=p_epoch and track_key=key),'[]');
   if p_command='done' and exists(select 1 from jsonb_array_elements_text(ids) x where not exists(select 1 from app.review_destinations d where d.epoch=p_epoch and d.id=x and d.configured and d.owned and d.available and not exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=d.id))) then raise exception 'unknown_playlist'; end if;
   if p_command='done' then
    -- Already-added destinations express desired memberships even when no new
    -- choices were saved. Freeze their eligible server-side identities along
    -- with explicit draft choices; the worker still starts with fresh scans.
    select coalesce(jsonb_agg(target.id order by target.id),'[]'::jsonb) into ids
     from (select value as id from jsonb_array_elements_text(ids)
      union
      select m.playlist_id from app.review_memberships m join app.review_destinations d on d.epoch=m.epoch and d.id=m.playlist_id
       where m.epoch=p_epoch and m.track_key=key and m.status='present' and d.configured and d.owned and d.available
        and not exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=d.id)) target;
    if jsonb_array_length(ids)=0 then raise exception 'invalid_action'; end if;
   end if;
   insert into app.jobs(kind,epoch,priority) values('review',p_epoch,12) returning id into jid;
   insert into app.review_operations(epoch,request_id,track_key,uri,kind,job_id,phase)
    select p_epoch,rid,key,'spotify:track:'||m.spotify_id,p_command,jid,case when p_command='discard' then 'unlike_pending' else 'adding' end from app.track_metadata m where m.track_key=key returning id into oid;
   if oid is null then raise exception 'unknown_track'; end if;
   insert into app.review_receipts values(p_epoch,rid,p_command,key,oid);
   update app.jobs set payload=jsonb_build_object('operationId',oid) where id=jid;
   if p_command='done' then insert into app.review_operation_items(operation_id,playlist_id) select oid,value from jsonb_array_elements_text(ids); end if;
   update app.review_state set active_id=oid,last_id=oid where epoch=p_epoch;
   -- Every operation starts from fresh membership observations, independently
   -- of the UI's cached membership labels.
   delete from app.review_memberships where epoch=p_epoch and track_key=key;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id in (select value from jsonb_array_elements_text(ids));
   update app.jobs set state='cancelled',lease_token=null,lease_until=null where epoch=p_epoch and kind='review_check' and state in ('queued','running','parked');
  elsif p_command='undo' then
   oid:=(p_input->>'operationId')::uuid;
   if oid is distinct from s.undo_id or rid is null then raise exception 'unknown_action'; end if;
   select * into o from app.review_operations where id=oid and epoch=p_epoch for update;
   if o.status<>'completed' then raise exception 'invalid_action'; end if;
   insert into app.jobs(kind,epoch,payload,priority) values('review',p_epoch,jsonb_build_object('operationId',oid),12) returning id into jid;
   insert into app.review_receipts values(p_epoch,rid,p_command,o.track_key,oid);
   update app.review_operations set status='undoing',phase='restore_pending',library_write_state='not_sent',library_write_acknowledged_at=null,undo_request_id=rid,job_id=jid,error_code=null where id=oid;
   update app.review_state set active_id=oid,last_id=oid where epoch=p_epoch;
   delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id in (select playlist_id from app.review_operation_items where operation_id=oid);
   update app.jobs set state='cancelled',lease_token=null,lease_until=null where epoch=p_epoch and kind='review_check' and state in ('queued','running','parked');
  elsif p_command='cancel' then
   oid:=(p_input->>'operationId')::uuid;
   if oid is distinct from s.active_id then raise exception 'unknown_action'; end if;
   select * into o from app.review_operations where id=oid and epoch=p_epoch for update;
   if (app.review_operation_dto(oid)->>'canCancel')::boolean is distinct from true then raise exception 'invalid_action'; end if;
   -- The durable ever-intent flag must remain false, including across retries.
   -- Keep the saved draft and every confirmed addition; uncertain dispatched
   -- writes never qualify for cancellation.
   update app.review_operations set status='cancelled',phase='terminal' where id=oid;
   update app.jobs set state='cancelled',lease_token=null,lease_until=null where id=o.job_id;
   update app.review_state set active_id=null,last_id=null,focus_track=o.track_key where epoch=p_epoch;
  elsif p_command='retry' then
   oid:=(p_input->>'operationId')::uuid;
   if oid is distinct from s.active_id then raise exception 'unknown_action'; end if;
   select * into o from app.review_operations where id=oid and epoch=p_epoch for update;
   if o.status<>'needs_attention' or o.library_write_state='sending' then raise exception 'invalid_action'; end if;
   update app.review_operations set status=case when o.phase like 'restore_%' then 'undoing' else 'queued' end,error_code=null where id=oid;
   update app.jobs set state='queued',retry_at=now(),last_error=null where id=o.job_id and state<>'running';
   -- An unconfirmed append is deliberately retained. Retry reconciles only.
   delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id in (select playlist_id from app.review_operation_items where operation_id=oid);
   if o.phase='unlike_pending' then update app.review_operations set verification_started_at=clock_timestamp() where id=oid; end if;
  end if;
  update app.review_state set revision=revision+1 where epoch=p_epoch;
  perform app.review_enqueue_checks(p_epoch);
  return app.review_dto(p_epoch);
 end;
$$;
-- Worker state/observations are fenced by the SQL lease. A lease is only a local
-- transaction fence; it cannot cancel a request already dispatched to Spotify.
create function public.app_review_worker(p_epoch bigint,p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 declare j app.jobs; o app.review_operations; key text;
 begin
  perform app.require_owner(p_epoch,true);
  select * into j from app.jobs where id=p_job and epoch=p_epoch and kind in ('review','review_check') and state='running' and lease_token=p_lease and lease_until>now() for update;
  if not found then return null; end if;
  if j.kind='review' then
   select * into o from app.review_operations where job_id=p_job and epoch=p_epoch for update;
   if not found then return null; end if;
   key:=o.track_key;
  else key:=j.payload->>'trackKey'; end if;
  return jsonb_build_object('accountId',(select account_id from app.account where singleton),'trackKey',key,
   'uri',coalesce(o.uri,(select 'spotify:track:'||spotify_id from app.track_metadata where track_key=key)),
   'operation',case when o.id is null then null else to_jsonb(o) end,
   'items',coalesce((select jsonb_agg(to_jsonb(i) order by i.playlist_id) from app.review_operation_items i where i.operation_id=o.id),'[]'),
   'destinations',coalesce((select jsonb_agg(d.id order by d.id) from app.review_destinations d where d.epoch=p_epoch and d.configured and d.owned and d.available and not exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=d.id)),'[]'),
   'cache',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('occurrences',coalesce((select u.occurrences from app.review_playlist_uris u where u.epoch=c.epoch and u.playlist_id=c.playlist_id and u.uri=coalesce(o.uri,(select 'spotify:track:'||spotify_id from app.track_metadata where track_key=key))),0))) from app.review_playlist_cache c where c.epoch=p_epoch),'[]'),
   'memberships',coalesce((select jsonb_agg(to_jsonb(m)) from app.review_memberships m where m.epoch=p_epoch and m.track_key=key),'[]'));
 end;
$$;
create function public.app_review_scan(p_epoch bigint,p_job uuid,p_lease uuid,p_playlist text,p_observation jsonb) returns boolean language plpgsql security definer set search_path='' as $$
 declare worker_state jsonb; key text; old app.review_playlist_cache; target_uri text; row_uri text;
 begin
  worker_state:=public.app_review_worker(p_epoch,p_job,p_lease); if worker_state is null then return false; end if;
  key:=worker_state->>'trackKey';
  if p_playlist !~ '^[A-Za-z0-9]{22}$' or not ((worker_state->'destinations') ? p_playlist or exists(select 1 from app.review_operation_items i where i.operation_id=(worker_state->'operation'->>'id')::uuid and i.playlist_id=p_playlist)) then raise exception 'invalid_input'; end if;
  if p_observation->>'status' not in ('checking','present','absent','unavailable') or (p_observation->>'offset')::integer<0 or (p_observation->>'observed')::integer<0 or (p_observation->>'occurrences')::integer<0 then raise exception 'invalid_input'; end if;
  if jsonb_typeof(p_observation->'uris')='array' then
   select * into old from app.review_playlist_cache where epoch=p_epoch and playlist_id=p_playlist for update;
   if found and old.snapshot_id=p_observation->>'snapshotId' then
    if coalesce((p_observation->>'initial')::boolean,false) and old.status='checking' then return false; end if;
    if not coalesce((p_observation->>'reset')::boolean,false) and old.next_offset<>(p_observation->>'fromOffset')::integer then return false; end if;
   end if;
   if not found or old.snapshot_id is distinct from p_observation->>'snapshotId' or coalesce((p_observation->>'reset')::boolean,false) then
    delete from app.review_playlist_cache where epoch=p_epoch and playlist_id=p_playlist;
    insert into app.review_playlist_cache(epoch,playlist_id,snapshot_id,status) values(p_epoch,p_playlist,p_observation->>'snapshotId','checking');
   end if;
   for row_uri in select value from jsonb_array_elements_text(p_observation->'uris') loop
    if row_uri !~ '^spotify:(track|episode):[A-Za-z0-9]{22}$' then raise exception 'invalid_input'; end if;
    insert into app.review_playlist_uris(epoch,playlist_id,uri,occurrences) values(p_epoch,p_playlist,row_uri,1)
     on conflict(epoch,playlist_id,uri) do update set occurrences=app.review_playlist_uris.occurrences+1;
   end loop;
   update app.review_playlist_cache set status=case when p_observation->>'status' in ('present','absent') then 'ready' else 'checking' end,
    next_offset=(p_observation->>'offset')::integer,observed=(p_observation->>'observed')::integer,total=(p_observation->>'total')::integer where epoch=p_epoch and playlist_id=p_playlist;
  end if;
  insert into app.review_memberships(epoch,track_key,playlist_id,status,snapshot_id,next_offset,observed,occurrences,total,error_code,checked_at)
   values(p_epoch,key,p_playlist,p_observation->>'status',p_observation->>'snapshotId',(p_observation->>'offset')::integer,(p_observation->>'observed')::integer,(p_observation->>'occurrences')::integer,(p_observation->>'total')::integer,p_observation->>'errorCode',case when p_observation->>'status'<>'checking' then clock_timestamp() else null end)
   on conflict(epoch,track_key,playlist_id) do update set status=excluded.status,snapshot_id=excluded.snapshot_id,next_offset=excluded.next_offset,observed=excluded.observed,occurrences=excluded.occurrences,total=excluded.total,error_code=excluded.error_code,checked_at=excluded.checked_at;
  return true;
 end;
$$;
-- Cancel pre-mutation Liked Songs scans under the same account/library lock.
-- A page dispatched earlier cannot commit after these local mutations. The
-- replacement two-pass scan observes remote truth; playlist Sources are untouched.
create function app.review_restart_liked(p_epoch bigint) returns void language plpgsql set search_path='' as $$
 begin
  update app.jobs set state='cancelled',lease_token=null,lease_until=null where epoch=p_epoch and kind in ('library_sync','library_probe') and state in ('queued','running','parked');
  update app.sync_runs set completed_at=coalesce(completed_at,now()) where epoch=p_epoch and completed_at is null;
  perform app.start_library_walk(p_epoch);
 end;
$$;
create function public.app_review_transition(p_epoch bigint,p_job uuid,p_lease uuid,p_event text,p_playlist text default null,p_snapshot text default null,p_error text default null) returns boolean language plpgsql security definer set search_path='' as $$
 declare worker_state jsonb; o app.review_operations; item_row app.review_operation_items;
 begin
  worker_state:=public.app_review_worker(p_epoch,p_job,p_lease); if worker_state is null then return false; end if;
  select * into o from app.review_operations where job_id=p_job and epoch=p_epoch for update;
  if not found then return false; end if;
  if p_playlist is not null then select * into item_row from app.review_operation_items where operation_id=o.id and playlist_id=p_playlist for update; if not found then raise exception 'invalid_input'; end if; end if;
  if p_event='preexisting' then
   if item_row.state<>'pending' or not exists(select 1 from app.review_memberships m where m.epoch=p_epoch and m.track_key=o.track_key and m.playlist_id=p_playlist and m.status='present') then raise exception 'invalid_action'; end if;
   update app.review_operation_items set state='preexisting' where operation_id=o.id and playlist_id=p_playlist;
  elsif p_event='append_intent' then
   if item_row.state<>'pending' or not exists(select 1 from app.review_memberships m where m.epoch=p_epoch and m.track_key=o.track_key and m.playlist_id=p_playlist and m.status='absent' and m.checked_at>now()-interval '1 minute') then raise exception 'invalid_action'; end if;
   if not exists(select 1 from app.review_destinations d where d.epoch=p_epoch and d.id=p_playlist and d.configured and d.owned and d.available) or exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=p_playlist) then raise exception 'unknown_playlist'; end if;
   update app.review_operation_items set state='sending' where operation_id=o.id and playlist_id=p_playlist;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id=p_playlist;
   delete from app.review_memberships where epoch=p_epoch and playlist_id=p_playlist;
   update app.review_operations set status='adding' where id=o.id;
  elsif p_event='append_confirmed' then
   if item_row.state<>'sending' or p_snapshot is null or length(p_snapshot)=0 then raise exception 'invalid_action'; end if;
   update app.review_operation_items set state='confirmed',snapshot_id=p_snapshot where operation_id=o.id and playlist_id=p_playlist;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id=p_playlist;
   delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key and playlist_id=p_playlist;
  elsif p_event='append_uncertain' then
   if item_row.state<>'sending' then raise exception 'invalid_action'; end if;
   update app.review_operation_items set state='unconfirmed' where operation_id=o.id and playlist_id=p_playlist;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id=p_playlist;
   delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key and playlist_id=p_playlist;
  elsif p_event='append_rejected' then
   if item_row.state<>'sending' then raise exception 'invalid_action'; end if;
   update app.review_operation_items set state='pending' where operation_id=o.id and playlist_id=p_playlist;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id=p_playlist;
   delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key and playlist_id=p_playlist;
  elsif p_event in ('unlike_prepare','unlike_intent','unlike_satisfied') then
   if (p_event='unlike_prepare' and o.phase<>'adding') or (p_event in ('unlike_intent','unlike_satisfied') and (o.phase<>'unlike_pending' or o.library_write_state<>'not_sent')) or exists(select 1 from app.review_operation_items where operation_id=o.id and state not in ('confirmed','preexisting','unconfirmed'))
    or exists(select 1 from app.review_operation_items i where i.operation_id=o.id and not exists(select 1 from app.review_destinations d where d.epoch=p_epoch and d.id=i.playlist_id and d.configured and d.owned and d.available and not exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=d.id)))
    or (p_event='unlike_prepare' and exists(select 1 from app.review_operation_items i where i.operation_id=o.id and not exists(select 1 from app.review_memberships m where m.epoch=p_epoch and m.track_key=o.track_key and m.playlist_id=i.playlist_id and m.status='present' and m.checked_at is not null)))
    or (p_event in ('unlike_intent','unlike_satisfied') and exists(select 1 from app.review_operation_items i where i.operation_id=o.id and not exists(select 1 from app.review_memberships m where m.epoch=p_epoch and m.track_key=o.track_key and m.playlist_id=i.playlist_id and m.status='present' and m.checked_at>=o.verification_started_at))) then raise exception 'invalid_action'; end if;
   update app.review_operations set phase=case when p_event='unlike_prepare' then 'unlike_pending' when p_event='unlike_satisfied' then 'unlike_check' else 'unlike_sending' end,status='unliking',
    library_write_state=case when p_event='unlike_intent' then 'sending' when p_event='unlike_satisfied' then 'not_needed' else library_write_state end,
    verification_started_at=case when p_event='unlike_prepare' then clock_timestamp() else verification_started_at end,
    ever_unlike_intent=case when p_event='unlike_intent' then true else ever_unlike_intent end where id=o.id;
   if p_event='unlike_prepare' then
    delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key;
    delete from app.review_playlist_cache where epoch=p_epoch and playlist_id in (select playlist_id from app.review_operation_items where operation_id=o.id);
   end if;
  elsif p_event='unlike_check' then
   if o.phase<>'unlike_sending' or o.library_write_state<>'sending' then raise exception 'invalid_action'; end if;
   update app.review_operations set phase='unlike_check',library_write_state='acknowledged',library_write_acknowledged_at=clock_timestamp() where id=o.id;
  elsif p_event='unlike_rejected' then
   if o.phase<>'unlike_sending' or o.library_write_state<>'sending' then raise exception 'invalid_action'; end if;
   update app.review_operations set phase='unlike_pending',library_write_state='not_sent',verification_started_at=clock_timestamp() where id=o.id;
   delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id in (select playlist_id from app.review_operation_items where operation_id=o.id);
  elsif p_event='completed' then
   if o.phase<>'unlike_check' or o.library_write_state not in ('acknowledged','not_needed') then raise exception 'invalid_action'; end if;
   update app.review_operations set phase='terminal',status='completed',completed_at=now(),error_code=null where id=o.id;
   delete from app.source_memberships where epoch=p_epoch and source_id='liked' and track_key=o.track_key;
   delete from app.review_drafts where epoch=p_epoch and track_key=o.track_key;
   update app.review_state set active_id=null,last_id=o.id,undo_id=o.id,focus_track=null,revision=revision+1 where epoch=p_epoch;
   perform app.refresh_source_pool(p_epoch);
   perform app.review_restart_liked(p_epoch);
   delete from app.review_operations where epoch=p_epoch and id<>o.id and status in ('completed','undone','cancelled');
   perform app.review_enqueue_checks(p_epoch);
  elsif p_event in ('restore_intent','restore_satisfied') then
   if o.phase<>'restore_pending' or o.library_write_state<>'not_sent' or o.id is distinct from (select undo_id from app.review_state where epoch=p_epoch) then raise exception 'invalid_action'; end if;
   update app.review_operations set phase=case when p_event='restore_satisfied' then 'restore_check' else 'restore_sending' end,library_write_state=case when p_event='restore_satisfied' then 'not_needed' else 'sending' end where id=o.id;
  elsif p_event='restore_check' then
   if o.phase<>'restore_sending' or o.library_write_state<>'sending' then raise exception 'invalid_action'; end if;
   update app.review_operations set phase='restore_check',library_write_state='acknowledged',library_write_acknowledged_at=clock_timestamp() where id=o.id;
  elsif p_event='restore_rejected' then
   if o.phase<>'restore_sending' or o.library_write_state<>'sending' then raise exception 'invalid_action'; end if;
   update app.review_operations set phase='restore_pending',library_write_state='not_sent' where id=o.id;
  elsif p_event='restored' then
   if o.phase<>'restore_check' or o.library_write_state not in ('acknowledged','not_needed') or o.status<>'undoing' then raise exception 'invalid_action'; end if;
   update app.review_operations set phase='reversing' where id=o.id;
   insert into app.source_memberships(epoch,source_id,track_key,added_at) values(p_epoch,'liked',o.track_key,now()) on conflict(epoch,source_id,track_key) do nothing;
   perform app.refresh_source_pool(p_epoch);
   perform app.review_restart_liked(p_epoch);
  elsif p_event='reverse_intent' then
   if o.phase<>'reversing' or o.status<>'undoing' or o.id is distinct from (select undo_id from app.review_state where epoch=p_epoch)
    or item_row.state<>'confirmed' or item_row.snapshot_id is null or p_snapshot is distinct from item_row.snapshot_id
    or not exists(select 1 from app.review_memberships m where m.epoch=p_epoch and m.track_key=o.track_key and m.playlist_id=p_playlist
     and m.status='present' and m.occurrences=1 and m.checked_at>now()-interval '1 minute') then raise exception 'invalid_action'; end if;
   if not exists(select 1 from app.review_destinations d where d.epoch=p_epoch and d.id=p_playlist and d.configured and d.owned and d.available)
    or exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=p_playlist) then raise exception 'unknown_playlist'; end if;
   update app.review_operation_items set state='reverse_sending' where operation_id=o.id and playlist_id=p_playlist;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id=p_playlist;
   delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key and playlist_id=p_playlist;
  elsif p_event='reverse_check' then
   if o.phase<>'reversing' or item_row.state<>'reverse_sending' then raise exception 'invalid_action'; end if;
   update app.review_operation_items set state='reverse_check',reverse_snapshot_id=p_snapshot where operation_id=o.id and playlist_id=p_playlist;
   delete from app.review_playlist_cache where epoch=p_epoch and playlist_id=p_playlist;
   delete from app.review_memberships where epoch=p_epoch and track_key=o.track_key and playlist_id=p_playlist;
  elsif p_event='reversed' then
   if o.phase<>'reversing' or item_row.state<>'reverse_check'
    or not exists(select 1 from app.review_memberships m where m.epoch=p_epoch and m.track_key=o.track_key and m.playlist_id=p_playlist
     and m.status='absent' and m.occurrences=0 and m.checked_at>now()-interval '1 minute') then raise exception 'invalid_action'; end if;
   update app.review_operation_items set state='reversed' where operation_id=o.id and playlist_id=p_playlist;
  elsif p_event='reverse_unavailable' then
   if o.phase<>'reversing' or item_row.state not in ('confirmed','unconfirmed','reverse_sending','reverse_check') then raise exception 'invalid_action'; end if;
   update app.review_operation_items set state='reversal_unavailable' where operation_id=o.id and playlist_id=p_playlist;
  elsif p_event='undone' then
   if o.phase<>'reversing' or exists(select 1 from app.review_operation_items where operation_id=o.id and state not in ('preexisting','reversed','reversal_unavailable')) then raise exception 'invalid_action'; end if;
   update app.review_operations set status='undone',phase='terminal',error_code=case when exists(select 1 from app.review_operation_items where operation_id=o.id and state='reversal_unavailable') then 'playlist_reversal_unavailable' end,
    reversal_incomplete=exists(select 1 from app.review_operation_items where operation_id=o.id and state='reversal_unavailable') where id=o.id;
   insert into app.source_memberships(epoch,source_id,track_key,added_at) values(p_epoch,'liked',o.track_key,now()) on conflict(epoch,source_id,track_key) do nothing;
   update app.review_state set active_id=null,last_id=o.id,undo_id=null,focus_track=o.track_key,revision=revision+1 where epoch=p_epoch;
   perform app.refresh_source_pool(p_epoch);
   perform app.review_restart_liked(p_epoch);
   perform app.review_enqueue_checks(p_epoch);
  elsif p_event='attention' then
   if p_error not in ('addition_unconfirmed','destination_unavailable','track_unavailable','membership_changed','spotify_forbidden','spotify_unavailable','library_write_unresolved') then raise exception 'invalid_input'; end if;
   update app.review_operations set status='needs_attention',error_code=p_error where id=o.id;
  else raise exception 'invalid_input'; end if;
  return true;
 end;
$$;
-- Exact-match, durable, current operation capability. No ordinary transport
-- request or browser-supplied flag grants track or curated-playlist writes.
create function public.app_review_authorize(p_epoch bigint,p_job uuid,p_lease uuid,p_operation uuid,p_action text,p_method text,p_path text,p_uri text,p_snapshot text default null) returns boolean language plpgsql security definer set search_path='' as $$
 declare worker_state jsonb; o app.review_operations; pid text;
 begin
  worker_state:=public.app_review_worker(p_epoch,p_job,p_lease); if worker_state is null then return false; end if;
  select * into o from app.review_operations where id=p_operation and job_id=p_job and epoch=p_epoch;
  if not found or o.uri is distinct from p_uri or o.status='needs_attention' or o.id is distinct from (select active_id from app.review_state where epoch=p_epoch) then return false; end if;
  if p_action='unlike' then return o.phase='unlike_sending' and o.library_write_state='sending' and p_method='DELETE' and p_path='/me/library'
   and not exists(select 1 from app.review_operation_items i where i.operation_id=o.id and (not exists(select 1 from app.review_memberships m where m.epoch=p_epoch and m.track_key=o.track_key and m.playlist_id=i.playlist_id and m.status='present' and m.checked_at>=o.verification_started_at)
    or not exists(select 1 from app.review_destinations d where d.epoch=p_epoch and d.id=i.playlist_id and d.configured and d.owned and d.available and not exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=d.id)))); end if;
  if p_action='restore' then return o.phase='restore_sending' and o.library_write_state='sending' and o.status='undoing' and o.id=(select undo_id from app.review_state where epoch=p_epoch) and p_method='PUT' and p_path='/me/library'; end if;
  if p_action='append' and p_method='POST' then
   pid:=substring(p_path from '^/playlists/([A-Za-z0-9]{22})/items$');
   return pid is not null and o.phase='adding' and exists(select 1 from app.review_operation_items where operation_id=o.id and playlist_id=pid and state='sending')
    and exists(select 1 from app.review_destinations where epoch=p_epoch and id=pid and configured and owned and available)
    and not exists(select 1 from app.playlists where epoch=p_epoch and spotify_id=pid);
  end if;
  if p_action='reverse' and p_method='DELETE' then
   pid:=substring(p_path from '^/playlists/([A-Za-z0-9]{22})/items$');
   return pid is not null and o.phase='reversing' and o.status='undoing' and o.id=(select undo_id from app.review_state where epoch=p_epoch)
    and exists(select 1 from app.review_operation_items i where i.operation_id=o.id and i.playlist_id=pid and i.state='reverse_sending' and i.snapshot_id=p_snapshot)
    and exists(select 1 from app.review_destinations d where d.epoch=p_epoch and d.id=pid and d.configured and d.owned and d.available)
    and not exists(select 1 from app.playlists p where p.epoch=p_epoch and p.spotify_id=pid);
  end if;
  return false;
 end;
$$;

-- Liked membership ingestion is independent of its tagging Source switch.
create or replace function public.app_library_page_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_pass integer,p_offset integer,
 p_total integer,p_received integer,p_next_offset integer,p_rows jsonb,p_unresolved integer,p_head jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare r app.sync_runs; row jsonb; key text; liked timestamptz; observed integer; valid boolean; same boolean; changed boolean:=false; affected integer;
 begin
  perform app.require_owner(p_epoch,true);
  perform app.ensure_sources(p_epoch);
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
     -- Becoming liked does not create another shared-pool arrival when a
     -- playlist already keeps this song active. Provisional pages must not
     -- overwrite a verified arrival cohort or its acknowledgment.
     acknowledged_at=case when app.track_metadata.removed_at is not null then null else app.track_metadata.acknowledged_at end,
     added_run_id=case when app.track_metadata.removed_at is not null then r.id else app.track_metadata.added_run_id end
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
create or replace function app.start_library_walk(p_epoch bigint) returns uuid language plpgsql set search_path='' as $$
 begin
  perform app.ensure_sources(p_epoch); perform app.enqueue_sources(p_epoch,false);
  return app.start_liked_walk(p_epoch);
 end;
$$;
create or replace function public.app_library_job_state(p_epoch bigint,p_id uuid,p_lease uuid,p_encrypted_key text) returns jsonb language plpgsql security definer set search_path='' as $$
 begin return public.app_liked_job_state(p_epoch,p_id,p_lease,p_encrypted_key); end;
$$;

-- Discovery presentation is shared, configuration and source contribution are not.
create or replace function public.app_source_discovery_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_offset integer,p_total integer,p_received integer,p_next_offset integer,p_sources jsonb) returns jsonb
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
   insert into app.review_destinations(epoch,id,name,artwork_url,owned,available)
    values(p_epoch,row->>'id',row->>'name',row->>'artworkUrl',coalesce((row->>'owned')::boolean,false),true)
    on conflict(epoch,id) do update set name=excluded.name,artwork_url=excluded.artwork_url,owned=excluded.owned,available=true;
   if not coalesce((row->>'owned')::boolean,false) or is_managed then
    delete from app.review_playlist_cache where epoch=p_epoch and playlist_id=row->>'id';
    delete from app.review_memberships where epoch=p_epoch and playlist_id=row->>'id';
   end if;
   changed:=true;
  end loop;
  -- Compare ordered identity and content/eligibility facts, not expiring image
  -- URLs or editable display names. Display fields still update on every page.
  insert into app.source_discovery_pages values(p_id,r.pass,p_offset,jsonb_build_object('total',p_total,'received',p_received,'sources',
   (select coalesce(jsonb_agg(jsonb_build_object('id',value->'id','total',value->'total','eligible',value->'eligible','owned',value->'owned') order by ordinal),'[]'::jsonb)
    from jsonb_array_elements(p_sources) with ordinality as source(value,ordinal))));
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
   perform app.review_ensure(p_epoch);
   update app.review_state set discovered_at=now() where epoch=p_epoch;
   update app.review_destinations d set available=false where d.epoch=p_epoch and not exists(select 1 from app.source_discovery_ids x where x.job_id=p_id and x.pass=r.pass and x.source_id=d.id);
   delete from app.review_playlist_cache c where c.epoch=p_epoch and not exists(select 1 from app.review_destinations d where d.epoch=p_epoch and d.id=c.playlist_id and d.configured and d.owned and d.available);
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

-- Disabled tagging sources must not evict still-liked review metadata.
create or replace function app.library_maintenance_before_playlists() returns void language plpgsql set search_path='' as $$
 declare a app.account; deleted integer;
 begin
  select * into a from app.account where singleton for share;
  if a.state not in ('connected','reconnect') then return; end if;
  perform 1 from app.library_state where singleton and epoch=a.epoch for update;
  if not found then return; end if;
  delete from app.track_metadata m where m.removed_at<=now()-interval '90 days' and not exists(select 1 from app.source_memberships sm where sm.epoch=a.epoch and sm.source_id='liked' and sm.track_key=m.track_key) and not exists(select 1 from app.review_operations o join app.review_state s on s.epoch=o.epoch where o.track_key=m.track_key and (s.active_id=o.id or s.undo_id=o.id));
  get diagnostics deleted=row_count;
  if deleted>0 then update app.library_state set library_revision=library_revision+1 where singleton and epoch=a.epoch; end if;
  delete from app.page_cursors where expires_at<=now();
  delete from app.tag_actions ta where ta.epoch=a.epoch and not exists(select 1 from app.sessions se where se.token_hash=ta.session_hash and se.epoch=a.epoch and se.expires_at>now());
  delete from app.sync_runs where epoch=a.epoch and completed_at<now()-interval '7 days' and id is distinct from (select latest_run_id from app.library_state where singleton);
  if a.state='connected' and exists(select 1 from app.library_state where singleton and (last_completed_at is null or last_completed_at<=now()-interval '24 hours')) then
   perform app.start_library_walk(a.epoch);
  end if;
 end;
$$;

alter function public.app_playback_track(bigint,text) rename to app_playback_tagging_track;
create function public.app_playback_track(p_epoch bigint,p_track_key text) returns jsonb language plpgsql security definer set search_path='' as $$
 declare result jsonb;
 begin
  perform app.require_owner(p_epoch,true);
  if p_track_key is null or p_track_key !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input'; end if;
  select jsonb_build_object('uri',m.playable_uri,'durationMs',m.duration_ms) into result
   from app.track_metadata m join app.source_memberships sm using(track_key)
   where sm.epoch=p_epoch and sm.source_id='liked' and m.track_key=p_track_key and m.playable_uri is not null and m.duration_ms between 1 and 86400000;
  if result is not null then return result; end if;
  return public.app_playback_tagging_track(p_epoch,p_track_key);
 end;
$$;
alter function app.purge_product_data() rename to purge_before_review;
create function app.purge_product_data() returns void language plpgsql set search_path='' as $$
 begin
  delete from app.review_playlist_cache where epoch<=(select epoch from app.account where singleton);
  delete from app.review_memberships where epoch<=(select epoch from app.account where singleton);
  delete from app.review_skips where epoch<=(select epoch from app.account where singleton);
  delete from app.review_drafts where epoch<=(select epoch from app.account where singleton);
  delete from app.review_receipts where epoch<=(select epoch from app.account where singleton);
  delete from app.review_operations where epoch<=(select epoch from app.account where singleton);
  delete from app.review_destinations where epoch<=(select epoch from app.account where singleton);
  delete from app.review_state where epoch<=(select epoch from app.account where singleton);
  perform app.purge_before_review();
 end;
$$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('app_review_get','app_review_command','app_review_worker','app_review_scan','app_review_transition','app_review_authorize','app_library_job_state','app_library_page_commit','app_source_discovery_commit','app_playback_track','app_playback_tagging_track') loop
  execute 'revoke all on function '||f.signature||' from public,anon,authenticated';
  execute 'grant execute on function '||f.signature||' to service_role';
 end loop;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'review_%' loop
  execute 'revoke all on function '||f.signature||' from public,anon,authenticated';
 end loop;
end $$;
