// Disposable, synthetic PostgreSQL integration harness. Never reads .local or cloud credentials.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const container = `spotify-plus-playlists-test-${process.pid}`;
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function command(args, input = "") {
  const child = spawn("docker", args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", errors = "";
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
  if (status !== 0) throw new Error(`Synthetic SQL command failed: ${errors}`);
  return output.trim();
}
const sql = (statement) =>
  command([
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
  ], statement);
try {
  await command([
    "run",
    "--detach",
    "--name",
    container,
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
    ]
  ) {
    await sql(
      await readFile(
        new URL("../../migrations/" + migration, import.meta.url),
        "utf8",
      ),
    );
  }
  await sql(
    await readFile(new URL("./playlists.sql", import.meta.url), "utf8"),
  );
  // Independent connections exercise row-lock serialization, not just sequential SQL.
  await sql(`
    select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
    update app.library_state set initial_sync_complete=true where singleton;
    insert into app.annotations values(repeat('1',64),1);
    insert into app.tags(id,epoch,name,normalized_name) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'Synthetic','synthetic');
    insert into app.track_tags(track_key,tag_id,present) values(repeat('1',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
    insert into app.track_metadata(track_key,spotify_id,title,artists,album,playable_uri,liked_at,added_run_id)
      values(repeat('1',64),repeat('1',22),'Synthetic','[]','Synthetic','spotify:track:'||repeat('1',22),now(),gen_random_uuid());
  `);
  const request = {
    requestId: "11111111-1111-4111-8111-111111111111",
    query: {
      version: 1,
      root: { op: "tag", tagId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    },
    previewRevision: { library: "0", annotations: "0" },
    name: "Synthetic concurrent snapshot",
    retention: "month",
  };
  const literal = (value) =>
    "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
  const duplicateResults = await Promise.all(
    Array.from(
      { length: 8 },
      () => sql(`select public.app_playlist_create(1,${literal(request)});`),
    ),
  );
  if (
    new Set(duplicateResults).size !== 1 ||
    await sql("select count(*) from app.playlists;") !== "1"
  ) {
    throw new Error(
      "Concurrent same UUID must produce one identical durable operation",
    );
  }
  const created = JSON.parse(duplicateResults[0]);
  const claim = JSON.parse(await sql("select public.app_job_claim();"));
  await sql(
    `select public.app_playlist_checkpoint('${claim.id}','${claim.leaseToken}','{"spotifyId":"pppppppppppppppppppppp"}');
    select public.app_playlist_complete('${claim.id}','${claim.leaseToken}',app.playlist_expiry(now(),'month'),'Synthetic');
    select public.app_job_finish('${claim.id}','${claim.leaseToken}','done');`,
  );
  const expectedRevision = await sql(
    `select revision from app.playlists where id='${created.playlist.id}';`,
  );
  const mutations = await Promise.allSettled(
    ["pin", "regenerate"].map((action, i) =>
      sql(
        `select public.app_playlist_action(1,'${created.playlist.id}',${
          literal({
            requestId: `22222222-2222-4222-8222-22222222222${i}`,
            expectedRevision,
            action,
          })
        });`,
      )
    ),
  );
  if (
    mutations.filter((r) => r.status === "fulfilled").length !== 1 ||
    mutations.filter((r) =>
        r.status === "rejected" && r.reason.message.includes("stale_revision")
      ).length !== 1 ||
    await sql(
        "select count(*) from app.playlist_operations where state='active';",
      ) !== "1"
  ) {
    throw new Error(
      "Concurrent pin/regenerate must accept exactly one expected revision",
    );
  }
  const active = JSON.parse(await sql("select public.app_job_claim();"));
  await sql(
    `select public.app_playlist_complete('${active.id}','${active.leaseToken}',(select app.playlist_expiry(now(),retention) from app.playlist_operations where job_id='${active.id}'),'Synthetic');
    select public.app_job_finish('${active.id}','${active.leaseToken}','done');
    update app.playlists set retention='month',expires_on=(now() at time zone 'America/New_York')::date-1 where id='${created.playlist.id}';`,
  );
  const revision = await sql(
    `select revision from app.playlists where id='${created.playlist.id}';`,
  );
  const cleanupRace = await Promise.allSettled([
    sql("select public.app_playlist_schedule();"),
    sql(
      `select public.app_playlist_action(1,'${created.playlist.id}',${
        literal({
          requestId: "33333333-3333-4333-8333-333333333333",
          expectedRevision: revision,
          action: "pin",
        })
      });`,
    ),
  ]);
  for (const result of cleanupRace) {
    if (
      result.status === "rejected" &&
      !result.reason.message.includes("stale_revision")
    ) throw result.reason;
  }
  if (
    await sql(
      "select count(*) from app.playlist_operations where state='active';",
    ) !== "1"
  ) {
    throw new Error(
      "Concurrent expiry and pin must not create competing operations",
    );
  }
  console.log(
    "Synthetic playlist SQL lifecycle, request deduplication, snapshots, leases, expiry and disconnect checks passed.",
  );
} finally {
  await command(["rm", "--force", "--volumes", container]).catch(() => {});
}
