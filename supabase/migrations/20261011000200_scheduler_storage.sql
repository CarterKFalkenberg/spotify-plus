-- Primary contract: https://supabase.com/docs/guides/functions/schedule-functions
-- Supabase-hosted extensions; the standalone PostgreSQL test harness tests foundation separately.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('annotation-backups','annotation-backups',false,5242880,array['application/octet-stream'])
 on conflict(id) do update set public=false;
-- No storage.objects policy grants app clients access. Runtime service role alone uses this bucket.

create function app.scheduler_tick() returns void language plpgsql security definer set search_path='' as $$
 declare project_url text; cron_secret text;
 begin
  update app.runtime_health set last_scheduler_at=now();
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
revoke all on function app.scheduler_tick() from public,anon,authenticated,service_role;
select cron.schedule('spotify-plus-due-work','* * * * *','select app.scheduler_tick()');
