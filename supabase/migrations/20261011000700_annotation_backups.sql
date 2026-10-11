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
  perform 1 from app.account where singleton and epoch=p_epoch and state in ('connected','reconnect') for share;
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
  return coalesce((select jsonb_agg(path) from (select epoch::text||'-'||id::text||'.bin' as path from app.annotation_backups where epoch=p_epoch and state='retired' and purged_at is null order by day,id limit 1) batch),'[]'::jsonb);
 end;
$$;
create function public.app_backup_retention_finish(p_epoch bigint,p_id uuid,p_lease uuid,p_paths jsonb) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  if not app.backup_lease(p_epoch,p_id,p_lease) then return false; end if;
  if jsonb_typeof(p_paths) is distinct from 'array' then raise exception 'invalid_input'; end if;
  update app.annotation_backups b set purged_at=now() where b.epoch=p_epoch and b.state='retired' and b.purged_at is null and p_paths ? (b.epoch::text||'-'||b.id::text||'.bin')
   and not exists(select 1 from storage.buckets where id='annotation-backups-e'||b.epoch::text||'-'||b.id::text);
  return not exists(select 1 from app.annotation_backups b where b.epoch=p_epoch and b.state='retired' and b.purged_at is null and p_paths ? (b.epoch::text||'-'||b.id::text||'.bin'));
 end;
$$;
create function public.app_backup_purge_targets(p_epoch bigint) returns jsonb
 language plpgsql security definer set search_path='' as $$
 begin
  perform 1 from app.account where singleton and epoch=p_epoch and state='disconnecting' for share;
  if not found then raise exception 'inactive_epoch'; end if;
  return coalesce((select jsonb_agg(path) from (select b.epoch::text||'-'||b.id::text||'.bin' as path from app.annotation_backups b where b.epoch<p_epoch and (b.purged_at is null or exists(select 1 from storage.buckets where id='annotation-backups-e'||b.epoch::text||'-'||b.id::text)) order by b.epoch,b.day,b.id limit 1) batch),'[]'::jsonb);
 end;
