-- Local disposable stack only. Never deploy this test RPC to a configured project.
create function public.app_test_backup_fixture(p_action text) returns jsonb
 language plpgsql security definer set search_path='' as $$
 begin
  if p_action='inspect' then
   return jsonb_build_object('bucketForeignKey',exists(select 1 from pg_constraint where conrelid='storage.objects'::regclass and confrelid='storage.buckets'::regclass and contype='f'),
    'annotationBackups',(select count(*) from storage.objects where bucket_id='annotation-backups' or bucket_id like 'annotation-backups-e%'));
  elsif p_action='latest' then
   return (select jsonb_build_object('id',id) from app.annotation_backups where epoch=(select epoch from app.account where singleton) and state='retained' order by day desc limit 1);
  end if;
  raise exception 'invalid_input';
 end;
$$;
revoke all on function public.app_test_backup_fixture(text) from public,anon,authenticated;
grant execute on function public.app_test_backup_fixture(text) to service_role;
notify pgrst,'reload schema';
