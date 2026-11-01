begin;
update app.account set state='connected' where singleton;
do $$
 declare e bigint; ok boolean; n integer;
 begin
  select epoch into e from app.account where singleton;
  if has_function_privilege('anon','public.app_diagnostic_record(text,text,text,text,uuid,uuid,uuid,jsonb,bigint,uuid)','execute') or has_function_privilege('authenticated','public.app_diagnostic_record(text,text,text,text,uuid,uuid,uuid,jsonb,bigint,uuid)','execute') then raise exception 'diagnostics publicly executable'; end if;
  if has_table_privilege('anon','app.diagnostic_events','select') or has_table_privilege('authenticated','app.diagnostic_events','insert') then raise exception 'diagnostics publicly accessible'; end if;
  if public.app_diagnostic_record('browser','pause_failed','deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{"uri":"private"}',e) then raise exception 'arbitrary context accepted'; end if;
  if public.app_diagnostic_record('browser','private','deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}',e) then raise exception 'arbitrary event accepted'; end if;
  if public.app_diagnostic_record('browser','pause_failed','private',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}',e) then raise exception 'arbitrary reason accepted'; end if;
  if public.app_diagnostic_record('browser','pause_failed','deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{"dispatches":1.5}',e) then raise exception 'fraction accepted'; end if;
  if public.app_diagnostic_record('browser','pause_failed','deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}',e-1) then raise exception 'stale owner accepted'; end if;
  if not public.app_diagnostic_record('browser','pause_failed','deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{"dispatches":3,"paused":false}',e) then raise exception 'valid facts rejected'; end if;
  if not public.app_diagnostic_record('browser','start_failed','startup_deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{"awaitingProof":true}',e) then raise exception 'startup deadline reason rejected'; end if;
  if not public.app_diagnostic_record('browser','holder_retired','teardown_rejected',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{"startPending":false}',e) then raise exception 'teardown rejection reason rejected'; end if;
  for n in 4..300 loop
   perform public.app_diagnostic_record('browser','pause_failed','deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}',e);
  end loop;
  if public.app_diagnostic_record('browser','pause_failed','deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}',e) then raise exception 'budget exceeded'; end if;
  update app.diagnostic_budget set hour=now()-interval '1 hour' where source='browser';
  if not public.app_diagnostic_record('browser','pause_failed','deadline',repeat('a',40),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}',e) then raise exception 'hour rollover failed'; end if;
  insert into app.diagnostic_events(source,event,reason,build,request,facts)
   select 'api','api_failed','unavailable',repeat('a',40),gen_random_uuid(),'{}' from generate_series(1,5000);
  perform public.app_diagnostic_record('api','api_failed','unavailable',repeat('a',40),gen_random_uuid(),null,null,'{}',e);
  if (select count(*) from app.diagnostic_events)<>5000 then raise exception 'row cap failed'; end if;
  update app.diagnostic_events set created_at=now()-interval '8 days' where id>0;
  perform app.diagnostic_cleanup();
  if exists(select 1 from app.diagnostic_events) then raise exception 'retention failed'; end if;
  perform public.app_diagnostic_record('api','api_failed','unavailable',repeat('a',40),gen_random_uuid(),null,null,'{}',e);
  perform public.app_disconnect(e);
  if exists(select 1 from app.diagnostic_events) or exists(select 1 from app.diagnostic_budget) then raise exception 'disconnect did not purge diagnostics'; end if;
  perform public.app_disconnect_finish(e+1);
  perform public.app_connect(e+1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),false);
  if public.app_diagnostic_record('api','api_failed','unavailable',repeat('a',40),gen_random_uuid(),null,null,'{}',e) then raise exception 'delayed server write after reconnect accepted'; end if;
  if public.app_diagnostic_record('api','api_failed','unavailable',repeat('a',40),gen_random_uuid(),null,null,'{}') then raise exception 'missing epoch accepted'; end if;
  perform public.app_disconnect(e+1);
  if public.app_diagnostic_record('api','api_failed','unavailable',repeat('a',40),gen_random_uuid(),null,null,'{}') then raise exception 'disconnected write accepted'; end if;
 end;
$$;
rollback;
