// Isolated synthetic vendor-extension proof. Never links to or reads a hosted project.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2] ? resolve(process.argv[2]) : root;
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
}).trim();
const fixture = mkdtempSync(resolve(tmpdir(), "spotify-plus-vendor-"));
const project = `spotify-plus-proof-${randomBytes(4).toString("hex")}`;
const container = `supabase_db_${project}`;
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOCKER_HOST: process.env.DOCKER_HOST,
  CI: "true",
  NO_COLOR: "1",
};
function command(executable, args, input = undefined) {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, {
      cwd: fixture,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    child.on("error", () => fail(new Error("local_tool_unavailable")));
    child.on("close", (code) => {
      if (code !== 0) {
        // Isolated synthetic stack only; private log allows debugging without printing generated keys.
        writeFileSync(resolve(fixture, "failure.log"), output + errors, {
          mode: 0o600,
        });
        fail(new Error(`local_${executable}_failed`));
      } else done(output);
    });
    child.stdin.end(input);
  });
}
const sql = (query) =>
  command(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    query,
  );
const secret = randomBytes(32).toString("hex");
let received = false;
const server = createServer((req, res) => {
  if (
    req.method === "POST" &&
    req.url === "/functions/v1/jobs" &&
    req.headers["x-cron-secret"] === secret
  )
    received = true;
  res.writeHead(received ? 200 : 401, { "content-type": "application/json" });
  res.end("{}");
});
let started = false;
try {
  mkdirSync(resolve(fixture, "supabase/migrations"), { recursive: true });
  const files = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", head, "supabase/migrations"],
    { cwd: source, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  if (!files.some((path) => path.endsWith("_scheduler_storage.sql")))
    throw new Error("foundation_migrations_required");
  for (const path of files)
    writeFileSync(
      resolve(fixture, path),
      execFileSync("git", ["show", `${head}:${path}`], { cwd: source }),
    );
  writeFileSync(
    resolve(fixture, "supabase/config.toml"),
    `project_id = "${project}"
[api]
enabled = true
port = 61021
schemas = ["public"]
extra_search_path = ["public", "extensions"]
[db]
port = 61022
shadow_port = 61023
major_version = 17
[db.pooler]
enabled = false
port = 61029
[db.seed]
enabled = false
[studio]
enabled = false
port = 61024
[local_smtp]
enabled = false
port = 61025
[analytics]
enabled = false
port = 61028
[realtime]
enabled = false
[storage]
enabled = true
[auth]
enabled = true
site_url = "http://127.0.0.1:61021"
[edge_runtime]
enabled = false
`,
  );
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(61030, "0.0.0.0", done);
  });
  started = true;
  await command("supabase", [
    "start",
    "--workdir",
    fixture,
    "--exclude",
    "studio,realtime,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor",
  ]);
  await command("supabase", [
    "db",
    "reset",
    "--local",
    "--workdir",
    fixture,
    "--yes",
  ]);
  const vendorSql = execFileSync(
    "git",
    ["show", `${head}:supabase/tests/database/vendor.sql`],
    { cwd: source, encoding: "utf8" },
  );
  await sql(vendorSql);
  const result = await sql(`select json_build_object(
    'cron',exists(select 1 from pg_extension where extname='pg_cron'),
    'net',exists(select 1 from pg_extension where extname='pg_net'),
    'vault',exists(select 1 from pg_extension where extname='supabase_vault'),
    'privateBucket',exists(select 1 from storage.buckets where id='annotation-backups' and not public),
    'scheduled',exists(select 1 from cron.job where jobname='spotify-plus-due-work' and active and schedule='* * * * *'),
    'schedulerNotPublic',not has_function_privilege('anon','app.scheduler_tick()','execute') and not has_function_privilege('authenticated','app.scheduler_tick()','execute')
  );`);
  const assertions = JSON.parse(result.trim());
  if (Object.values(assertions).some((value) => value !== true))
    throw new Error("vendor_schema_assertion_failed");
  // Vault and pg_net are exercised by an actual cron tick. No browser or app loop invokes it.
  // Docker Desktop exposes host.docker.internal; on Linux use the bridge host gateway.
  const host =
    process.platform === "darwin"
      ? "host.docker.internal"
      : (
          await command("docker", [
            "network",
            "inspect",
            `supabase_network_${project}`,
            "--format",
            "{{(index .IPAM.Config 0).Gateway}}",
          ])
        ).trim();
  await sql(`select vault.create_secret('http://${host}:61030','spotify_plus_project_url');
    select vault.create_secret('${secret}','spotify_plus_cron_secret');
    update app.runtime_health set last_scheduler_at=null;`);
  const deadline = Date.now() + 80_000;
  while (!received && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 1000));
  if (!received) throw new Error("scheduled_authenticated_http_not_observed");
  const heartbeat = (
    await sql("select last_scheduler_at is not null from app.runtime_health;")
  ).trim();
  if (heartbeat !== "t") throw new Error("scheduled_heartbeat_not_recorded");
  console.log(
    JSON.stringify({
      passed: true,
      sourceSha: head,
      ...assertions,
      scheduledAuthenticatedHttp: true,
      browserRequired: false,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      sourceSha: head,
      blocker: error.message,
      diagnosticDirectory: fixture,
    }),
  );
  process.exitCode = 1;
} finally {
  server.close();
  if (started) {
    try {
      await command("supabase", ["stop", "--workdir", fixture, "--no-backup"]);
    } catch {
      console.error(
        JSON.stringify({
          passed: false,
          blocker: "local_stack_teardown_failed",
          project,
        }),
      );
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) rmSync(fixture, { recursive: true, force: true });
}
