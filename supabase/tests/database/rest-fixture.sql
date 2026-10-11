-- Disposable local PostgREST fixtures only. Never included in a migration/deployment.
-- These narrow setup operations let HTTP tests exercise expired leases without sleeping.
create table app.rest_guard_probe (id integer primary key, value integer not null);
insert into app.rest_guard_probe values (1,0);
create function public.app_test_unsafe_update() returns void
language sql security definer set search_path='' as $$
 update app.rest_guard_probe set value=1;
$$;
create function public.app_test_unsafe_delete() returns void
language sql security definer set search_path='' as $$
 delete from app.rest_guard_probe;
$$;
create function public.app_test_fixture(p_action text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_action='reset_pacing' then
  update app.spotify_pacing set next_at='-infinity',cooldown_until='-infinity',cooldown_kind=null where singleton;
 elsif p_action='expire_refresh' then
  update app.credentials set refresh_until=now()-interval '1 second' where singleton and refresh_lease is not null;
 elsif p_action='expire_authorization' then
  update app.account set authorization_deadline=now()-interval '1 second' where singleton;
 elsif p_action='scheduler' then
  -- Exercises the same guarded SQL as cron; actual scheduled delivery is tested separately.
  perform app.scheduler_tick();
 elsif p_action not in ('ready','inspect') then
  raise exception 'invalid_fixture_action';
 end if;
 return jsonb_build_object(
  'guardUntouched',exists(select 1 from app.rest_guard_probe where id=1 and value=0),
  'credentials',exists(select 1 from app.credentials),
  'sessions',(select count(*) from app.sessions),
  'oauthStates',(select count(*) from app.oauth_states),
  'accountJobs',(select count(*) from app.jobs where epoch is not null),
  'maintenanceRecorded',exists(select 1 from app.runtime_health where last_maintenance_at is not null)
 );
end;
$$;
revoke all on function public.app_test_unsafe_update(), public.app_test_unsafe_delete(), public.app_test_fixture(text) from public, anon, authenticated;
grant execute on function public.app_test_unsafe_update(), public.app_test_unsafe_delete(), public.app_test_fixture(text) to service_role;
notify pgrst, 'reload schema';
