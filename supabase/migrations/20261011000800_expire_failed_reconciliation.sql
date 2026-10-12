-- Expiry supersedes failed reconciliation once its lease is no longer live.
-- Keep playlist-only removal retryable; never cancel an actively leased worker.
create or replace function public.app_playlist_schedule() returns boolean language plpgsql security definer set search_path='' as $$
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
      and exists(select 1 from app.playlist_operations o where o.id=x.active_operation and o.kind not in ('delete','expire'))))
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
