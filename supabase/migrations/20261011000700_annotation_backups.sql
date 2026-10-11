-- Application-only encrypted daily copies. Storage schema is read-only: all bytes
-- and buckets are removed through its API. Bucket identities are never recreated.
create table app.annotation_backups (
 id uuid primary key default gen_random_uuid(),
 epoch bigint not null,
 day date not null default (now() at time zone 'UTC')::date,
 state text not null default 'new' check(state in ('new','creating','uploading','retained','retired')),
 revision bigint,
 key_link text check(key_link ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 committed_at timestamptz,
 purged_at timestamptz
);
create unique index backup_daily_active on app.annotation_backups(epoch,day) where state<>'retired';
alter table app.annotation_backups enable row level security;

create function app.backup_lease(p_epoch bigint,p_id uuid,p_lease uuid) returns boolean
 language plpgsql set search_path='' as $$
 begin
  perform 1 from app.account where singleton and epoch=p_epoch and state='connected' for share;
  if not found then return false; end if;
  perform 1 from app.library_state where singleton and epoch=p_epoch for update;
  if not found then return false; end if;
  perform 1 from app.jobs where id=p_id and epoch=p_epoch and kind='annotation_backup' and state='running' and lease_token=p_lease and lease_until>now() for update;
  return found;
 end;
$$;
create function public.app_backup_prepare(p_epoch bigint,p_id uuid,p_lease uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare b app.annotation_backups; l app.library_state; owner text;
 begin
  if not app.backup_lease(p_epoch,p_id,p_lease) then return null; end if;
  select * into l from app.library_state where singleton and epoch=p_epoch;
  if l.encrypted_annotation_key is null then raise exception 'invalid_input'; end if;
  select owner_fingerprint into owner from app.account where singleton;
  update app.annotation_backups set state='retired' where epoch=p_epoch and day<(now() at time zone 'UTC')::date and state in ('new','creating','uploading');
  select * into b from app.annotation_backups where epoch=p_epoch and day=(now() at time zone 'UTC')::date and state<>'retired' for update;
  if not found then
   if (select count(*) from app.annotation_backups where epoch=p_epoch and day=(now() at time zone 'UTC')::date)>=3 then raise exception 'backup_daily_limit'; end if;
   insert into app.annotation_backups(epoch) values(p_epoch) returning * into b;
  end if;
  return jsonb_build_object('state',b.state,'encryptedKey',l.encrypted_annotation_key,
   'snapshot',jsonb_build_object('version',1,'keyVersion',1,'id',b.id,'day',b.day,'owner',owner,'epoch',p_epoch,'revision',l.annotation_revision::text,
    'tags',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'normalizedName',t.normalized_name) order by t.id) from app.tags t where t.epoch=p_epoch and t.deleted_at is null),'[]'::jsonb),
    'assignments',coalesce((select jsonb_agg(jsonb_build_object('trackKey',tt.track_key,'tagId',tt.tag_id) order by tt.track_key,tt.tag_id) from app.track_tags tt join app.tags t on t.id=tt.tag_id join app.annotations a on a.track_key=tt.track_key where a.epoch=p_epoch and t.epoch=p_epoch and t.deleted_at is null and tt.present),'[]'::jsonb)));
 end;
