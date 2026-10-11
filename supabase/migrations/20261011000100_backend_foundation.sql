-- All product state lives outside the exposed schema. Only service-role RPCs cross the boundary.
create schema app;
revoke all on schema app from public, anon, authenticated;
alter default privileges in schema app revoke all on tables from public, anon, authenticated;
alter default privileges in schema app revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

create table app.account (
  singleton boolean primary key default true check (singleton),
  epoch bigint not null default 1,
  account_id text,
  state text not null default 'disconnected' check (state in ('disconnected','connected','reconnect','disconnecting')),
  authorized_at timestamptz,
  authorization_deadline timestamptz,
  bootstrap_consumed boolean not null default false
);
insert into app.account default values;
create table app.credentials (
  singleton boolean primary key references app.account(singleton),
  epoch bigint not null,
  encrypted_tokens text not null,
  access_expires_at timestamptz not null,
  version bigint not null default 1,
  refresh_lease uuid,
  refresh_until timestamptz
);
create table app.sessions (
  token_hash text primary key check (length(token_hash) = 64),
  epoch bigint not null,
  expires_at timestamptz not null
);
create table app.oauth_states (
  state_hash text primary key check (length(state_hash) = 64),
  browser_hash text not null check (length(browser_hash) = 64),
  encrypted_verifier text not null,
  epoch bigint not null,
  expires_at timestamptz not null
);
create table app.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  epoch bigint,
  payload jsonb not null default '{}',
  state text not null default 'queued' check (state in ('queued','running','done','cancelled','parked')),
  priority integer not null default 0,
  retry_at timestamptz not null default now(),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index jobs_due on app.jobs (retry_at, priority desc) where state in ('queued','running');
create table app.runtime_health (
  singleton boolean primary key default true check (singleton),
  jobs_sha text,
  last_scheduler_at timestamptz,
  last_job_at timestamptz,
  last_maintenance_at timestamptz
);
insert into app.runtime_health default values;
create table app.spotify_pacing (
  singleton boolean primary key default true check (singleton),
  next_at timestamptz not null default '-infinity',
  cooldown_until timestamptz not null default '-infinity',
  cooldown_kind text
);
insert into app.spotify_pacing default values;

create function public.app_health() returns jsonb language sql security definer set search_path = '' as $$
 select jsonb_build_object('jobsSha',jobs_sha,'lastSchedulerAt',last_scheduler_at,'lastJobAt',last_job_at)
 from app.runtime_health;
$$;
create function public.app_account_status() returns jsonb language sql security definer set search_path = '' as $$
 select jsonb_build_object('epoch',epoch,'state',state,'bootstrapConsumed',bootstrap_consumed) from app.account;
$$;
create function public.app_oauth_start(p_state_hash text,p_browser_hash text,p_encrypted_verifier text)
 returns bigint language plpgsql security definer set search_path = '' as $$
 declare a app.account;
 begin
  select * into a from app.account for update;
  if a.state = 'disconnecting' then raise exception 'disconnect_pending'; end if;
  delete from app.oauth_states where expires_at <= now();
  if (select count(*) from app.oauth_states) >= 100 then raise exception 'oauth_busy'; end if;
  insert into app.oauth_states values(p_state_hash,p_browser_hash,p_encrypted_verifier,a.epoch,now()+interval '10 minutes');
  return a.epoch;
 end;
$$;
create function public.app_oauth_consume(p_state_hash text,p_browser_hash text) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare s app.oauth_states;
 begin
  delete from app.oauth_states where state_hash=p_state_hash and browser_hash=p_browser_hash
    and expires_at>now() returning * into s;
  if not found then return null; end if;
  if not exists(select 1 from app.account where epoch=s.epoch and state<>'disconnecting') then return null; end if;
  return jsonb_build_object('epoch',s.epoch,'encryptedVerifier',s.encrypted_verifier);
 end;
