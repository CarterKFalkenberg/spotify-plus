-- Execute only on a disposable Supabase stack after both migrations. No live credentials.
-- Rollback prevents synthetic Vault secrets or pg_net requests from leaving this transaction.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean, label text) returns void language plpgsql as $$
 begin if ok is distinct from true then raise exception 'assertion_failed: %',label; end if; end;
$$;
select pg_temp.assert(exists(select 1 from storage.buckets where id='annotation-backups' and not public),'annotation bucket is private');
select pg_temp.assert(exists(select 1 from cron.job where jobname='spotify-plus-due-work' and schedule='* * * * *' and command='select app.scheduler_tick()' and active),'minute scheduler installed');
select pg_temp.assert(not has_function_privilege('anon','app.scheduler_tick()','EXECUTE') and not has_function_privilege('authenticated','app.scheduler_tick()','EXECUTE'),'clients cannot invoke scheduler');
select vault.create_secret('http://127.0.0.1:1','spotify_plus_project_url');
select vault.create_secret('synthetic-local-cron-secret-not-a-credential','spotify_plus_cron_secret');
select app.scheduler_tick();
select pg_temp.assert(exists(select 1 from app.runtime_health where last_scheduler_at=now()),'scheduler heartbeat recorded');
select pg_temp.assert(exists(select 1 from app.jobs where kind='scheduler_ping' and state='queued'),'scheduler queues due maintenance');
select pg_temp.assert(exists(select 1 from net.http_request_queue where url='http://127.0.0.1:1/functions/v1/jobs' and headers->>'x-cron-secret'='synthetic-local-cron-secret-not-a-credential'),'pg_net uses secret fetched by Vault name');
create temporary table vendor_snapshot as select public.app_job_claim() as job;
select pg_temp.assert(public.app_maintenance((job->>'id')::uuid,(job->>'leaseToken')::uuid,repeat('a',40)),'maintenance accepts current lease') from vendor_snapshot;
select pg_temp.assert(public.app_job_finish((job->>'id')::uuid,(job->>'leaseToken')::uuid,'done'),'maintenance completion recorded') from vendor_snapshot;
select pg_temp.assert(exists(select 1 from app.runtime_health where jobs_sha=repeat('a',40) and last_job_at=now()),'jobs SHA tied to actual maintenance');
create temporary table vendor_queue_count as select count(*) as n from net.http_request_queue;
select app.scheduler_tick();
select pg_temp.assert((select count(*) from net.http_request_queue)=(select n from vendor_queue_count),'no duplicate invocation when maintenance is not due');
rollback;