$$;
create function public.app_backup_purge_checkpoint(p_epoch bigint,p_id uuid,p_lease uuid,p_path text) returns boolean
 language plpgsql security definer set search_path='' as $$
 begin
  perform 1 from app.account where singleton and epoch=p_epoch and state='disconnecting' for share;
  if not found then return false; end if;
  perform 1 from app.jobs where id=p_id and epoch is null and kind='purge_backups' and state='running' and lease_token=p_lease and lease_until>now() and payload->>'epoch'=p_epoch::text for update;
  if not found then return false; end if;
  update app.annotation_backups b set purged_at=now() where b.epoch<p_epoch and p_path=b.epoch::text||'-'||b.id::text||'.bin'
   and not exists(select 1 from storage.buckets where id='annotation-backups-e'||b.epoch::text||'-'||b.id::text);
  return found;
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
  select epoch into e from app.account where singleton and state in ('connected','reconnect') for share;
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
-- Compact codec budget3744914 plus an upper bound520019 for JSONB structural
-- spaces (10 top-level fields, <=20000 3-field tags, <=100000 2-field edges).
-- No custom serializer or whitespace stripping of user tag strings is used.
create function public.app_backup_restore(p_epoch bigint,p_owner text,p_expected_revision bigint,p_snapshot jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare b app.annotation_backups; tag jsonb; edge jsonb; names text[]:='{}'; ids uuid[]:='{}'; normalized text; key text; tid uuid;
 begin
  if jsonb_typeof(p_snapshot) is distinct from 'object' or octet_length(p_snapshot::text)>4264933
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
  if (select count(*) from jsonb_array_elements(p_snapshot->'assignments'))<>(select count(distinct (value->>'trackKey',(value->>'tagId')::uuid)) from jsonb_array_elements(p_snapshot->'assignments')) then raise exception 'invalid_input'; end if;
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
-- Spotify credentials may expire while authenticated annotation edits continue.
-- Only annotation backup work can survive/retry in reconnect; Spotify jobs stay parked.
create or replace function public.app_token_claim(p_epoch bigint,p_force_version bigint default null) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare a app.account; c app.credentials; lease uuid;
 begin
  select * into a from app.account for update;
  if a.epoch is distinct from p_epoch or a.state<>'connected' then return jsonb_build_object('action','reconnect'); end if;
  select * into c from app.credentials where epoch=p_epoch for update;
  if not found or a.authorization_deadline<=now() or (c.refresh_lease is not null and c.refresh_until<=now()) then
    update app.account set state='reconnect' where singleton and epoch=p_epoch;
    delete from app.credentials where singleton and epoch=p_epoch;
    update app.jobs set state='parked',last_error='reconnect',lease_token=null,lease_until=null where epoch=p_epoch and kind<>'annotation_backup' and state in ('queued','running');
    return jsonb_build_object('action','reconnect');
  end if;
  if c.refresh_lease is not null then return jsonb_build_object('action','busy'); end if;
  if c.access_expires_at>now()+interval '60 seconds' and (p_force_version is null or p_force_version<>c.version) then
    return jsonb_build_object('action','cached','encryptedTokens',c.encrypted_tokens,'version',c.version);
  end if;
  if exists(select 1 from app.spotify_pacing where cooldown_until>now()) then
    return (select jsonb_build_object('action','cooldown','retryAfterMs',ceil(extract(epoch from(cooldown_until-now()))*1000)) from app.spotify_pacing);
  end if;
  lease:=gen_random_uuid();
  update app.credentials set refresh_lease=lease,refresh_until=now()+interval '45 seconds' where singleton and epoch=p_epoch;
  return jsonb_build_object('action','refresh','encryptedTokens',c.encrypted_tokens,'version',c.version,'lease',lease);
 end;
$$;

create or replace function public.app_token_fail(p_epoch bigint,p_lease uuid,p_reconnect boolean,p_retry_ms bigint default 0)
 returns boolean language plpgsql security definer set search_path = '' as $$
 begin
  perform 1 from app.account where epoch=p_epoch and state='connected' for update;
  if not found then return false; end if;
  perform 1 from app.credentials where epoch=p_epoch and refresh_lease=p_lease for update;
  if not found then return false; end if;
  if p_reconnect then
    delete from app.credentials where singleton and epoch=p_epoch and refresh_lease=p_lease;
    update app.account set state='reconnect' where singleton and epoch=p_epoch;
    update app.jobs set state='parked',last_error='reconnect',lease_token=null,lease_until=null where epoch=p_epoch and kind<>'annotation_backup' and state in ('queued','running');
  else
    if p_retry_ms>0 then perform public.app_pacing_defer(p_epoch,p_retry_ms,'rate_limit'); end if;
    update app.credentials set refresh_lease=null,refresh_until=null where epoch=p_epoch;
  end if;
  return true;
 end;
$$;

create or replace function public.app_job_enqueue(p_kind text,p_epoch bigint,p_payload jsonb default '{}',p_priority integer default 0)
 returns uuid language plpgsql security definer set search_path = '' as $$
 declare id uuid;
 begin
  if p_epoch is null and p_kind not in ('scheduler_ping','purge_backups') then raise exception 'invalid_system_job'; end if;
  if p_epoch is not null then
    perform 1 from app.account where epoch=p_epoch and (state='connected' or (state='reconnect' and p_kind='annotation_backup')) for share;
    if not found then raise exception 'inactive_epoch'; end if;
  end if;
  insert into app.jobs(kind,epoch,payload,priority) values(p_kind,p_epoch,p_payload,p_priority) returning app.jobs.id into id;
  return id;
 end;
$$;

create or replace function public.app_job_claim(p_lease_seconds integer default 100) returns jsonb
 language plpgsql security definer set search_path = '' as $$
 declare j app.jobs; a app.account;
 begin
  if p_lease_seconds<10 or p_lease_seconds>120 then raise exception 'invalid_lease'; end if;
  -- All transactions lock account before work rows, including disconnect.
  select * into a from app.account for share;
  select * into j from app.jobs where retry_at<=now()
    and (state='queued' or (state='running' and lease_until<=now()))
    and (epoch is null or (epoch=a.epoch and (a.state='connected' or (a.state='reconnect' and kind='annotation_backup'))))
    order by priority desc,retry_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update app.jobs set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=now()+make_interval(secs=>p_lease_seconds) where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'kind',j.kind,'epoch',j.epoch,'payload',j.payload,'attempts',j.attempts,'leaseToken',j.lease_token);
 end;
