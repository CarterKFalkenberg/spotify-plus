// Disposable, synthetic PostgreSQL integration harness. Never reads .local or cloud credentials.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const container = `spotify-plus-sources-test-${process.pid}`;
const network = container + "-network";
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
    await readFile(new URL("./song-groups.sql", import.meta.url), "utf8"),
  );
  await sql(
    await readFile(new URL("./song-groups-scale.sql", import.meta.url), "utf8"),
  );
  console.log(
    "Synthetic source membership, recovery, selection, lease, retention, song identity, undo, restore and 10,000-track batch invariants passed.",
  );
} finally {
  await command(["rm", "--force", "--volumes", container]).catch(() => {});
  await command(["network", "rm", network]).catch(() => {});
}
