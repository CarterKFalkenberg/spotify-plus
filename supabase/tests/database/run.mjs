// Disposable, synthetic PostgreSQL integration harness. Never reads .local or cloud credentials.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const container = `spotify-plus-sql-test-${process.pid}`;
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
function assert(condition, description) {
  if (!condition) throw new Error(description);
}
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
    await readFile(new URL("./foundation.sql", import.meta.url), "utf8"),
  );
  await sql(
    "select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic-ciphertext',now()+interval '1 hour',now(),repeat('b',64),true); select public.app_job_enqueue('synthetic',1) from generate_series(1,4);",
  );
  const claims = await Promise.all(
    Array.from({ length: 8 }, () => sql("select public.app_job_claim();")),
  );
  const jobs = claims.filter(Boolean).map(JSON.parse);
  assert(
    jobs.length === 4 && new Set(jobs.map((job) => job.id)).size === 4,
    "Concurrent workers must claim each job once",
  );
  const pacing = await Promise.all(
    Array.from(
      { length: 8 },
      () => sql("select public.app_pacing_acquire(1,5000);"),
    ),
  );
  assert(
    pacing.map(JSON.parse).filter((result) => result.granted).length === 1,
    "Concurrent pacing must grant one slot",
  );
  const refresh = await Promise.all(
    Array.from({ length: 8 }, () => sql("select public.app_token_claim(1,1);")),
  );
  assert(
    refresh.map(JSON.parse).filter((result) => result.action === "refresh")
      .length === 1,
    "Concurrent refresh must grant one lease",
  );
  assert(
    refresh.map(JSON.parse).filter((result) => result.action === "busy")
      .length === 7,
    "Concurrent refresh waiters must yield",
  );
  await sql("select public.app_disconnect(1);");
  const finish = await Promise.all(
    jobs.map((job) =>
      sql(
        `select public.app_job_finish('${job.id}','${job.leaseToken}','done');`,
      )
    ),
  );
  assert(
    finish.every((result) => result === "f"),
    "Concurrent old workers must stay cancelled",
  );
  console.log(
    "Synthetic PostgreSQL foundation, role-denial, leases, refresh, pacing, and disconnect checks passed.",
  );
} finally {
  await command(["rm", "--force", "--volumes", container]).catch(() => {});
}