$$;
create function public.app_connect(p_epoch bigint,p_account_id text,p_encrypted_tokens text,
 p_access_expires_at timestamptz,p_authorized_at timestamptz,p_session_hash text,p_bootstrap boolean default false)
 returns boolean language plpgsql security definer set search_path = '' as $$
 declare a app.account;
 begin
  select * into a from app.account for update;
  if a.epoch<>p_epoch or a.state='disconnecting' then return false; end if;
  if a.account_id is not null and a.account_id<>p_account_id then raise exception 'wrong_account'; end if;
  if p_bootstrap and a.bootstrap_consumed then return false; end if;
  if p_account_id is null or p_account_id='' or p_authorized_at>now()+interval '1 minute'
    or p_authorized_at + interval '6 months' <= now() then raise exception 'invalid_authorization'; end if;
  update app.account set account_id=p_account_id,state='connected',authorized_at=p_authorized_at,
    authorization_deadline=p_authorized_at+interval '6 months',bootstrap_consumed=bootstrap_consumed or p_bootstrap;
  insert into app.credentials(singleton,epoch,encrypted_tokens,access_expires_at)
    values(true,a.epoch,p_encrypted_tokens,p_access_expires_at)
    on conflict(singleton) do update set epoch=excluded.epoch,encrypted_tokens=excluded.encrypted_tokens,
    access_expires_at=excluded.access_expires_at,version=app.credentials.version+1,refresh_lease=null,refresh_until=null;
  if p_session_hash is not null then
    insert into app.sessions values(p_session_hash,a.epoch,now()+interval '30 days');
  end if;
  -- Reconnect revives only the current epoch's parked work; cancelled work never revives.
  update app.jobs set state='queued',retry_at=now(),last_error=null where epoch=a.epoch and state='parked' and last_error='reconnect';
  return true;
 end;
$$;
create function public.app_session(p_token_hash text) returns jsonb language sql security definer set search_path = '' as $$
 select jsonb_build_object('epoch',a.epoch,'state',a.state,'authorizedAt',a.authorized_at,
   'authorizationDeadline',a.authorization_deadline)
 from app.sessions s join app.account a on s.epoch=a.epoch
 where s.token_hash=p_token_hash and s.expires_at>now() and a.state in ('connected','reconnect');
$$;
create function public.app_epoch_active(p_epoch bigint) returns boolean language sql security definer set search_path = '' as $$
 select epoch=p_epoch and state='connected' from app.account;
$$;

-- An expired refresh lease is ambiguous: the provider may have rotated the token before a worker died.
-- Park for reconnect rather than replaying an old refresh token or accepting a late stale response.
create function public.app_token_claim(p_epoch bigint,p_force_version bigint default null) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare a app.account; c app.credentials; lease uuid;
 begin
  select * into a from app.account for update;
  if a.epoch<>p_epoch or a.state<>'connected' then return jsonb_build_object('action','reconnect'); end if;
  select * into c from app.credentials where epoch=p_epoch for update;
  if not found or a.authorization_deadline<=now() or (c.refresh_lease is not null and c.refresh_until<=now()) then
    update app.account set state='reconnect'; delete from app.credentials;
    update app.jobs set state='parked',last_error='reconnect',lease_token=null,lease_until=null where epoch=p_epoch and state in ('queued','running');
    return jsonb_build_object('action','reconnect');
  end if;
  if c.refresh_lease is not null then return jsonb_build_object('action','busy'); end if;
  if c.access_expires_at>now()+interval '60 seconds' and (p_force_version is null or p_force_version<>c.version) then
    return jsonb_build_object('action','cached','encryptedTokens',c.encrypted_tokens,'version',c.version);
  end if;
  lease:=gen_random_uuid();
  update app.credentials set refresh_lease=lease,refresh_until=now()+interval '45 seconds';
  return jsonb_build_object('action','refresh','encryptedTokens',c.encrypted_tokens,'version',c.version,'lease',lease);
 end;