$$;
create function public.app_backup_bucket_start(p_epoch bigint,p_id uuid,p_lease uuid,p_snapshot_id uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  if not app.backup_lease(p_epoch,p_id,p_lease) then return false; end if;
  update app.annotation_backups set state='creating' where id=p_snapshot_id and epoch=p_epoch and state='new';
  return found;
 end;
$$;
create function public.app_backup_upload_allowed(p_epoch bigint,p_id uuid,p_lease uuid,p_snapshot_id uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  if not app.backup_lease(p_epoch,p_id,p_lease) then return false; end if;
  update app.annotation_backups set state=case when state='retained' then state else 'uploading' end where id=p_snapshot_id and epoch=p_epoch and state in ('creating','uploading','retained');
  -- Retained state must remain retained on cleanup retries.
  return found;
 end;
$$;
create function public.app_backup_abandon(p_epoch bigint,p_id uuid,p_lease uuid,p_snapshot_id uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  if not app.backup_lease(p_epoch,p_id,p_lease) then return false; end if;
  update app.annotation_backups set state='retired' where id=p_snapshot_id and epoch=p_epoch and state='creating';
  return found;
 end;
$$;
create function public.app_backup_retire_allowed(p_epoch bigint,p_snapshot_id uuid) returns boolean
 language sql security definer set search_path='' as $$
 select exists(select 1 from app.annotation_backups where id=p_snapshot_id and epoch=p_epoch and state='retired')
  or exists(select 1 from app.account where singleton and (epoch<>p_epoch or state in ('disconnecting','disconnected')));
$$;
create function public.app_backup_commit(p_epoch bigint,p_id uuid,p_lease uuid,p_snapshot_id uuid,p_revision bigint,p_key_link text) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  if not app.backup_lease(p_epoch,p_id,p_lease) then return false; end if;
  if p_revision is null or p_revision<0 or p_key_link is distinct from encode(sha256(convert_to((select encrypted_annotation_key from app.library_state where singleton and epoch=p_epoch),'UTF8')),'hex') then raise exception 'invalid_input'; end if;
  update app.annotation_backups set state='retained',revision=p_revision,key_link=p_key_link,committed_at=coalesce(committed_at,now()) where id=p_snapshot_id and epoch=p_epoch and state in ('uploading','retained');
  return found;
 end;
$$;
create function public.app_backup_retention(p_epoch bigint,p_id uuid,p_lease uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 begin
  if not app.backup_lease(p_epoch,p_id,p_lease) then return null; end if;
  update app.annotation_backups set state='retired' where id in (select id from app.annotation_backups where epoch=p_epoch and state='retained' order by day desc,id offset 3);
  return coalesce((select jsonb_agg(epoch::text||'-'||id::text||'.bin') from app.annotation_backups where epoch=p_epoch and state='retired' and purged_at is null),'[]'::jsonb);
 end;
$$;
create function public.app_backup_retention_finish(p_epoch bigint,p_id uuid,p_lease uuid,p_paths jsonb) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  if not app.backup_lease(p_epoch,p_id,p_lease) then return false; end if;
  if jsonb_typeof(p_paths) is distinct from 'array' then raise exception 'invalid_input'; end if;
  update app.annotation_backups b set purged_at=now() where b.epoch=p_epoch and b.state='retired' and b.purged_at is null and p_paths ? (b.epoch::text||'-'||b.id::text||'.bin')
   and not exists(select 1 from storage.buckets where id='annotation-backups-e'||b.epoch::text||'-'||b.id::text);
  return not exists(select 1 from app.annotation_backups b where b.epoch=p_epoch and b.state='retired' and b.purged_at is null);
 end;
$$;
create function public.app_backup_purge_targets(p_epoch bigint) returns jsonb
 language plpgsql security definer set search_path='' as $$
 begin
  perform 1 from app.account where singleton and epoch=p_epoch and state='disconnecting' for share;
  if not found then raise exception 'inactive_epoch'; end if;
  return coalesce((select jsonb_agg(epoch::text||'-'||id::text||'.bin') from app.annotation_backups where epoch<p_epoch),'[]'::jsonb);
 end;
$$;
-- Registry survives disconnect so interrupted deletion and ambiguous bucket creation
-- can be reconciled. It contains no annotation payload or account identity.
alter function app.purge_product_data() rename to purge_before_annotation_backups;
create function app.purge_product_data() returns void language plpgsql set search_path='' as $$
 begin
  update app.annotation_backups set state='retired' where epoch<=(select epoch from app.account where singleton);
  perform app.purge_before_annotation_backups();
 end;
$$;
create or replace function public.app_disconnect_finish(p_epoch bigint) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  perform 1 from app.account where singleton and epoch=p_epoch and state='disconnecting' for update;
  if not found then return false; end if;
  if exists(select 1 from storage.objects where bucket_id='annotation-backups') or exists(select 1 from storage.buckets sb join app.annotation_backups b on sb.id='annotation-backups-e'||b.epoch::text||'-'||b.id::text where b.epoch<p_epoch) then return false; end if;
  update app.annotation_backups set purged_at=now(),key_link=null,revision=null where epoch<p_epoch;
  update app.account set state='disconnected' where singleton and epoch=p_epoch and state='disconnecting';
  return found;
 end;
$$;
-- Useful maintenance schedules one successful UTC-day copy, with SQL retry leases.
alter function app.library_maintenance() rename to library_maintenance_before_backups;
create function app.library_maintenance() returns void language plpgsql set search_path='' as $$
 declare e bigint;
 begin
  perform app.library_maintenance_before_backups();
  delete from app.annotation_backups b where b.state='retired' and b.purged_at<now()-interval '30 days'
   and not exists(select 1 from storage.buckets where id='annotation-backups-e'||b.epoch::text||'-'||b.id::text);
  select epoch into e from app.account where singleton and state='connected' for share;
  if e is null or not exists(select 1 from app.library_state where singleton and epoch=e and encrypted_annotation_key is not null) then return; end if;
  if not exists(select 1 from app.jobs where epoch=e and kind='annotation_backup' and state in ('queued','running'))
   and (not exists(select 1 from app.annotation_backups where epoch=e and day=(now() at time zone 'UTC')::date and state='retained')
     or exists(select 1 from app.annotation_backups where epoch=e and state='retired' and purged_at is null)) then
   insert into app.jobs(kind,epoch,priority) values('annotation_backup',e,-10);
  end if;
 end;
$$;

create function public.app_backup_restore_context(p_epoch bigint,p_owner text,p_snapshot_id uuid,p_expected_revision bigint) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare l app.library_state; b app.annotation_backups;
 begin
  perform 1 from app.account where singleton and epoch=p_epoch and state='connected' and owner_fingerprint=p_owner for share;
  if not found then raise exception 'inactive_epoch'; end if;
  select * into l from app.library_state where singleton and epoch=p_epoch for update;
  if l.annotation_revision is distinct from p_expected_revision then raise exception 'stale_revision'; end if;
  select * into b from app.annotation_backups where id=p_snapshot_id and epoch=p_epoch and state='retained';
  if not found or b.key_link is distinct from encode(sha256(convert_to(l.encrypted_annotation_key,'UTF8')),'hex') then raise exception 'invalid_input'; end if;
  return jsonb_build_object('keyLink',b.key_link);
 end;
$$;
create function public.app_backup_restore(p_epoch bigint,p_owner text,p_expected_revision bigint,p_snapshot jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare b app.annotation_backups; tag jsonb; edge jsonb; names text[]:='{}'; ids uuid[]:='{}'; normalized text; key text; tid uuid;
 begin
  if jsonb_typeof(p_snapshot) is distinct from 'object' or octet_length(p_snapshot::text)>3750000
   or (select count(*) from jsonb_object_keys(p_snapshot))<>10
   or not p_snapshot ?& array['version','keyVersion','id','day','owner','epoch','revision','keyLink','tags','assignments']
   or jsonb_typeof(p_snapshot->'version') is distinct from 'number' or jsonb_typeof(p_snapshot->'keyVersion') is distinct from 'number'
   or jsonb_typeof(p_snapshot->'epoch') is distinct from 'number' or jsonb_typeof(p_snapshot->'revision') is distinct from 'string'
   or jsonb_typeof(p_snapshot->'id') is distinct from 'string' or jsonb_typeof(p_snapshot->'day') is distinct from 'string'
   or jsonb_typeof(p_snapshot->'owner') is distinct from 'string' or jsonb_typeof(p_snapshot->'keyLink') is distinct from 'string'
   or p_snapshot->>'version'<>'1' or p_snapshot->>'keyVersion'<>'1'
   or p_snapshot->>'owner' is distinct from p_owner or p_snapshot->>'epoch' is distinct from p_epoch::text
   or jsonb_typeof(p_snapshot->'tags') is distinct from 'array' or jsonb_typeof(p_snapshot->'assignments') is distinct from 'array'
   or jsonb_array_length(p_snapshot->'tags')>20000 or jsonb_array_length(p_snapshot->'assignments')>100000 then raise exception 'invalid_input'; end if;
  perform public.app_backup_restore_context(p_epoch,p_owner,(p_snapshot->>'id')::uuid,p_expected_revision);
  select * into b from app.annotation_backups where id=(p_snapshot->>'id')::uuid and epoch=p_epoch and state='retained' for update;
  if b.key_link is distinct from p_snapshot->>'keyLink' or b.day::text is distinct from p_snapshot->>'day' or b.revision::text is distinct from p_snapshot->>'revision' then raise exception 'invalid_input'; end if;
  for tag in select value from jsonb_array_elements(p_snapshot->'tags') loop
   if jsonb_typeof(tag) is distinct from 'object' or (select count(*) from jsonb_object_keys(tag))<>3 or not tag ?& array['id','name','normalizedName']
    or jsonb_typeof(tag->'id')<>'string' or jsonb_typeof(tag->'name')<>'string' or jsonb_typeof(tag->'normalizedName')<>'string' or length(tag->>'name') not between 1 and 80 or (tag->>'name') ~ '[[:cntrl:]]' then raise exception 'invalid_input'; end if;
   normalized:=lower(normalize(btrim(regexp_replace(tag->>'name','[[:space:]               　﻿]+',' ','g')),NFC));
   if normalized='' or normalized is distinct from tag->>'normalizedName' or normalize(btrim(regexp_replace(tag->>'name','[[:space:]               　﻿]+',' ','g')),NFC) is distinct from tag->>'name' then raise exception 'invalid_input'; end if;
   tid:=(tag->>'id')::uuid;
   if tid=any(ids) or normalized=any(names) or exists(select 1 from app.tags where id=tid and epoch<>p_epoch) then raise exception 'invalid_input'; end if;
   ids:=array_append(ids,tid); names:=array_append(names,normalized);
  end loop;
  if (select count(*) from jsonb_array_elements(p_snapshot->'assignments'))<>(select count(distinct (value->>'trackKey',value->>'tagId')) from jsonb_array_elements(p_snapshot->'assignments')) then raise exception 'invalid_input'; end if;
  for edge in select value from jsonb_array_elements(p_snapshot->'assignments') loop
   if jsonb_typeof(edge) is distinct from 'object' or (select count(*) from jsonb_object_keys(edge))<>2 or not edge ?& array['trackKey','tagId'] or jsonb_typeof(edge->'trackKey')<>'string' or jsonb_typeof(edge->'tagId')<>'string' then raise exception 'invalid_input'; end if;
   key:=edge->>'trackKey'; tid:=(edge->>'tagId')::uuid;
   if key !~ '^[a-f0-9]{64}$' or not tid=any(ids) or exists(select 1 from app.annotations where track_key=key and epoch<>p_epoch) then raise exception 'invalid_input'; end if;
  end loop;
  -- This explicit whole-annotation restore invalidates session undo journals. UUID
  -- tombstones retain stored query leaves; queries and playlist jobs are untouched.
  delete from app.tag_actions where epoch=p_epoch;
  update app.tags set deleted_at=now(),name='Deleted tag',normalized_name=null,vocabulary_version=vocabulary_version+1 where epoch=p_epoch;
  update app.track_tags tt set present=false,version=version+1 where track_key in (select track_key from app.annotations where epoch=p_epoch);
  for tag in select value from jsonb_array_elements(p_snapshot->'tags') loop
   insert into app.tags(id,epoch,name,normalized_name) values((tag->>'id')::uuid,p_epoch,tag->>'name',tag->>'normalizedName')
    on conflict(id) do update set name=excluded.name,normalized_name=excluded.normalized_name,deleted_at=null,vocabulary_version=app.tags.vocabulary_version+1;
  end loop;
  for edge in select value from jsonb_array_elements(p_snapshot->'assignments') loop
   insert into app.annotations(track_key,epoch) values(edge->>'trackKey',p_epoch) on conflict(track_key) do nothing;
   insert into app.track_tags(track_key,tag_id,present) values(edge->>'trackKey',(edge->>'tagId')::uuid,true)
    on conflict(track_key,tag_id) do update set present=true,version=app.track_tags.version+1;
  end loop;
  update app.library_state set annotation_revision=annotation_revision+1 where singleton and epoch=p_epoch;
  delete from app.page_cursors where epoch=p_epoch;
  return jsonb_build_object('restoredTags',jsonb_array_length(p_snapshot->'tags'),'restoredAssignments',jsonb_array_length(p_snapshot->'assignments'));
 end;
$$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and p.proname like 'app\_%' escape '\' loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst, 'reload schema';
