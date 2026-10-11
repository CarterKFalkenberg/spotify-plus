// Synthetic-only scenario for the disposable PostgreSQL harness. Never run on a remote database.
import {
  cleanupFixturesSql,
  duePlaylistSql,
  fixtureName,
  insertFixturesSql,
  newRegistry,
} from "./core-fixtures.ts";
export function fixtureAssertionsSql() {
  const r = newRegistry(2, "a".repeat(64));
  const expect = (query: string, message: string) =>
    `select pg_temp.fixture_expect($case$${query}$case$,'${message}');`;
  const query = JSON.stringify({
    version: 1,
    root: { op: "not", child: { op: "tag", tagId: r.tagIds[1] } },
  });
  const p = {
    ...r,
    phase: "playlist" as const,
    playlistId: crypto.randomUUID(),
    spotifyPlaylistId: "Z".repeat(22),
  };
  return `begin;
    create function pg_temp.fixture_check(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'Fixture assertion: %',label; end if; end $$;
    create function pg_temp.fixture_expect(statement text,message text) returns void language plpgsql as $$ begin
      begin execute statement; exception when others then if sqlerrm=message then return; end if; raise; end;
      raise exception 'Expected fixture refusal: %',message;
    end $$;
    select public.app_disconnect_finish(2);
    delete from app.jobs where id is not null;
    select public.app_connect(2,'synthetic-account',repeat('a',64),false,'synthetic-ciphertext',now()+interval '1 hour',now(),repeat('b',64),false);
    update app.jobs set state='done' where epoch=2;
    update app.library_state set initial_sync_complete=true where singleton;
    insert into app.annotations values(repeat('e',64),2);
    insert into app.tags(id,epoch,name,normalized_name) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',2,'Unrelated synthetic vocabulary','unrelated synthetic vocabulary');
    insert into app.track_metadata(track_key,spotify_id,title,artists,album,playable_uri,liked_at,added_run_id) values(repeat('e',64),repeat('E',22),'Unrelated synthetic title','[]','Unrelated synthetic album','spotify:track:'||repeat('E',22),now(),gen_random_uuid());
    insert into app.track_tags values(repeat('e',64),'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true,7);
    create temp table fixture_baseline as select row_to_json(m)::text as metadata from app.track_metadata m where track_key=repeat('e',64);
    ${expect(insertFixturesSql({ ...r, epoch: 3 }), "inactive_epoch")}
    ${
    expect(
      insertFixturesSql({ ...r, ownerFingerprint: "b".repeat(64) }),
      "fixture_owner_changed",
    )
  }
    insert into app.tags(id,epoch,name,normalized_name) values('${
    r.tagIds[0]
  }',2,'Preexisting collision','preexisting collision');
    ${expect(insertFixturesSql(r), "fixture_collision")}
    ${expect(cleanupFixturesSql(r, true), "fixture_ownership_changed")}
    select pg_temp.fixture_check(exists(select 1 from app.tags where id='${
    r.tagIds[0]
  }' and name='Preexisting collision'),'collision never overwritten/deleted');
    delete from app.tags where id='${r.tagIds[0]}';
    insert into app.jobs(id,kind,state,lease_token,lease_until) values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','scheduler_ping','running',gen_random_uuid(),now()+interval '1 hour');
    ${expect(insertFixturesSql(r), "fixture_active_lease")}
    delete from app.jobs where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    ${insertFixturesSql(r)}
    select pg_temp.fixture_check((select count(*)=3 and bool_and(playable_uri is null) from app.track_metadata where added_run_id='${r.run}'),'only unplayable synthetic tracks inserted');
    ${expect(insertFixturesSql(r), "fixture_collision")}
    update app.tags set normalized_name='Changed identity' where id='${
    r.tagIds[0]
  }';
    ${expect(cleanupFixturesSql(r, true), "fixture_ownership_changed")}
    update app.tags set normalized_name='${
    fixtureName(r, 0).toLowerCase()
  }' where id='${r.tagIds[0]}';
    insert into app.track_tags values('${
    r.trackKeys[0]
  }','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true,1);
    ${expect(cleanupFixturesSql(r, true), "fixture_foreign_assignment")}
    delete from app.track_tags where track_key='${
    r.trackKeys[0]
  }' and tag_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    insert into app.track_tags values(repeat('e',64),'${r.tagIds[0]}',true,1);
    ${expect(cleanupFixturesSql(r, true), "fixture_foreign_assignment")}
    delete from app.track_tags where track_key=repeat('e',64) and tag_id='${
    r.tagIds[0]
  }';
    update app.track_metadata set title='Changed by another actor' where track_key='${
    r.trackKeys[0]
  }';
    ${expect(cleanupFixturesSql(r, true), "fixture_ownership_changed")}
    update app.track_metadata set title='${fixtureName(r)}' where track_key='${
    r.trackKeys[0]
  }';
    update app.track_metadata set album='Changed album' where track_key='${
    r.trackKeys[0]
  }';
    ${expect(cleanupFixturesSql(r, true), "fixture_ownership_changed")}
    update app.track_metadata set album='Synthetic verification album' where track_key='${
    r.trackKeys[0]
  }';
    insert into app.jobs(id,kind,state,lease_token,lease_until) values('dddddddd-dddd-4ddd-8ddd-dddddddddddd','scheduler_ping','running',gen_random_uuid(),now()+interval '1 hour');
    ${expect(cleanupFixturesSql(r, true), "fixture_active_lease")}
    delete from app.jobs where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    select public.app_tag_action(2,repeat('b',64),'${
    JSON.stringify({
      selection: { kind: "tracks", trackKeys: [r.trackKeys[0]] },
      tagId: r.tagIds[0],
      action: "add",
    })
  }');
    ${cleanupFixturesSql(r, false)}
    select pg_temp.fixture_check(not exists(select 1 from app.annotations where track_key='${
    r.trackKeys[0]
  }') and exists(select 1 from app.tags where id='${
    r.tagIds[1]
  }'),'track cleanup retains unassigned preview tag');
    insert into app.playlists(id,epoch,name,spotify_id,query,retention,expires_on,track_count,status) values('${p.playlistId}',2,'${
    fixtureName(r)
  } renamed','${p.spotifyPlaylistId}','${query}','month',current_date+30,1,'ready');
    ${expect(cleanupFixturesSql(r, true), "fixture_playlist_remaining")}
    ${
    expect(
      duePlaylistSql({ ...p, spotifyPlaylistId: "Y".repeat(22) }),
      "registered_playlist_not_idle",
    )
  }
    ${duePlaylistSql(p)}
    select pg_temp.fixture_check((select expires_on=(now() at time zone 'America/New_York')::date-1 from app.playlists where id='${p.playlistId}'),'only registered ready disposable accelerated');
    update app.playlists set status='removed' where id='${p.playlistId}';
    ${cleanupFixturesSql(r, true)}
    ${cleanupFixturesSql(r, true)}
    select pg_temp.fixture_check(not exists(select 1 from app.tags where id in ('${
    r.tagIds[0]
  }','${r.tagIds[1]}')),'cleanup is repeatable after lost response');
    select pg_temp.fixture_check((select row_to_json(m)::text=(select metadata from fixture_baseline) from app.track_metadata m where track_key=repeat('e',64)) and exists(select 1 from app.track_tags where track_key=repeat('e',64) and tag_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and present and version=7),'unrelated metadata and assignments untouched');
    rollback;`;
}
