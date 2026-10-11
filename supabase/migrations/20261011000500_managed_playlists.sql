-- Private snapshot playlists. All mutations serialize on the library owner lock,
-- then the playlist/job rows; a remote write is never its own completion proof.
create table app.playlist_state (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 0,
 last_cleanup_at timestamptz
);
insert into app.playlist_state default values;
create table app.playlists (
 id uuid primary key default gen_random_uuid(), epoch bigint not null,
 name text not null, spotify_id text unique check(spotify_id ~ '^[A-Za-z0-9]{22}$'),
 query jsonb not null, retention text not null check(retention in ('week','month','threeMonths','pinned')),
 expires_on date, track_count integer not null check(track_count>0),
 status text not null check(status in ('pending','ready','incomplete','removing','removed')),
 revision bigint not null default 1, active_operation uuid,
 blocked_by text check(blocked_by in ('reconnect','rateLimited','quota','unavailable')),
 created_at timestamptz not null default now(), last_checked_at timestamptz
);
create table app.playlist_operations (
 id uuid primary key default gen_random_uuid(), playlist_id uuid not null references app.playlists(id),
 epoch bigint not null, kind text not null check(kind in ('create','regenerate','extend','pin','unpin','delete','expire','reconcile')),
 retention text not null check(retention in ('week','month','threeMonths','pinned')),
 query jsonb not null, target text[] not null, labels jsonb not null, job_id uuid not null unique,
 create_attempted boolean not null default false, scan jsonb,
 state text not null default 'active' check(state in ('active','stalled','done')),
 failures integer not null default 0, last_error text,
 created_at timestamptz not null default now()
);
create table app.playlist_requests (
 request_id uuid primary key, epoch bigint not null, intent jsonb not null,
 playlist_id uuid not null references app.playlists(id), response jsonb not null
);
create table app.playlist_cursors (
 token text primary key, epoch bigint not null, revision bigint not null,
 offset_value integer not null check(offset_value>=0), expires_at timestamptz not null
);

create function app.playlist_expiry(p_at timestamptz,p_retention text) returns date
 language plpgsql immutable set search_path='' as $$
 declare d date := (p_at at time zone 'America/New_York')::date;
 begin
  case p_retention
   when 'week' then return d+7;
   when 'month' then return (d+interval '1 month')::date;
   when 'threeMonths' then return (d+interval '3 months')::date;
   when 'pinned' then return null;
   else raise exception 'invalid_input';
  end case;
 end;
$$;
create function app.playlists_changed() returns void language sql set search_path='' as $$
 update app.playlist_state s set revision=s.revision+1 where s.singleton=true;
$$;
create function app.playlist_labels(p_node jsonb) returns jsonb language plpgsql stable set search_path='' as $$
 declare v jsonb := '{}'; child jsonb; label text;
 begin
  if p_node->>'op'='tag' then
   select t.name into label from app.tags t where t.id=(p_node->>'tagId')::uuid;
   return jsonb_build_object(p_node->>'tagId',coalesce(label,'Deleted tag'));
  elsif p_node->>'op'='not' then return app.playlist_labels(p_node->'child');
  else
   for child in select value from jsonb_array_elements(p_node->'children') loop
    v:=v||app.playlist_labels(child);
   end loop;
   return v;
  end if;
 end;
$$;
create function app.playlist_dto(p app.playlists) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'revision',p.revision::text,'name',p.name,
  'spotifyUrl',case when p.spotify_id is null then null else 'https://open.spotify.com/playlist/'||p.spotify_id end,
  'query',p.query,'retention',p.retention,'createdAt',p.created_at,'expiresOn',p.expires_on,
  'trackCount',p.track_count,'status',case when p.status='removed' then 'removing' else p.status end,
  'blockedBy',case when a.state='reconnect' then 'reconnect' else p.blocked_by end)
 from app.account a where a.singleton=true;
