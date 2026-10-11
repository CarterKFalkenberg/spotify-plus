// Operator-only SQL construction. Never deployed as a function or public endpoint.
// Every interpolated value is locally generated and shape checked; SQL results stay private.
export interface CoreRegistry {
  version: 1;
  run: string;
  epoch: number;
  ownerFingerprint: string;
  trackKeys: string[];
  spotifyIds: string[];
  artistId: string;
  tagIds: string[];
  requestId: string;
  playlistId: string | null;
  spotifyPlaylistId: string | null;
  phase:
    | "prepared"
    | "inserting"
    | "fixtures"
    | "tracks-cleaned"
    | "creating"
    | "playlist"
    | "removed"
    | "cleaned";
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{64}$/;
const id = /^[a-zA-Z0-9]{22}$/;
export class ProofFailure extends Error {}
export function check(value: unknown, code: string): asserts value {
  if (!value) throw new ProofFailure(code);
}
export function validateRegistry(r: CoreRegistry): void {
  check(
    r?.version === 1 && uuid.test(r.run) && uuid.test(r.requestId) &&
      Number.isSafeInteger(r.epoch) && r.epoch > 0 &&
      hex.test(r.ownerFingerprint) &&
      Array.isArray(r.trackKeys) && r.trackKeys.length === 3 &&
      r.trackKeys.every((x) => hex.test(x)) &&
      new Set(r.trackKeys).size === 3 &&
      Array.isArray(r.spotifyIds) && r.spotifyIds.length === 3 &&
      r.spotifyIds.every((x) => id.test(x)) &&
      new Set(r.spotifyIds).size === 3 &&
      Array.isArray(r.tagIds) && r.tagIds.length === 2 &&
      r.tagIds.every((x) => uuid.test(x)) && new Set(r.tagIds).size === 2 &&
      id.test(r.artistId) &&
      (r.playlistId === null || uuid.test(r.playlistId)) &&
      (r.spotifyPlaylistId === null || id.test(r.spotifyPlaylistId)) &&
      [
        "prepared",
        "inserting",
        "fixtures",
        "tracks-cleaned",
        "creating",
        "playlist",
        "removed",
        "cleaned",
      ].includes(r.phase),
    "invalid_core_registry",
  );
}
export function newRegistry(
  epoch: number,
  ownerFingerprint: string,
): CoreRegistry {
  const randomHex = () =>
    [...crypto.getRandomValues(new Uint8Array(32))].map((x) =>
      x.toString(16).padStart(2, "0")
    ).join("");
  const r: CoreRegistry = {
    version: 1,
    run: crypto.randomUUID(),
    epoch,
    ownerFingerprint,
    trackKeys: Array.from({ length: 3 }, randomHex),
    spotifyIds: Array.from({ length: 3 }, () => randomHex().slice(0, 22)),
    artistId: randomHex().slice(0, 22),
    tagIds: [crypto.randomUUID(), crypto.randomUUID()],
    requestId: crypto.randomUUID(),
    playlistId: null,
    spotifyPlaylistId: null,
    phase: "prepared",
  };
  validateRegistry(r);
  return r;
}
export const fixtureName = (r: CoreRegistry, n = 0) =>
  `Tagger API test ${r.run} ${n}`;
const strings = (values: string[]) => values.map((x) => `'${x}'`).join(",");
function guard(r: CoreRegistry) {
  validateRegistry(r);
  return `perform pg_advisory_xact_lock(735912640);
    perform app.require_owner(${r.epoch},true);
    if not exists(select 1 from app.account where singleton and epoch=${r.epoch} and owner_fingerprint='${r.ownerFingerprint}') then raise exception 'fixture_owner_changed'; end if;
    if exists(select 1 from app.jobs where state='running' and lease_until>clock_timestamp()) then raise exception 'fixture_active_lease'; end if;`;
}
function owned(r: CoreRegistry) {
  const exactMetadata = r.trackKeys.map((key, i) => `
    (m.track_key='${key}' and m.spotify_id='${r.spotifyIds[i]}'
      and m.added_run_id='${r.run}' and m.title='${fixtureName(r)}'
      and m.artists='[{"id":"${r.artistId}","name":"Synthetic verification artist"}]'::jsonb
      and m.album='Synthetic verification album' and m.release_date='2000'
      and m.duration_ms=1000 and m.explicit=false
      and m.artwork_url is null and m.spotify_url is null and m.playable_uri is null
      and m.liked_at='2000-01-0${i + 1}T00:00:00Z'::timestamptz
      and ${
    i === 2
      ? "m.removed_at is not null and m.acknowledged_at is null"
      : "m.removed_at is null"
  })`).join(" or ");
  return `if exists(select 1 from app.track_metadata m where m.track_key in (${
    strings(r.trackKeys)
  }) and (${exactMetadata}) is not true) then raise exception 'fixture_ownership_changed'; end if;
    if exists(select 1 from app.annotations a where a.track_key in (${
    strings(r.trackKeys)
  }) and (a.epoch<>${r.epoch} or not exists(select 1 from app.track_metadata m where m.track_key=a.track_key and m.added_run_id='${r.run}' and m.title='${
    fixtureName(r)
  }' and m.playable_uri is null and m.spotify_id in (${
    strings(r.spotifyIds)
  })))) then raise exception 'fixture_ownership_changed'; end if;
    if exists(select 1 from app.tags t where t.id in (${
    strings(r.tagIds)
  }) and (t.epoch<>${r.epoch} or not (${
    r.tagIds.map((tag, i) =>
      `(t.id='${tag}' and t.name='${
        fixtureName(r, i)
      }' and t.normalized_name='${fixtureName(r, i).toLowerCase()}')`
    ).join(" or ")
  }))) then raise exception 'fixture_ownership_changed'; end if;
    if exists(select 1 from app.track_tags where (track_key in (${
    strings(r.trackKeys)
  }) and tag_id not in (${strings(r.tagIds)})) or (tag_id in (${
    strings(r.tagIds)
  }) and track_key not in (${
    strings(r.trackKeys)
  }))) then raise exception 'fixture_foreign_assignment'; end if;
    if exists(select 1 from app.tag_action_edges e join app.tag_actions a on a.id=e.action_id where a.tag_id in (${
    strings(r.tagIds)
  }) and e.track_key not in (${
    strings(r.trackKeys)
  })) then raise exception 'fixture_foreign_action'; end if;`;
}
export function insertFixturesSql(r: CoreRegistry): string {
  const values = r.trackKeys.map((key, i) =>
    `('${key}','${r.spotifyIds[i]}','${
      fixtureName(r)
    }','[{"id":"${r.artistId}","name":"Synthetic verification artist"}]','Synthetic verification album','2000',1000,false,null,null,null,'2000-01-0${
      i + 1
    }T00:00:00Z',${i === 2 ? "now()" : "null"},null,'${r.run}')`
  ).join(",");
  return `do $fixture$ begin ${guard(r)}
    if exists(select 1 from app.jobs where epoch=${r.epoch} and kind in ('library_sync','library_probe') and state in ('queued','running','parked')) then raise exception 'fixture_sync_not_idle'; end if;
    if exists(select 1 from app.annotations where track_key in (${
    strings(r.trackKeys)
  })) or exists(select 1 from app.track_metadata where spotify_id in (${
    strings(r.spotifyIds)
  })) or exists(select 1 from app.tags where id in (${
    strings(r.tagIds)
  }) or normalized_name in ('${fixtureName(r, 0).toLowerCase()}','${
    fixtureName(r, 1).toLowerCase()
  }')) then raise exception 'fixture_collision'; end if;
    insert into app.annotations(track_key,epoch) values ${
    r.trackKeys.map((k) => `('${k}',${r.epoch})`).join(",")
  };
    insert into app.track_metadata(track_key,spotify_id,title,artists,album,release_date,duration_ms,explicit,artwork_url,spotify_url,playable_uri,liked_at,removed_at,acknowledged_at,added_run_id) values ${values};
    insert into app.tags(id,epoch,name,normalized_name) values ${
    r.tagIds.map((t, i) =>
      `('${t}',${r.epoch},'${fixtureName(r, i)}','${
        fixtureName(r, i).toLowerCase()
      }')`
    ).join(",")
  };
    update app.library_state set library_revision=library_revision+1,annotation_revision=annotation_revision+1 where singleton and epoch=${r.epoch};
    end $fixture$; select true as ok;`;
}
export function cleanupFixturesSql(r: CoreRegistry, tags: boolean): string {
  return `do $fixture$ begin ${guard(r)} ${owned(r)}
    ${
    tags
      ? `if exists(select 1 from app.playlists where epoch=${r.epoch} and status<>'removed' and (query::text like '%${
        r.tagIds[0]
      }%' or query::text like '%${
        r.tagIds[1]
      }%')) then raise exception 'fixture_playlist_remaining'; end if;`
      : ""
  }
    delete from app.tag_actions where epoch=${r.epoch} and tag_id in (${
    strings(r.tagIds)
  });
    delete from app.track_tags where track_key in (${
    strings(r.trackKeys)
  }) and tag_id in (${strings(r.tagIds)});
    delete from app.track_metadata where track_key in (${
    strings(r.trackKeys)
  }) and added_run_id='${r.run}' and title='${
    fixtureName(r)
  }' and playable_uri is null;
    delete from app.annotations where epoch=${r.epoch} and track_key in (${
    strings(r.trackKeys)
  });
    ${
    tags
      ? `delete from app.tags where epoch=${r.epoch} and id in (${
        strings(r.tagIds)
      });`
      : ""
  }
    update app.library_state set library_revision=library_revision+1,annotation_revision=annotation_revision+1 where singleton and epoch=${r.epoch};
    end $fixture$; select true as ok;`;
}
export function duePlaylistSql(r: CoreRegistry): string {
  check(
    r.playlistId && r.spotifyPlaylistId && r.phase === "playlist",
    "registered_playlist_required",
  );
  return `do $fixture$ begin ${guard(r)} ${owned(r)}
    if exists(select 1 from app.jobs where state in ('queued','running') and retry_at<=now()) then raise exception 'fixture_jobs_not_idle'; end if;
    update app.playlists set expires_on=(now() at time zone 'America/New_York')::date-1,revision=revision+1
      where id='${r.playlistId}' and epoch=${r.epoch} and spotify_id='${r.spotifyPlaylistId}' and name='${
    fixtureName(r)
  } renamed' and status='ready' and active_operation is null and retention='month'
      and query=jsonb_build_object('version',1,'root',jsonb_build_object('op','not','child',jsonb_build_object('op','tag','tagId','${
    r.tagIds[1]
  }')));
    if not found then raise exception 'registered_playlist_not_idle'; end if;
    perform app.playlists_changed();
    end $fixture$; select true as ok;`;
}