$$;

create or replace function public.app_job_renew(p_id uuid,p_lease uuid) returns boolean
 language plpgsql security definer set search_path = '' as $$
 declare a app.account;
 begin
  select * into a from app.account for share;
  update app.jobs set lease_until=now()+interval '100 seconds'
    where id=p_id and lease_token=p_lease and state='running' and lease_until>now()
    and (epoch is null or (epoch=a.epoch and (a.state='connected' or (a.state='reconnect' and kind='annotation_backup'))));
  return found;
 end;
$$;

create or replace function public.app_job_finish(p_id uuid,p_lease uuid,p_outcome text,p_retry_ms bigint default 0,p_error text default null)
 returns boolean language plpgsql security definer set search_path = '' as $$
 declare a app.account;
 begin
  select * into a from app.account for share;
  if p_outcome not in ('done','queued','parked') or p_retry_ms<0 then raise exception 'invalid_outcome'; end if;
  update app.jobs set state=p_outcome,retry_at=now()+make_interval(secs=>p_retry_ms/1000.0),
    lease_token=null,lease_until=null,last_error=p_error
    where id=p_id and lease_token=p_lease and state='running' and lease_until>now()
    and (epoch is null or (epoch=a.epoch and (a.state='connected' or (a.state='reconnect' and kind='annotation_backup'))));
  if not found then return false; end if;
  if p_outcome='done' then update app.runtime_health set last_job_at=now() where singleton; end if;
  return true;
 end;
$$;

create or replace function app.scheduler_tick() returns void language plpgsql security definer set search_path='' as $$
 declare project_url text; cron_secret text; dispatch_request_id bigint;
 begin
  update app.runtime_health h set last_scheduler_at=now() where h.singleton=true;
  delete from app.cron_dispatches d where d.dispatched_at<now()-interval '7 days';
  if not exists(select 1 from app.jobs j where j.kind='scheduler_ping' and j.state in ('queued','running'))
    and exists(select 1 from app.runtime_health h where h.last_maintenance_at is null or h.last_maintenance_at<now()-interval '15 minutes') then
    insert into app.jobs(kind) values('scheduler_ping');
  end if;
  if not exists(select 1 from app.jobs j cross join app.account a where j.retry_at<=now()
    and (j.state='queued' or (j.state='running' and j.lease_until<=now()))
    and (j.epoch is null or (j.epoch=a.epoch and (a.state='connected' or (a.state='reconnect' and j.kind='annotation_backup'))))) then return; end if;
  select v.decrypted_secret into project_url from vault.decrypted_secrets v where v.name='spotify_plus_project_url';
  select v.decrypted_secret into cron_secret from vault.decrypted_secrets v where v.name='spotify_plus_cron_secret';
  if project_url is null or cron_secret is null then return; end if;
  -- The response must be observable after the bounded 80-second jobs drain.
  dispatch_request_id:=net.http_post(url:=project_url||'/functions/v1/jobs',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',cron_secret),
    body:='{}'::jsonb,timeout_milliseconds:=90000);
  insert into app.cron_dispatches(request_id) values(dispatch_request_id);
 end;
$$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and p.proname like 'app\_%' escape '\' loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst, 'reload schema';
