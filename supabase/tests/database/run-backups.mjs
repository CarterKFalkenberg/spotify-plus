// Disposable, synthetic PostgreSQL integration harness. Never reads .local or cloud credentials.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const container = `spotify-plus-backups-test-${process.pid}`;
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
      "20261011000600_fast_tagging.sql",
      "20261011000800_expire_failed_reconciliation.sql",
    ]
  ) {
    await sql(
      await readFile(
        migration === "20261011000600_fast_tagging.sql" &&
          process.env.SYNTHETIC_FAST_MIGRATION
          ? process.env.SYNTHETIC_FAST_MIGRATION
          : new URL("../../migrations/" + migration, import.meta.url),
        "utf8",
      ),
    );
  }
  // Minimal metadata stand-in tests FK transactions independently; actual vendor
  // Storage API/FK proof is a separate root-coordinated acceptance gate.
  await sql(`create schema storage;
    create table storage.buckets(id text primary key);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
    insert into storage.buckets values('annotation-backups');`);
  await sql(
    await readFile(
      new URL(
        "../../migrations/20261011000700_annotation_backups.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await sql(await readFile(new URL("./backups.sql", import.meta.url), "utf8"));
  await sql(
    `select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
    update app.library_state set encrypted_annotation_key='synthetic-key' where singleton;
    delete from app.jobs where id is not null;
    insert into app.jobs(kind,epoch) values('annotation_backup',1);`,
  );
  const job = JSON.parse(await sql("select public.app_job_claim();"));
  const plan = JSON.parse(
    await sql(
      `select public.app_backup_prepare(1,'${job.id}','${job.leaseToken}');`,
    ),
  );
  const id = plan.snapshot.id;
  const bucket = `annotation-backups-e1-${id}`;
  const args = `1,'${job.id}','${job.leaseToken}','${id}'`;
  const starts = await Promise.all(
    Array.from(
      { length: 6 },
      () => sql(`select public.app_backup_bucket_start(${args});`),
    ),
  );
  if (starts.filter((v) => v === "t").length !== 1) {
    throw new Error("Concurrent bucket creation must grant exactly one POST");
  }
  await sql(
    `insert into storage.buckets values('${bucket}');select public.app_backup_upload_allowed(${args});
    select public.app_backup_commit(${args},0,encode(sha256(convert_to('synthetic-key','UTF8')),'hex'));`,
  );
  const snapshot = {
    ...plan.snapshot,
    keyLink: await sql(
      "select encode(sha256(convert_to('synthetic-key','UTF8')),'hex');",
    ),
  };
  const literal = (value) =>
    "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
  // Independent restore transactions at the same expected revision cannot both win.
  const restores = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      sql(
        `select public.app_backup_restore(1,repeat('a',64),0,${
          literal(snapshot)
        });`,
      )),
  );
  if (
    restores.filter((v) => v.status === "fulfilled").length !== 1 ||
    restores.filter((v) =>
        v.status === "rejected" && v.reason.message.includes("stale_revision")
      ).length !== 3
  ) throw new Error("Restore must serialize expected revision");
  // Hold the account lock while disconnect commits; a waiting restore must fail
  // owner/epoch fencing and cannot resurrect purged state.
  const disconnect = sql(
    `begin;select 1 from app.account for update;select pg_advisory_xact_lock(27007);select pg_sleep(1);select public.app_disconnect(1);commit;`,
  );
  let locked = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (
      await sql(
        "select exists(select 1 from pg_locks where locktype='advisory' and objid=27007 and granted);",
      ) === "t"
    ) {
      locked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!locked) throw new Error("Disconnect lock was not observed");
  const restore = sql(
    `select public.app_backup_restore(1,repeat('a',64),1,${
      literal(snapshot)
    });`,
  ).then(() => {
    throw new Error("Restore crossed disconnect");
  }, (error) => {
    if (!error.message.includes("inactive_epoch")) throw error;
  });
  await Promise.all([disconnect, restore]);
  if (await sql("select count(*) from app.library_state;") !== "0") {
    throw new Error("Disconnected annotation state resurrected");
  }
  // Bucket FK is the serialization fence. Delayed object metadata insertion either
  // blocks bucket deletion or fails after its committed deletion.
  await sql(`delete from storage.buckets where id='${bucket}';`);
  const late = await Promise.allSettled([
    sql(
      `insert into storage.objects(bucket_id,name) values('${bucket}','late');`,
    ),
  ]);
  if (
    late[0].status !== "rejected" ||
    !late[0].reason.message.includes("foreign key")
  ) throw new Error("Late upload metadata bypassed deleted bucket fence");
  if (await sql("select public.app_disconnect_finish(2);") !== "t") {
    throw new Error("Verified empty disconnect did not finish");
  }
  if (await sql(`select public.app_backup_upload_allowed(${args});`) !== "f") {
    throw new Error("Late worker lease crossed disconnect");
  }
  console.log(
    "Synthetic backup SQL strict restore, daily retention, leases and independent transaction races passed; vendor Storage proof remains separate.",
  );
} finally {
  await command(["rm", "--force", "--volumes", container]).catch(() => {});
}
