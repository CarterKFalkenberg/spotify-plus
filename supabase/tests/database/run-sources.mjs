// Disposable, synthetic PostgreSQL integration harness. Never reads .local or cloud credentials.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const container = `spotify-plus-sources-test-${process.pid}`;
const network = container + "-network";
const rest = container + "-rest";
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function command(args, input = "", executable = "docker") {
  const child = spawn(executable, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdin.end(input);
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (status !== 0) throw new Error(`Synthetic test command failed: ${errors}`);
  return output.trim();
}
const sql = (statement) =>
  command(
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-X",
      "-q",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    statement,
  );
try {
  await command(["network", "create", network]);
  await command([
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    network,
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:17.6-alpine",
  ]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await command([
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      ]);
      break;
    } catch {
      if (attempt === 59) throw new Error("Disposable database did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await sql(
    "create role anon; create role authenticated; create role service_role;",
  );
  // Local metadata stand-in only; real Storage API/FK proof remains a separate
  // isolated vendor check. Song-group restore wraps the installed backup RPCs.
  await sql(`create schema storage;
    create table storage.buckets(id text primary key);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    insert into storage.buckets values('annotation-backups');`);
  await sql(
    await readFile(
      new URL(
        "../../migrations/20261011000100_backend_foundation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await sql(
    await readFile(
      new URL(
        "../../migrations/20261011000300_safeupdate_rpc.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (
    const migration of [
      "20261011000400_library_annotations.sql",
      "20261011000500_managed_playlists.sql",
      "20261011000600_fast_tagging.sql",
      "20261011000700_annotation_backups.sql",
      "20261011000800_expire_failed_reconciliation.sql",
      "20261011000900_artwork.sql",
      "20261011001000_queue_playback.sql",
      "20261021000100_sources.sql",
      "20261021000200_song_groups.sql",
      "20261022000100_source_discovery_identity.sql",
      "20261022000200_singleton_vocabulary_undo.sql",
      "20261022000300_queue_loading.sql",
    ]
  ) {
    await sql(
      await readFile(
        new URL("../../migrations/" + migration, import.meta.url),
        "utf8",
      ),
    );
  }
  await sql(await readFile(new URL("./sources.sql", import.meta.url), "utf8"));
  await sql(
    await readFile(
      new URL("./source-discovery-identity.sql", import.meta.url),
      "utf8",
    ),
  );
  await sql(
    await readFile(
      new URL("./singleton-vocabulary-undo.sql", import.meta.url),
      "utf8",
    ),
  );
  await sql(
    await readFile(new URL("./song-groups.sql", import.meta.url), "utf8"),
  );
  await sql(await readFile(new URL("./queue-loading.sql", import.meta.url), "utf8"));
  await sql(
    await readFile(new URL("./song-groups-scale.sql", import.meta.url), "utf8"),
  );
  // Exercise installed RPCs through actual PostgREST as well as administrative
  // SQL. All identities and assignments in this disposable fixture are synthetic.
  await sql(
    `select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
    select app.ensure_sources(1);
    update app.library_state set sources_discovered_at=now() where singleton;
    update app.sources set last_synced_at=now(),latest_completed_run_id='11111111-1111-4111-8111-111111111111' where epoch=1 and id='liked';
    insert into app.annotations(track_key,epoch) values(repeat('1',64),1),(repeat('2',64),1);
    insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id,duration_ms,explicit,playable_uri)
      values(repeat('1',64),repeat('1',22),'Synthetic REST song','[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic artist"}]','Synthetic release',now(),'11111111-1111-4111-8111-111111111111',180000,false,'spotify:track:'||repeat('1',22)),
      (repeat('2',64),repeat('2',22),'Synthetic REST song','[{"id":"aaaaaaaaaaaaaaaaaaaaaa","name":"Synthetic artist"}]','Synthetic release',now(),'11111111-1111-4111-8111-111111111111',180000,false,'spotify:track:'||repeat('2',22));
    insert into app.source_memberships values(1,'liked',repeat('1',64),now()),(1,'liked',repeat('2',64),now());
    select app.refresh_source_pool(1);`,
  );
  await command([
    "run",
    "--detach",
    "--name",
    rest,
    "--network",
    network,
    "--env",
    `PGRST_DB_URI=postgres://postgres@${container}:5432/postgres`,
    "--env",
    "PGRST_DB_ANON_ROLE=service_role",
    "--env",
    "PGRST_DB_SCHEMAS=public",
    "ghcr.io/supabase/postgrest:v16.4@sha256:d155c6718ed9a9f990d159a2ab7c0a3f16944dbb6d0a0344557421042acfe0df",
  ]);
  const rpc = async (name, args) =>
    JSON.parse(
      await command([
        "exec",
        container,
        "wget",
        "-q",
        "-O",
        "-",
        "--header=Content-Type: application/json",
        "--post-data=" + JSON.stringify(args),
        `http://${rest}:3000/rpc/${name}`,
      ]),
    );
  let sources;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      sources = await rpc("app_sources_list", { p_epoch: 1 });
      break;
    } catch {
      if (attempt === 59) {
        throw new Error("Synthetic Sources PostgREST startup failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (sources.uniqueTrackCount !== 1 || sources.items[0].uniqueCount !== 1) {
    throw new Error("Sources PostgREST did not deduplicate the pool");
  }
  const tag = await rpc("app_tag_create", {
    p_epoch: 1,
    p_name: "Synthetic REST tag",
  });
  const action = await rpc("app_tag_action", {
    p_epoch: 1,
    p_session_hash: "b".repeat(64),
    p_request: {
      action: "add",
      tagId: tag.tag.id,
      selection: { kind: "tracks", trackKeys: ["1".repeat(64)] },
    },
  });
  if (action.selectedCount !== 1 || action.changedCount !== 1) {
    throw new Error("Sources PostgREST logical tagging failed");
  }
  const undone = await rpc("app_tag_undo", {
    p_epoch: 1,
    p_session_hash: "b".repeat(64),
    p_action_id: action.actionId,
  });
  if (undone.restoredCount !== 1) {
    throw new Error("Sources PostgREST logical undo failed");
  }
  await rpc("app_sources_selection", {
    p_epoch: 1,
    p_ids: ["liked"],
    p_enabled: false,
  });
  const empty = await rpc("app_sources_list", { p_epoch: 1 });
  if (empty.uniqueTrackCount !== 0) {
    throw new Error("Sources PostgREST selection did not update eligibility");
  }
  if (
    await rpc("app_playback_track", {
      p_epoch: 1,
      p_track_key: "1".repeat(64),
    }) !== null
  ) {
    throw new Error("Disabled source remained eligible for playback");
  }
  console.log(
    "Synthetic source membership, recovery, selection, lease, retention, song identity, undo, restore, 10,000-track batches and actual PostgREST RPC invariants passed.",
  );
} finally {
  await command(["rm", "--force", "--volumes", rest]).catch(() => {});
  await command(["rm", "--force", "--volumes", container]).catch(() => {});
  await command(["network", "rm", network]).catch(() => {});
}
