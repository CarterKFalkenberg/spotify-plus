-- Owner-only lookup for the narrowly scoped queue playback command.
create function public.app_playback_track(p_epoch bigint,p_track_key text) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb;
 begin
  perform app.require_owner(p_epoch,true);
  if p_track_key is null or p_track_key !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input'; end if;
  select jsonb_build_object('uri',m.playable_uri,'durationMs',m.duration_ms) into result
   from app.track_metadata m join app.annotations a using(track_key)
   where m.track_key=p_track_key and a.epoch=p_epoch and m.removed_at is null
    and m.playable_uri is not null and m.duration_ms>0 and m.duration_ms<=86400000;
  return result;
 end;
$$;
revoke all on function public.app_playback_track(bigint,text) from public,anon,authenticated;
grant execute on function public.app_playback_track(bigint,text) to service_role;
