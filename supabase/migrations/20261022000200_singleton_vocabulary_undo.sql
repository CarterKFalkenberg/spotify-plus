-- Preserve changed-only vocabulary undo for opaque ungrouped singletons.
create or replace function public.app_tag_undo(p_epoch bigint,p_session_hash text,p_action_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare action app.tag_actions; conflicts text[]; result jsonb; filtered jsonb;
 begin
  perform app.require_owner(p_epoch);
  if not exists(select 1 from app.sessions where token_hash=p_session_hash and epoch=p_epoch and expires_at>now()) then raise exception 'inactive_epoch'; end if;
  select * into action from app.tag_actions where id=p_action_id and epoch=p_epoch and session_hash=p_session_hash for update;
  if not found then raise exception 'unknown_action'; end if;
  if action.undone_at is not null or not (exists(select 1 from app.vocabulary_deletes where action_id=p_action_id)
   or exists(select 1 from app.vocabulary_changes where action_id=p_action_id)) then
   return public.app_tag_undo_before_song_groups(p_epoch,p_session_hash,p_action_id);
  end if;
  select coalesce(array_agg(distinct app.song_group_key(member.key)),'{}'::text[]) into conflicts
   from app.song_action_groups g cross join lateral unnest(g.member_keys) member(key) where g.action_id=p_action_id and g.member_keys is distinct from
    -- Snapshot creation treats an ungrouped annotation as a singleton. Compare
    -- against the same identity until a real component relationship exists.
    coalesce((select array_agg(sm.track_key order by sm.track_key) from app.song_group_members sm
     where sm.group_key=app.song_group_key(g.member_keys[1])),array[g.member_keys[1]]);
  -- Pre-migration vocabulary undo has no component snapshot. Keep its original
  -- behavior for singletons and conservatively skip newly grouped assignments.
  if not exists(select 1 from app.song_action_groups where action_id=p_action_id) then
   select coalesce(array_agg(distinct group_key),'{}'::text[]) into conflicts from (
    select app.song_group_key(e.track_key) group_key from app.tag_action_edges e where e.action_id=p_action_id
    union select app.song_group_key(edge->>'key') from app.vocabulary_changes v
     cross join lateral jsonb_array_elements(v.edges) edge where v.action_id=p_action_id
   ) affected where (select count(*) from app.annotations a where a.epoch=p_epoch and app.song_group_key(a.track_key)=affected.group_key)>1;
  end if;
  if cardinality(conflicts)>0 then
   -- These journals are session-scoped and terminal after undo. Removing skipped
   -- edges fences the underlying changed-only version checks for complete songs.
   delete from app.tag_action_edges where action_id=p_action_id and app.song_group_key(track_key)=any(conflicts);
   select coalesce(jsonb_agg(edge),'[]') into filtered from app.vocabulary_changes v
    cross join lateral jsonb_array_elements(v.edges) edge where v.action_id=p_action_id
     and not app.song_group_key(edge->>'key')=any(conflicts);
   update app.vocabulary_changes set edges=filtered where action_id=p_action_id;
  end if;
  result:=public.app_tag_undo_before_song_groups(p_epoch,p_session_hash,p_action_id);
  return result||jsonb_build_object('skippedCount',(result->>'skippedCount')::integer+cardinality(conflicts));
 end;
$$;
