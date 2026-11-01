-- Sanitized operational facts only. No client roles can access tables or RPC.
create table app.diagnostic_events (
 id bigint generated always as identity primary key,
 created_at timestamptz not null default clock_timestamp(),
 source text not null, event text not null, reason text not null,
 build text not null, request uuid not null, document uuid, playback uuid,
 facts jsonb not null, related_request uuid
);
create index diagnostic_events_time on app.diagnostic_events(created_at);
create table app.diagnostic_budget (
 source text primary key, hour timestamptz not null, used integer not null
);
alter table app.diagnostic_events enable row level security;
alter table app.diagnostic_budget enable row level security;
create function app.diagnostic_cleanup() returns void language plpgsql set search_path='' as $$
 begin
  perform pg_advisory_xact_lock(18401781);
  delete from app.diagnostic_events where created_at < clock_timestamp()-interval '7 days';
  delete from app.diagnostic_budget where hour < date_trunc('hour',clock_timestamp());
 end;
$$;
create function public.app_diagnostic_record(
 p_source text, p_event text, p_reason text, p_build text, p_request uuid,
 p_document uuid, p_playback uuid, p_facts jsonb, p_epoch bigint default null, p_related_request uuid default null
) returns boolean language plpgsql security definer set search_path='' as $$
 declare a app.account; k text; v jsonb; used_count integer; cap integer;
 begin
  -- Match disconnect's lock order. No stale browser write may recreate deleted data.
  select * into a from app.account where singleton for share;
  if a.state not in ('connected','reconnect') or p_epoch is distinct from a.epoch then return false; end if;
  if p_source is null or p_source not in ('browser','api','jobs') or p_event is null or p_reason is null
   or p_build is null or p_build !~ '^[a-f0-9]{40}$' or p_request is null
   or jsonb_typeof(p_facts) is distinct from 'object' or octet_length(p_facts::text)>512 then return false; end if;
  if (p_source='browser' and (p_document is null or p_playback is null or p_event not in
   ('navigation_unresolved','pause_unresolved','holder_retired','pause_confirmed','pause_failed','start_dispatched','start_acknowledged','playing_confirmed','start_failed','sdk_failed','controller_destroyed')))
   or (p_source='api' and p_event not in ('api_failed','playback_api_failed','token_api_failed'))
   or (p_source='jobs' and p_event<>'job_failed') then return false; end if;
  if p_reason not in ('playback_target_unavailable','playback_unconfirmed','playback_service_error','playback_control_unavailable','reconnect','unauthorized','track_unavailable','playback_cooldown','database','guard','none','deadline','invalid_state','different_item','state_rejected','pause_rejected','retired','unavailable','authentication','forbidden','rate_limit','cooldown','quota','network','response','http','not_found','playback_required','control_unavailable','initialization_error','authentication_error','account_error','playback_error','autoplay_failed','device_timeout','connect_timeout','connect_failed','token_timeout','device_invalid','device_disconnected','sdk_unavailable') then return false; end if;
  for k,v in select * from jsonb_each(p_facts) loop
   if k in ('startPending','awaitingProof','accepted','stateSeen','paused','reading') then
    if jsonb_typeof(v)<>'boolean' then return false; end if;
   elsif k in ('apiStatus','upstreamStatus','outgoingStatus') then
    if jsonb_typeof(v)<>'number' then return false; end if;
    if (v::text)::numeric<0 or (v::text)::numeric>599 or trunc((v::text)::numeric)<>(v::text)::numeric then return false; end if;
   elsif k in ('operation','commandPending','dispatches','inFlight','staleReads','nullReads','elapsedMs') then
    if jsonb_typeof(v)<>'number' then return false; end if;
    if (v::text)::numeric<0 or (v::text)::numeric>86400000 or trunc((v::text)::numeric)<>(v::text)::numeric then return false; end if;
   else return false; end if;
  end loop;
  perform app.diagnostic_cleanup();
  cap := case when p_source='browser' then 300 else 100 end;
  insert into app.diagnostic_budget(source,hour,used) values(p_source,date_trunc('hour',clock_timestamp()),1)
   on conflict(source) do update set used=app.diagnostic_budget.used+1
   where app.diagnostic_budget.used<cap returning used into used_count;
  if used_count is null then return false; end if;
  -- The same transaction-wide advisory lock protects both the cap and budget.
  delete from app.diagnostic_events where id in
   (select id from app.diagnostic_events order by id desc offset 4999);
  insert into app.diagnostic_events(source,event,reason,build,request,document,playback,facts,related_request)
   values(p_source,p_event,p_reason,p_build,p_request,p_document,p_playback,p_facts,p_related_request);
  return true;
 end;
$$;
revoke all on function public.app_diagnostic_record(text,text,text,text,uuid,uuid,uuid,jsonb,bigint,uuid) from public,anon,authenticated;
grant execute on function public.app_diagnostic_record(text,text,text,text,uuid,uuid,uuid,jsonb,bigint,uuid) to service_role;
-- Scheduled useful maintenance expires rows even when there are no new events.
alter function app.library_maintenance() rename to library_maintenance_before_diagnostics;
create function app.library_maintenance() returns void language plpgsql set search_path='' as $$
 begin
  perform app.library_maintenance_before_diagnostics();
  perform app.diagnostic_cleanup();
 end;
$$;
create function app.diagnostic_disconnect() returns trigger language plpgsql set search_path='' as $$
 begin
  if new.state in ('disconnecting','disconnected') then
   perform pg_advisory_xact_lock(18401781);
   delete from app.diagnostic_events where id>0;
   delete from app.diagnostic_budget where source in ('browser','api','jobs');
  end if;
  return new;
 end;
$$;
create trigger diagnostic_disconnect after update of state on app.account
 for each row execute function app.diagnostic_disconnect();
revoke all on app.diagnostic_events,app.diagnostic_budget from public,anon,authenticated;