$$;
create function app.playlist_operation(p_playlist uuid,p_kind text,p_retention text,p_target text[],p_labels jsonb)
 returns uuid language plpgsql set search_path='' as $$
 declare p app.playlists; op uuid := gen_random_uuid(); j uuid := gen_random_uuid();
 begin
  select * into strict p from app.playlists q where q.id=p_playlist for update;
  insert into app.jobs(id,kind,epoch,payload,priority)
   values(j,'playlist',p.epoch,jsonb_build_object('operationId',op),case when p_kind in ('expire','reconcile') then 40 else 100 end);
  insert into app.playlist_operations(id,playlist_id,epoch,kind,retention,query,target,labels,job_id)
   values(op,p.id,p.epoch,p_kind,p_retention,p.query,p_target,p_labels,j);
  update app.playlists q set active_operation=op,revision=q.revision+1,blocked_by=null,
   track_count=case when p_kind='regenerate' then cardinality(p_target) else q.track_count end,
   status=case when p_kind in ('delete','expire') then 'removing' when p_kind='reconcile' then q.status else 'pending' end
   where q.id=p.id;
  perform app.playlists_changed();
  return op;
 end;
$$;
create function public.app_playlist_create(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare p app.playlists; r app.playlist_requests; target text[]; response jsonb;
 begin
  perform app.require_owner(p_epoch,true);
  select * into r from app.playlist_requests x where x.request_id=(p_request->>'requestId')::uuid;
  if found then
   if r.epoch<>p_epoch or r.intent<>p_request then raise exception 'request_conflict'; end if;
   return r.response;
  end if;
  perform app.require_revision(p_request->'previewRevision');
  if not exists(select 1 from app.library_state s where s.singleton=true and s.initial_sync_complete) then
   raise exception 'initial_sync_incomplete';
  end if;
  perform app.validate_query(p_request->'query');
  select array_agg(q.playable_uri order by q.liked_at desc,q.track_key) into target
   from app.query_targets(p_request->'query') q where q.playable_uri is not null;
  if coalesce(cardinality(target),0)=0 then raise exception 'no_playable_matches'; end if;
  if exists(select 1 from unnest(target) uri where uri !~ '^spotify:track:[A-Za-z0-9]{22}$') then raise exception 'invalid_input'; end if;
  if p_request->>'name' is null or length(p_request->>'name') not between 1 and 100 then raise exception 'invalid_input'; end if;
  perform app.playlist_expiry(now(),p_request->>'retention');
  insert into app.playlists(epoch,name,query,retention,expires_on,track_count,status)
   values(p_epoch,p_request->>'name',p_request->'query',p_request->>'retention',app.playlist_expiry(now(),p_request->>'retention'),cardinality(target),'pending') returning * into p;
  perform app.playlist_operation(p.id,'create',p.retention,target,app.playlist_labels(p.query->'root'));
  select * into p from app.playlists q where q.id=p.id;
  response:=jsonb_build_object('requestId',p_request->>'requestId','playlist',app.playlist_dto(p));
  insert into app.playlist_requests values((p_request->>'requestId')::uuid,p_epoch,p_request,p.id,response);
  return response;
 end;
$$;
create function public.app_playlist_action(p_epoch bigint,p_id uuid,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare p app.playlists; op app.playlist_operations; r app.playlist_requests;
  intent jsonb := p_request||jsonb_build_object('playlistId',p_id); action text := p_request->>'action';
  retention text; target text[] := '{}'; response jsonb;
 begin
  perform app.require_owner(p_epoch,true);
  select * into r from app.playlist_requests x where x.request_id=(p_request->>'requestId')::uuid;
  if found then
   if r.epoch<>p_epoch or r.intent<>intent then raise exception 'request_conflict'; end if;
   return r.response;
  end if;
  select * into p from app.playlists q where q.id=p_id and q.epoch=p_epoch for update;
  if not found or p.status='removed' then raise exception 'unknown_playlist'; end if;
  if p.revision::text is distinct from p_request->>'expectedRevision' then raise exception 'stale_revision'; end if;
  if action='retry' then
   select * into op from app.playlist_operations x where x.id=p.active_operation for update;
   if not found or p.status<>'incomplete' or op.state='done'
    or exists(select 1 from app.jobs j where j.id=op.job_id and j.state='running' and j.lease_until>now()) then raise exception 'playlist_busy'; end if;
   update app.playlist_operations x set state='active',failures=0,last_error=null,scan=null where x.id=op.id;
   update app.jobs j set state='queued',retry_at=now(),attempts=0,last_error=null,lease_token=null,lease_until=null where j.id=op.job_id;
   update app.playlists q set status=case when op.kind in ('delete','expire') then 'removing' else 'pending' end,
    revision=q.revision+1,blocked_by=null where q.id=p.id;
   perform app.playlists_changed();
  else
   if p.active_operation is not null then
    -- Explicit Delete may cancel a queued/parked incomplete attempt. Never
    -- supersede a live lease or resume the old frozen write after removal.
    select * into op from app.playlist_operations x where x.id=p.active_operation for update;
    if action<>'delete' or p.status<>'incomplete' or p.spotify_id is null
     or exists(select 1 from app.jobs j where j.id=op.job_id and j.state='running' and j.lease_until>clock_timestamp()) then
     raise exception 'playlist_busy';
    end if;
    update app.jobs j set state='cancelled',lease_token=null,lease_until=null where j.id=op.job_id;
    update app.playlist_operations x set state='done',scan=null,target='{}',labels='{}' where x.id=op.id;
   end if;
   if action not in ('extend','unpin','pin','regenerate','delete') or action is null then raise exception 'invalid_input'; end if;
   if (action='unpin' and p.retention<>'pinned') or (action='extend' and p.retention='pinned')
    or (action='pin' and p.retention='pinned') then raise exception 'invalid_action'; end if;
   retention:=case when action='pin' then 'pinned' when action in ('extend','unpin') then p_request->>'retention' else p.retention end;
   if action in ('extend','unpin') and retention not in ('week','month','threeMonths') then raise exception 'invalid_input'; end if;
   perform app.playlist_expiry(now(),retention);
   if action='regenerate' then
    if not exists(select 1 from app.library_state s where s.singleton=true and s.initial_sync_complete) then raise exception 'initial_sync_incomplete'; end if;
    perform app.validate_query(p.query);
    select array_agg(q.playable_uri order by q.liked_at desc,q.track_key) into target from app.query_targets(p.query) q where q.playable_uri is not null;
    if coalesce(cardinality(target),0)=0 then raise exception 'no_playable_matches'; end if;
   end if;
   perform app.playlist_operation(p.id,action,retention,target,app.playlist_labels(p.query->'root'));
  end if;
  select * into p from app.playlists q where q.id=p_id;
  response:=jsonb_build_object('requestId',p_request->>'requestId','playlist',app.playlist_dto(p));
  insert into app.playlist_requests values((p_request->>'requestId')::uuid,p_epoch,intent,p.id,response);
  return response;
 end;
$$;
-- A success timestamp covers the entire cleanup pass, including work deferred
-- behind a manual operation. Pending/failed expiry cannot be hidden by another
-- playlist finishing successfully or by the scheduler's bounded batch size.
create function app.playlist_cleanup_pending(p_epoch bigint) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from app.playlists p where p.epoch=p_epoch and p.status<>'removed'
  and (p.expires_on<(now() at time zone 'America/New_York')::date
   or (p.status='ready' and (p.last_checked_at is null or p.last_checked_at<now()-interval '1 day'))))
 or exists(select 1 from app.playlist_operations o where o.epoch=p_epoch and o.kind in ('expire','reconcile','delete') and o.state<>'done');
$$;
create function public.app_playlist_list(p_epoch bigint,p_cursor text default null,p_limit integer default 50) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare s app.playlist_state; c app.playlist_cursors; n integer; off integer:=0; token text; rows jsonb; block text;
 begin
  perform app.require_owner(p_epoch,false);
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'invalid_input'; end if;
  select * into strict s from app.playlist_state x where x.singleton=true;
  if p_cursor is not null then
   select * into c from app.playlist_cursors x where x.token=p_cursor and x.epoch=p_epoch and x.expires_at>now();
   if not found or c.revision<>s.revision then raise exception 'stale_revision'; end if;
   off:=c.offset_value;
  end if;
  select count(*) into n from app.playlists p where p.epoch=p_epoch and p.status<>'removed';
  select coalesce(jsonb_agg(app.playlist_dto(q) order by q.created_at desc,q.id),'[]') into rows
   from (select p.* from app.playlists p where p.epoch=p_epoch and p.status<>'removed' order by p.created_at desc,p.id limit p_limit offset off) q;
  if off+p_limit<n then
   token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
   insert into app.playlist_cursors values(token,p_epoch,s.revision,off+p_limit,now()+interval '30 minutes');
  end if;
  select case when a.state='reconnect' then 'reconnect' else
   (select p.blocked_by from app.playlists p join app.playlist_operations o on o.id=p.active_operation
    where p.epoch=p_epoch and (o.kind in ('expire','reconcile','delete') or p.expires_on<(now() at time zone 'America/New_York')::date)
    and p.blocked_by is not null order by o.created_at limit 1) end
   into block from app.account a where a.singleton=true;
  return jsonb_build_object('playlists',rows,'nextCursor',token,'lastCleanupAt',s.last_cleanup_at,'cleanupBlockedBy',block);
 end;
$$;

-- The same guard authorizes the adapter and every checkpoint. Renewal happens
-- before EACH network call, and no response can commit after disconnect/re-lease.
create function app.playlist_lease(p_job uuid,p_lease uuid) returns app.playlist_operations
 language plpgsql set search_path='' as $$
 declare a app.account; j app.jobs; op app.playlist_operations;
 begin
  select * into a from app.account x where x.singleton=true for share;
  if a.state<>'connected' then return null; end if;
  perform app.require_owner(a.epoch,true);
  select * into j from app.jobs x where x.id=p_job and x.epoch=a.epoch and x.kind='playlist'
   and x.state='running' and x.lease_token=p_lease and x.lease_until>clock_timestamp() for update;
  if not found then return null; end if;
  select * into op from app.playlist_operations x where x.job_id=p_job and x.epoch=a.epoch and x.state='active' for update;
  if not found then return null; end if;
  perform 1 from app.playlists p where p.id=op.playlist_id and p.active_operation=op.id and p.status<>'removed' for update;
  if not found then return null; end if;
  return op;
 end;
$$;
create function public.app_playlist_work(p_job uuid,p_lease uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare op app.playlist_operations; p app.playlists;
 begin
  op:=app.playlist_lease(p_job,p_lease); if op.id is null then return null; end if;
  select * into strict p from app.playlists x where x.id=op.playlist_id;
  return jsonb_build_object('id',p.id,'action',op.kind,'spotifyId',p.spotify_id,'name',p.name,
   'query',op.query,'labels',op.labels,'retention',op.retention,'target',to_jsonb(op.target),
   'createAttempted',op.create_attempted,'scan',op.scan);
 end;
$$;
create function public.app_playlist_fence(p_job uuid,p_lease uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
 declare op app.playlist_operations;
 begin
  op:=app.playlist_lease(p_job,p_lease); if op.id is null then return false; end if;
  return public.app_job_renew(p_job,p_lease);
 end;
$$;
create function public.app_playlist_managed(p_epoch bigint,p_spotify_id text) returns boolean
 language sql security definer set search_path='' as $$
 select exists(select 1 from app.playlists p join app.account a on a.epoch=p.epoch
  where p.epoch=p_epoch and a.singleton=true and a.state='connected' and p.spotify_id=p_spotify_id and p.status<>'removed');
$$;
create function public.app_playlist_checkpoint(p_job uuid,p_lease uuid,p_patch jsonb) returns boolean
 language plpgsql security definer set search_path='' as $$
 declare op app.playlist_operations; p app.playlists;
 begin
  op:=app.playlist_lease(p_job,p_lease); if op.id is null then return false; end if;
  select * into strict p from app.playlists x where x.id=op.playlist_id;
  if p_patch ? 'spotifyId' then
   if op.kind<>'create' or p_patch->>'spotifyId' is null or p_patch->>'spotifyId' !~ '^[A-Za-z0-9]{22}$'
    or (p.spotify_id is not null and p.spotify_id<>p_patch->>'spotifyId') then raise exception 'invalid_input'; end if;
   update app.playlists x set spotify_id=p_patch->>'spotifyId',revision=x.revision+1 where x.id=p.id;
   perform app.playlists_changed();
  end if;
  update app.playlist_operations x set
   create_attempted=case when p_patch ? 'createAttempted' then (p_patch->>'createAttempted')::boolean else x.create_attempted end,
   scan=case when p_patch ? 'scan' then nullif(p_patch->'scan','null'::jsonb) else x.scan end where x.id=op.id;
  return true;
 end;
$$;
create function public.app_playlist_complete(p_job uuid,p_lease uuid,p_expires_on date,p_name text,p_removed boolean default false) returns boolean
 language plpgsql security definer set search_path='' as $$
 declare op app.playlist_operations;
 begin
  op:=app.playlist_lease(p_job,p_lease); if op.id is null then return false; end if;
  if p_removed is null then raise exception 'invalid_input'; end if;
  if not p_removed and op.kind<>'reconcile' and p_expires_on is distinct from app.playlist_expiry(clock_timestamp(),op.retention) then
   -- Midnight crossed during disclosure verification: retry against the new date.
   raise exception 'remote_changed';
  end if;
  if not p_removed and op.kind in ('delete','expire') then raise exception 'invalid_input'; end if;
  update app.playlists p set name=p_name,revision=p.revision+1,blocked_by=null,active_operation=null,last_checked_at=now(),
   status=case when p_removed then 'removed' else 'ready' end,
   retention=case when op.kind='reconcile' or p_removed then p.retention else op.retention end,
   expires_on=case when op.kind='reconcile' or p_removed then p.expires_on else p_expires_on end,
   track_count=case when op.kind in ('create','regenerate') and not p_removed then cardinality(op.target) else p.track_count end
   where p.id=op.playlist_id;
  update app.playlist_operations x set state='done',scan=null,target='{}',labels='{}',last_error=null where x.id=op.id;
  if op.kind in ('expire','reconcile','delete') and not app.playlist_cleanup_pending(op.epoch) then
   update app.playlist_state s set last_cleanup_at=now() where s.singleton=true;
  end if;
  perform app.playlists_changed();
  return true;
 end;
$$;
create function public.app_playlist_failed(p_job uuid,p_lease uuid,p_error text,p_retry_ms bigint) returns boolean
 language plpgsql security definer set search_path='' as $$
 declare op app.playlist_operations; block text; park boolean; failure_count integer;
 begin
  op:=app.playlist_lease(p_job,p_lease); if op.id is null then return false; end if;
  if p_error not in ('creation_unknown','duplicate_marker','description_capacity','remote_changed','removal_unconfirmed','invalid_work',
   'guard','authentication','forbidden','not_found','rate_limit','quota','cooldown','control_unavailable','network','response','http','unavailable') then p_error:='unavailable'; end if;
  block:=case when p_error='authentication' then 'reconnect' when p_error='quota' then 'quota'
   when p_error in ('rate_limit','cooldown') then 'rateLimited' else 'unavailable' end;
  failure_count:=op.failures+case when p_error in ('rate_limit','quota','cooldown') then 0 else 1 end;
  park:=failure_count>=5 or p_error in ('creation_unknown','duplicate_marker','description_capacity','invalid_work','guard','forbidden');
  -- Removal/reconciliation must recover unattended after provider outages.
  -- Their reads and playlist-only DELETE can be retried without replaying POST.
  if op.kind in ('delete','expire','reconcile') and p_error not in ('invalid_work','guard') then park:=false; end if;
  update app.playlist_operations x set failures=failure_count,last_error=p_error,state=case when park then 'stalled' else x.state end where x.id=op.id;
  update app.playlists p set status='incomplete',revision=p.revision+1,blocked_by=block where p.id=op.playlist_id;
  if park or p_error='authentication' then
   update app.jobs j set state='parked',lease_token=null,lease_until=null,last_error=case when p_error='authentication' then 'reconnect' else 'playlist_retry' end
    where j.id=p_job and j.lease_token=p_lease;
  end if;
  perform app.playlists_changed();
  return true;
 end;
$$;
create function public.app_playlist_schedule() returns boolean language plpgsql security definer set search_path='' as $$
 declare a app.account; p app.playlists; op app.playlist_operations;
 begin
  select * into a from app.account x where x.singleton=true for share;
  if a.state<>'connected' then return false; end if;
  perform app.require_owner(a.epoch,true);
  delete from app.playlist_cursors c where c.expires_at<=now();
  for p in select x.* from app.playlists x where x.epoch=a.epoch and
   ((x.status='ready' and x.active_operation is null and
     (x.expires_on<(now() at time zone 'America/New_York')::date or x.last_checked_at is null or x.last_checked_at<now()-interval '1 day'))
    or (x.status='incomplete' and x.spotify_id is not null and x.expires_on<(now() at time zone 'America/New_York')::date
      and exists(select 1 from app.playlist_operations o where o.id=x.active_operation and o.kind not in ('delete','expire','reconcile'))))
   order by x.created_at limit 100 for update loop
   if p.active_operation is not null then
    select * into op from app.playlist_operations o where o.id=p.active_operation for update;
    perform 1 from app.jobs j where j.id=op.job_id for update;
    if exists(select 1 from app.jobs j where j.id=op.job_id and j.state='running' and j.lease_until>clock_timestamp()) then continue; end if;
    update app.jobs j set state='cancelled',lease_token=null,lease_until=null where j.id=op.job_id;
    update app.playlist_operations o set state='done',scan=null,target='{}',labels='{}' where o.id=op.id;
   end if;
   perform app.playlist_operation(p.id,case when p.expires_on<(now() at time zone 'America/New_York')::date then 'expire' else 'reconcile' end,p.retention,'{}','{}');
  end loop;
  if not app.playlist_cleanup_pending(a.epoch) then
   update app.playlist_state s set last_cleanup_at=now() where s.singleton=true;
  end if;
  return true;
 end;
$$;

-- Operational correlation only: no URL, body, headers, owner or provider data.
-- Primary pg_net API returns bigint and accepts timeout_milliseconds integer:
-- https://supabase.com/docs/guides/database/extensions/pg_net
create table app.cron_dispatches (
 request_id bigint primary key,
 dispatched_at timestamptz not null default clock_timestamp()
);
create index cron_dispatches_retention on app.cron_dispatches(dispatched_at);
alter table app.cron_dispatches enable row level security;
revoke all on app.cron_dispatches from public,anon,authenticated;
-- The private schema is not exposed by PostgREST. Operators correlate these
-- bounded records with net._http_response; app_health exposes neither field.
create or replace function app.scheduler_tick() returns void language plpgsql security definer set search_path='' as $$
 declare project_url text; cron_secret text; dispatch_request_id bigint;
 begin
  update app.runtime_health h set last_scheduler_at=now() where h.singleton=true;
  delete from app.cron_dispatches d where d.dispatched_at<now()-interval '7 days';
  if not exists(select 1 from app.jobs j where j.kind='scheduler_ping' and j.state in ('queued','running'))
    and exists(select 1 from app.runtime_health h where h.last_maintenance_at is null or h.last_maintenance_at<now()-interval '15 minutes') then
    insert into app.jobs(kind) values('scheduler_ping');
  end if;
  if not exists(select 1 from app.jobs j cross join app.account a where j.retry_at<=now()
    and (j.state='queued' or (j.state='running' and j.lease_until<=now()))
    and (j.epoch is null or (j.epoch=a.epoch and a.state='connected'))) then return; end if;
  select v.decrypted_secret into project_url from vault.decrypted_secrets v where v.name='spotify_plus_project_url';
  select v.decrypted_secret into cron_secret from vault.decrypted_secrets v where v.name='spotify_plus_cron_secret';
  if project_url is null or cron_secret is null then return; end if;
  -- The response must be observable after the bounded 80-second jobs drain.
  dispatch_request_id:=net.http_post(url:=project_url||'/functions/v1/jobs',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',cron_secret),
    body:='{}'::jsonb,timeout_milliseconds:=90000);
  insert into app.cron_dispatches(request_id) values(dispatch_request_id);
 end;
$$;
revoke all on function app.scheduler_tick() from public,anon,authenticated,service_role;

-- Keep the existing cron entrypoint and its account -> library -> job locks.
alter function app.library_maintenance() rename to library_maintenance_before_playlists;
create function app.library_maintenance() returns void language plpgsql set search_path='' as $$
 begin
  perform app.library_maintenance_before_playlists();
  perform public.app_playlist_schedule();
 end;
$$;

alter function app.purge_product_data() rename to purge_library_data;
create function app.purge_product_data() returns void language plpgsql set search_path='' as $$
 begin
  delete from app.playlist_requests r where r.request_id is not null;
  delete from app.playlist_cursors c where c.token is not null;
  delete from app.playlist_operations o where o.id is not null;
  delete from app.playlists p where p.id is not null;
  update app.playlist_state s set revision=s.revision+1,last_cleanup_at=null where s.singleton=true;
  perform app.purge_library_data();
 end;
$$;
do $$ declare t text; f record; begin
 foreach t in array array['playlist_state','playlists','playlist_operations','playlist_requests','playlist_cursors'] loop
  execute format('alter table app.%I enable row level security',t);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'app_playlist_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

notify pgrst, 'reload schema';
