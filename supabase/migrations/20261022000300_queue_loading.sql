-- A queue freezes opaque identities once, not metadata or a mutable search cursor.
-- No persistent session queue or Spotify requests are needed.
create function public.app_queue_tracks(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare keys text[]; rows jsonb;
 begin
  perform app.require_owner(p_epoch);
  select array_agg(value order by ord) into keys from jsonb_array_elements_text(p_request->'trackKeys') with ordinality v(value,ord);
  if cardinality(keys) is null or cardinality(keys) not between 1 and 100
   or cardinality(keys)<>(select count(distinct k) from unnest(keys) k)
   or exists(select 1 from unnest(keys) k where k !~ '^[a-f0-9]{64}$') then raise exception 'invalid_input'; end if;
  -- Resolve each captured identity to its currently eligible representative. A
  -- split only follows the captured identity's component; it admits no new branch.
  -- The requested identity remains the queue slot while mutations use the DTO key.
  select coalesce(jsonb_agg(jsonb_build_object('key',v.key,'track',app.track_dto(m.track_key)) order by v.ord),'[]') into rows
   from unnest(keys) with ordinality v(key,ord)
   join app.annotations a on a.track_key=v.key and a.epoch=p_epoch
   join app.track_metadata m on m.track_key=app.song_representative(v.key)
   where m.removed_at is null;
  return jsonb_build_object('revision',app.library_revision(),'entries',rows);
 end;
$$;
create function public.app_queue_snapshot(p_epoch bigint,p_request jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare keys text[]; selected text[]; sorting text:=p_request->>'sort'; seed text:=p_request->>'seed'; result jsonb;
 begin
  perform app.require_owner(p_epoch);
  if sorting is null or sorting not in ('newest','oldest','title','artist','album','year','random')
   or (sorting='random')<>(seed is not null) then raise exception 'invalid_input'; end if;
  if p_request ? 'selection' then selected:=app.selection_keys(p_epoch,p_request->'selection'); end if;
  -- Account locking in require_owner makes selection revision, manifest and the
  -- first useful metadata batch one atomic capture.
  select coalesce(array_agg(track_key order by ord),'{}') into keys from (
   select k.track_key,row_number() over(order by
    case when sorting='oldest' then k.liked_at end asc,
    case when sorting='newest' then k.liked_at end desc,
    case sorting when 'title' then lower(normalize(m.title,NFC)) when 'album' then app.normalized_label(m.album)
     when 'artist' then lower(normalize(m.artists->0->>'name',NFC)) when 'year' then m.release_date
     when 'random' then md5(seed||m.track_key) end asc nulls last,k.track_key) ord
   from app.filter_keys(p_request->'filter') k join app.track_metadata m using(track_key)
   where m.removed_at is null and (selected is null or k.track_key=any(selected))
  ) ordered;
  if cardinality(keys)>100000 then raise exception 'request_conflict'; end if;
  if cardinality(keys)=0 then result:=jsonb_build_object('revision',app.library_revision(),'entries','[]'::jsonb);
  else result:=public.app_queue_tracks(p_epoch,jsonb_build_object('trackKeys',keys[1:40])); end if;
  return result||jsonb_build_object('trackKeys',to_jsonb(keys));
 end;
$$;
revoke all on function public.app_queue_tracks(bigint,jsonb),public.app_queue_snapshot(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.app_queue_tracks(bigint,jsonb),public.app_queue_snapshot(bigint,jsonb) to service_role;
notify pgrst,'reload schema';
