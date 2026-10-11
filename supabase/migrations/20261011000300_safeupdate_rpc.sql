-- PostgREST sessions load safeupdate, including statements inside SECURITY DEFINER RPCs.
-- Keep the guard enabled. Qualify singleton writes and fence account/token writes by epoch/lease.
-- CREATE OR REPLACE preserves the deployed function grants and transaction boundaries.
-- Disconnect has already advanced the locked account epoch before purging sessions/OAuth state;
-- remove only that cancelled generation and earlier generations, never a future connection.
-- Contract: https://github.com/eradman/pg-safeupdate

create or replace function public.app_connect(p_epoch bigint,p_account_id text,p_owner_fingerprint text,p_initial_owner_verified boolean,p_encrypted_tokens text,
 p_access_expires_at timestamptz,p_authorized_at timestamptz,p_session_hash text,p_bootstrap boolean default false)
 returns boolean language plpgsql security definer set search_path = '' as $$
 declare a app.account;
 begin
  select * into a from app.account for update;
  if a.epoch is distinct from p_epoch or a.state='disconnecting' then return false; end if;
  if (a.owner_fingerprint is null and p_initial_owner_verified is distinct from true)
    or (a.owner_fingerprint is not null and a.owner_fingerprint<>p_owner_fingerprint)
    or p_owner_fingerprint is null or length(p_owner_fingerprint)<>64 then raise exception 'wrong_account'; end if;
  if p_bootstrap and (a.bootstrap_consumed or a.state<>'disconnected' or a.owner_fingerprint is not null) then return false; end if;
  if p_account_id is null or p_account_id='' or p_authorized_at is null or p_authorized_at>now()+interval '1 minute'
    or p_authorized_at + interval '6 months' <= now() then raise exception 'invalid_authorization'; end if;
  update app.account set account_id=p_account_id,owner_fingerprint=p_owner_fingerprint,state='connected',authorized_at=p_authorized_at,
    authorization_deadline=p_authorized_at+interval '6 months',bootstrap_consumed=bootstrap_consumed or p_bootstrap
    where singleton and epoch=p_epoch;
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

create or replace function public.app_token_claim(p_epoch bigint,p_force_version bigint default null) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare a app.account; c app.credentials; lease uuid;
 begin
  select * into a from app.account for update;
  if a.epoch is distinct from p_epoch or a.state<>'connected' then return jsonb_build_object('action','reconnect'); end if;
  select * into c from app.credentials where epoch=p_epoch for update;
  if not found or a.authorization_deadline<=now() or (c.refresh_lease is not null and c.refresh_until<=now()) then
    update app.account set state='reconnect' where singleton and epoch=p_epoch;
    delete from app.credentials where singleton and epoch=p_epoch;
    update app.jobs set state='parked',last_error='reconnect',lease_token=null,lease_until=null where epoch=p_epoch and state in ('queued','running');
    return jsonb_build_object('action','reconnect');
  end if;
  if c.refresh_lease is not null then return jsonb_build_object('action','busy'); end if;
  if c.access_expires_at>now()+interval '60 seconds' and (p_force_version is null or p_force_version<>c.version) then
    return jsonb_build_object('action','cached','encryptedTokens',c.encrypted_tokens,'version',c.version);
  end if;
  if exists(select 1 from app.spotify_pacing where cooldown_until>now()) then
    return (select jsonb_build_object('action','cooldown','retryAfterMs',ceil(extract(epoch from(cooldown_until-now()))*1000)) from app.spotify_pacing);
  end if;
  lease:=gen_random_uuid();
  update app.credentials set refresh_lease=lease,refresh_until=now()+interval '45 seconds' where singleton and epoch=p_epoch;
  return jsonb_build_object('action','refresh','encryptedTokens',c.encrypted_tokens,'version',c.version,'lease',lease);
 end;
$$;

create or replace function public.app_token_fail(p_epoch bigint,p_lease uuid,p_reconnect boolean,p_retry_ms bigint default 0)
 returns boolean language plpgsql security definer set search_path = '' as $$
 begin
  perform 1 from app.account where epoch=p_epoch and state='connected' for update;
  if not found then return false; end if;
  perform 1 from app.credentials where epoch=p_epoch and refresh_lease=p_lease for update;
  if not found then return false; end if;
  if p_reconnect then
    delete from app.credentials where singleton and epoch=p_epoch and refresh_lease=p_lease;
    update app.account set state='reconnect' where singleton and epoch=p_epoch;
    update app.jobs set state='parked',last_error='reconnect',lease_token=null,lease_until=null where epoch=p_epoch and state in ('queued','running');
  else
    if p_retry_ms>0 then perform public.app_pacing_defer(p_epoch,p_retry_ms,'rate_limit'); end if;
    update app.credentials set refresh_lease=null,refresh_until=null where epoch=p_epoch;
  end if;
  return true;
 end;
$$;

