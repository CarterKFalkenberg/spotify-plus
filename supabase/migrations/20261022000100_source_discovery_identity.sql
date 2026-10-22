-- Volatile playlist presentation must not prevent a verified discovery pass.
-- Existing in-flight old-format pages require another matching new-format pass.
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
   changed:=true;
  end loop;
  -- Compare ordered identity and content/eligibility facts, not expiring image
  -- URLs or editable display names. Display fields still update on every page.
  insert into app.source_discovery_pages values(p_id,r.pass,p_offset,jsonb_build_object('total',p_total,'received',p_received,'sources',
   (select coalesce(jsonb_agg(jsonb_build_object('id',value->'id','total',value->'total','eligible',value->'eligible') order by ordinal),'[]'::jsonb)
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