$$;
create function public.app_token_finish(p_epoch bigint,p_lease uuid,p_encrypted_tokens text,p_access_expires_at timestamptz)
 returns boolean language plpgsql security definer set search_path = '' as $$
 begin
  perform 1 from app.account where epoch=p_epoch and state='connected' for update;
  if not found then return false; end if;
  update app.credentials set encrypted_tokens=p_encrypted_tokens,access_expires_at=p_access_expires_at,
    version=version+1,refresh_lease=null,refresh_until=null
    where epoch=p_epoch and refresh_lease=p_lease and refresh_until>now();
  return found;
 end;
$$;
create function public.app_token_fail(p_epoch bigint,p_lease uuid,p_reconnect boolean)
 returns boolean language plpgsql security definer set search_path = '' as $$
 begin
  perform 1 from app.account where epoch=p_epoch and state='connected' for update;
  if not found then return false; end if;
  perform 1 from app.credentials where epoch=p_epoch and refresh_lease=p_lease for update;
  if not found then return false; end if;
  if p_reconnect then
    delete from app.credentials;
    update app.account set state='reconnect';
    update app.jobs set state='parked',last_error='reconnect',lease_token=null,lease_until=null where epoch=p_epoch and state in ('queued','running');
  else
    update app.credentials set refresh_lease=null,refresh_until=null where epoch=p_epoch;
  end if;
  return true;
 end;
$$;
create function public.app_pacing_acquire(p_epoch bigint,p_interval_ms integer) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare p app.spotify_pacing; available timestamptz; t timestamptz;
 begin
  perform 1 from app.account where epoch=p_epoch and state='connected' for share;
  if not found then raise exception 'inactive_epoch'; end if;
  if p_interval_ms<500 or p_interval_ms>60000 then raise exception 'invalid_pacing'; end if;
  select * into p from app.spotify_pacing for update;
  t:=clock_timestamp(); available:=greatest(p.next_at,p.cooldown_until);
  if available>t then return jsonb_build_object('granted',false,'retryAfterMs',ceil(extract(epoch from (available-t))*1000)); end if;
  update app.spotify_pacing set next_at=t+make_interval(secs=>p_interval_ms/1000.0);
  return jsonb_build_object('granted',true,'retryAfterMs',0);
 end;
$$;
create function public.app_pacing_defer(p_epoch bigint,p_retry_ms bigint,p_kind text) returns void
 language plpgsql security definer set search_path = '' as $$
 begin
  perform 1 from app.account where epoch=p_epoch and state='connected' for share;
  if not found then return; end if;
  if p_kind not in ('rate_limit','quota') or p_retry_ms<0 then raise exception 'invalid_cooldown'; end if;
  update app.spotify_pacing set cooldown_until=greatest(cooldown_until,clock_timestamp()+make_interval(secs=>greatest(p_retry_ms,case when p_kind='quota' then 21600000 else 30000 end)/1000.0)),cooldown_kind=p_kind;
 end;
$$;

create function public.app_job_enqueue(p_kind text,p_epoch bigint,p_payload jsonb default '{}',p_priority integer default 0)
 returns uuid language plpgsql security definer set search_path = '' as $$
 declare id uuid;
 begin
  if p_epoch is null and p_kind not in ('scheduler_ping','purge_backups') then raise exception 'invalid_system_job'; end if;
  if p_epoch is not null then
    perform 1 from app.account where epoch=p_epoch and state='connected' for share;
    if not found then raise exception 'inactive_epoch'; end if;
  end if;
  insert into app.jobs(kind,epoch,payload,priority) values(p_kind,p_epoch,p_payload,p_priority) returning app.jobs.id into id;
  return id;
 end;