create or replace function public.app_pacing_acquire(p_epoch bigint,p_interval_ms integer) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare p app.spotify_pacing; available timestamptz; t timestamptz;
 begin
  perform 1 from app.account where epoch=p_epoch and state<>'disconnecting' for share;
  if not found then raise exception 'inactive_epoch'; end if;
  if p_interval_ms<500 or p_interval_ms>60000 then raise exception 'invalid_pacing'; end if;
  select * into p from app.spotify_pacing for update;
  t:=clock_timestamp(); available:=greatest(p.next_at,p.cooldown_until);
  if available>t then return jsonb_build_object('granted',false,'retryAfterMs',ceil(extract(epoch from (available-t))*1000)); end if;
  update app.spotify_pacing set next_at=t+make_interval(secs=>p_interval_ms/1000.0) where singleton;
  return jsonb_build_object('granted',true,'retryAfterMs',0);
 end;
$$;

create or replace function public.app_pacing_defer(p_epoch bigint,p_retry_ms bigint,p_kind text) returns void
 language plpgsql security definer set search_path = '' as $$
 begin
  perform 1 from app.account where epoch=p_epoch and state<>'disconnecting' for share;
  if not found then return; end if;
  if p_kind not in ('rate_limit','quota') or p_retry_ms<0 then raise exception 'invalid_cooldown'; end if;
  update app.spotify_pacing set cooldown_until=greatest(cooldown_until,clock_timestamp()+make_interval(secs=>greatest(p_retry_ms,case when p_kind='quota' then 21600000 else 30000 end)/1000.0)),cooldown_kind=p_kind where singleton;
 end;
$$;

create or replace function public.app_job_finish(p_id uuid,p_lease uuid,p_outcome text,p_retry_ms bigint default 0,p_error text default null)
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
  if p_outcome='done' then update app.runtime_health set last_job_at=now() where singleton; end if;
  return true;
 end;
$$;

create or replace function public.app_maintenance(p_id uuid,p_lease uuid,p_sha text) returns boolean
 language plpgsql security definer set search_path = '' as $$
 begin
  perform 1 from app.jobs where id=p_id and lease_token=p_lease and kind='scheduler_ping' and state='running' and lease_until>now() for update;
  if not found then return false; end if;
  delete from app.sessions where expires_at<=now();
  delete from app.oauth_states where expires_at<=now();
  delete from app.jobs where state in ('done','cancelled') and created_at<now()-interval '7 days';
  update app.runtime_health set jobs_sha=p_sha,last_maintenance_at=now() where singleton;
  return true;
 end;
$$;

create or replace function public.app_jobs_started(p_sha text) returns void language sql security definer set search_path = '' as $$
 update app.runtime_health set jobs_sha=p_sha where singleton;
$$;

create or replace function app.purge_product_data() returns void language sql set search_path = '' as $$
 delete from app.credentials where singleton;
 delete from app.sessions where epoch <= (select epoch from app.account where singleton);
 delete from app.oauth_states where epoch <= (select epoch from app.account where singleton);
$$;

create or replace function public.app_disconnect(p_epoch bigint) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare a app.account; job_id uuid;
 begin
  select * into a from app.account for update;
  if a.epoch is distinct from p_epoch or a.state not in ('connected','reconnect') then return null; end if;
  update app.account set epoch=epoch+1,state='disconnecting',account_id=null,authorized_at=null,authorization_deadline=null where singleton and epoch=p_epoch;
  update app.jobs set state='cancelled',lease_token=null,lease_until=null,payload='{}',last_error=null
    where epoch is not null;
  perform app.purge_product_data();
  delete from app.jobs where epoch is not null;
  insert into app.jobs(kind,payload,priority) values('purge_backups',jsonb_build_object('epoch',a.epoch+1),1000) returning id into job_id;
  return jsonb_build_object('epoch',a.epoch+1,'jobId',job_id);
 end;
$$;

create or replace function app.scheduler_tick() returns void language plpgsql security definer set search_path='' as $$
 declare project_url text; cron_secret text;
 begin
  update app.runtime_health set last_scheduler_at=now() where singleton;
  -- A useful maintenance job expires sessions/state and bounds finished-job retention.
  if not exists(select 1 from app.jobs where kind='scheduler_ping' and state in ('queued','running'))
    and exists(select 1 from app.runtime_health where last_maintenance_at is null or last_maintenance_at<now()-interval '15 minutes') then
    insert into app.jobs(kind) values('scheduler_ping');
  end if;
  if not exists(select 1 from app.jobs j cross join app.account a where j.retry_at<=now()
    and (j.state='queued' or (j.state='running' and j.lease_until<=now()))
    and (j.epoch is null or (j.epoch=a.epoch and a.state='connected'))) then return; end if;
  select decrypted_secret into project_url from vault.decrypted_secrets where name='spotify_plus_project_url';
  select decrypted_secret into cron_secret from vault.decrypted_secrets where name='spotify_plus_cron_secret';
  -- Deployment configures these names. Until then cron is inert, never unauthenticated.
  if project_url is null or cron_secret is null then return; end if;
  perform net.http_post(url:=project_url||'/functions/v1/jobs',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',cron_secret),
    body:='{}'::jsonb,timeout_milliseconds:=5000);
 end;
$$;

notify pgrst, 'reload schema';
