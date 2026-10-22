-- Synthetic discovery passes only; no provider metadata or credentials.
begin;
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'assertion: %',label; end if; end $$;
select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
do $$
declare scenario text; job_id uuid; lease uuid; baseline jsonb; changed jsonb; result jsonb; source_total integer;
begin
 for scenario in select unnest(array['artwork','name','id','order','track_count','eligibility','source_count','page_boundary']) loop
  update app.jobs set state='done' where id is not null;
  update app.library_state set sources_discovered_at=null where singleton;
  job_id:=gen_random_uuid(); lease:=gen_random_uuid();
  insert into app.jobs(id,epoch,kind,state,lease_token,lease_until) values(job_id,1,'source_discovery','running',lease,now()+interval '1 hour');
  insert into app.source_scans(job_id,epoch) values(job_id,1);
  baseline:=jsonb_build_array(
   jsonb_build_object('id',repeat('x',22),'name','Synthetic first','artworkUrl','https://synthetic.example/old','total',7,'eligible',true),
   jsonb_build_object('id',repeat('y',22),'name','Synthetic second','total',9,'eligible',false));
  result:=public.app_source_discovery_commit(1,job_id,lease,0,2,2,null,baseline);
  perform pg_temp.assert(result->>'done'='false','first discovery pass cannot establish completeness');
  changed:=case scenario
   when 'artwork' then jsonb_set(baseline,'{0,artworkUrl}','"https://synthetic.example/refreshed"')
   when 'name' then jsonb_set(baseline,'{0,name}','"Synthetic renamed"')
   when 'id' then jsonb_set(baseline,'{0,id}',to_jsonb(repeat('z',22)))
   when 'order' then jsonb_build_array(baseline->1,baseline->0)
   when 'track_count' then jsonb_set(baseline,'{0,total}','8')
   when 'eligibility' then jsonb_set(baseline,'{0,eligible}','false')
   when 'source_count' then baseline||jsonb_build_array(jsonb_build_object('id',repeat('z',22),'name','Synthetic third','total',0,'eligible',true))
   else baseline end;
  source_total:=jsonb_array_length(changed);
  if scenario='page_boundary' then
   result:=public.app_source_discovery_commit(1,job_id,lease,0,2,1,1,jsonb_build_array(changed->0));
   perform pg_temp.assert(result->>'done'='false','nonterminal discovery page cannot complete');
   result:=public.app_source_discovery_commit(1,job_id,lease,1,2,1,null,jsonb_build_array(changed->1));
  else
   result:=public.app_source_discovery_commit(1,job_id,lease,0,source_total,source_total,null,changed);
  end if;
  perform pg_temp.assert((result->>'done')::boolean=(scenario in ('artwork','name')),'only presentation changes permit completion: '||scenario);
  perform pg_temp.assert((select (sources_discovered_at is not null)=(scenario in ('artwork','name')) from app.library_state where singleton),'discovery gate matches verified identity: '||scenario);
  if scenario='artwork' then
   perform pg_temp.assert((select artwork_url='https://synthetic.example/refreshed' from app.sources where epoch=1 and id=repeat('x',22)),'artwork still refreshes despite exclusion from signature');
  elsif scenario='name' then
   perform pg_temp.assert((select name='Synthetic renamed' from app.sources where epoch=1 and id=repeat('x',22)),'display name still refreshes despite exclusion from signature');
  end if;
  delete from app.jobs where id=job_id;
 end loop;
end $$;
rollback;