$$;
create function public.app_job_claim(p_lease_seconds integer default 100) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare j app.jobs; a app.account;
 begin
  if p_lease_seconds<10 or p_lease_seconds>120 then raise exception 'invalid_lease'; end if;
  -- All transactions lock account before work rows, including disconnect.
  select * into a from app.account for share;
  select * into j from app.jobs where retry_at<=now()
    and (state='queued' or (state='running' and lease_until<=now()))
    and (epoch is null or (epoch=a.epoch and a.state='connected'))
    order by priority desc,retry_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update app.jobs set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=now()+make_interval(secs=>p_lease_seconds) where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'kind',j.kind,'epoch',j.epoch,'payload',j.payload,'attempts',j.attempts,'leaseToken',j.lease_token);
 end;
$$;
create function public.app_job_finish(p_id uuid,p_lease uuid,p_outcome text,p_retry_ms bigint default 0,p_error text default null)
 returns boolean language plpgsql security definer set search_path = '' as $$
 declare a app.account;
 begin
  select * into a from app.account for share;
  if p_outcome not in ('done','queued','parked') or p_retry_ms<0 then raise exception 'invalid_outcome'; end if;
  update app.jobs set state=p_outcome,retry_at=now()+make_interval(secs=>p_retry_ms/1000.0),
    lease_token=null,lease_until=null,last_error=p_error
    where id=p_id and lease_token=p_lease and state='running' and lease_until>now()
    and (epoch is null or (epoch=a.epoch and a.state='connected'));
  if not found then return false; end if;
  if p_outcome='done' then update app.runtime_health set last_job_at=now(); end if;
  return true;
 end;
$$;
create function public.app_job_renew(p_id uuid,p_lease uuid) returns boolean
 language plpgsql security definer set search_path = '' as $$
 declare a app.account;
 begin
  select * into a from app.account for share;
  update app.jobs set lease_until=now()+interval '100 seconds'
    where id=p_id and lease_token=p_lease and state='running' and lease_until>now()
    and (epoch is null or (epoch=a.epoch and a.state='connected'));
  return found;
 end;
$$;
create function public.app_maintenance(p_id uuid,p_lease uuid,p_sha text) returns boolean
 language plpgsql security definer set search_path = '' as $$
 begin
  perform 1 from app.jobs where id=p_id and lease_token=p_lease and kind='scheduler_ping' and state='running' and lease_until>now() for update;
  if not found then return false; end if;
  delete from app.sessions where expires_at<=now();
  delete from app.oauth_states where expires_at<=now();
  delete from app.jobs where state in ('done','cancelled') and created_at<now()-interval '7 days';
  update app.runtime_health set jobs_sha=p_sha,last_maintenance_at=now();
  return true;
 end;
$$;
create function public.app_jobs_started(p_sha text) returns void language sql security definer set search_path = '' as $$
 update app.runtime_health set jobs_sha=p_sha;
$$;

-- Later feature migrations extend this purge transaction with their tables. Keep the account
-- epoch tombstone; immutable owner identity is configured server-side, outside product data.
create function app.purge_product_data() returns void language sql set search_path = '' as $$
 delete from app.credentials;
 delete from app.sessions;
 delete from app.oauth_states;
$$;
create function public.app_disconnect(p_epoch bigint) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare a app.account; job_id uuid;
 begin
  select * into a from app.account for update;
  if a.epoch<>p_epoch or a.state not in ('connected','reconnect') then return null; end if;
  update app.account set epoch=epoch+1,state='disconnecting',account_id=null,authorized_at=null,authorization_deadline=null;
  update app.jobs set state='cancelled',lease_token=null,lease_until=null,payload='{}',last_error=null
    where epoch is not null;
  perform app.purge_product_data();
  insert into app.jobs(kind,payload,priority) values('purge_backups',jsonb_build_object('epoch',a.epoch+1),1000) returning id into job_id;
  return jsonb_build_object('epoch',a.epoch+1,'jobId',job_id);
 end;
$$;
create function public.app_disconnect_finish(p_epoch bigint) returns boolean
 language plpgsql security definer set search_path = '' as $$
 begin
  update app.account set state='disconnected' where epoch=p_epoch and state='disconnecting';
  return found;
 end;
$$;

-- RLS is defense in depth. Only explicitly granted service RPCs can reach these tables.
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
