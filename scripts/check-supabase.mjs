// Isolated synthetic vendor-extension proof. Never links to or reads a hosted project.
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const workingTree = args.includes("--working-tree");
const paths = args.filter((argument) => argument !== "--working-tree");
if (paths.length > 1 || paths.some((path) => path.startsWith("--")))
  throw new Error("usage_check_supabase_optional_source_and_working_tree");
const source = paths[0] ? resolve(paths[0]) : root;
const snapshot = createHash("sha256");
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
        // Never persist raw vendor output: even disposable status output contains generated keys.
        // The dedicated REST child emits only a fixed phase blocker on failure.
        let blocker = `local_${executable}_failed`;
        if (executable === "deno") {
          try {
            const result = JSON.parse(errors.trim());
            if (/^local_rest_[a-z_]+_failed$/.test(result.blocker))
              blocker = result.blocker;
          } catch {
            /* Preserve a fixed blocker for unexpected tool output. */
          }
        }
        fail(new Error(blocker));
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
  // Snapshot only reviewed source roots. Never copy .local or read hosted configuration.
  const roots = [
    "supabase/migrations",
    "supabase/functions",
    "supabase/tests/database",
  ];
  const files = [
    ...new Set(
      execFileSync(
        "git",
        workingTree
          ? [
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "--",
              ...roots,
            ]
          : ["ls-tree", "-r", "--name-only", head, ...roots],
        { cwd: source, encoding: "utf8" },
      )
        .trim()
        .split("\n"),
    ),
  ].sort();
  if (!files.some((path) => path.endsWith("_scheduler_storage.sql")))
    throw new Error("foundation_migrations_required");
  for (const path of files) {
    if (!/\.(sql|ts|mjs)$/.test(path)) continue;
    const data = workingTree
      ? readFileSync(resolve(source, path))
      : execFileSync("git", ["show", `${head}:${path}`], { cwd: source });
    snapshot.update(path).update("\0").update(data).update("\0");
    mkdirSync(dirname(resolve(fixture, path)), { recursive: true });
    writeFileSync(resolve(fixture, path), data);
  }
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
  // Vendor SQL starts from the reset state; no HTTP probe pre-seeds its expected SHA.
  await sql(
    readFileSync(
      resolve(fixture, "supabase/tests/database/vendor.sql"),
      "utf8",
    ),
  );
  await sql(
    readFileSync(
      resolve(fixture, "supabase/tests/database/rest-fixture.sql"),
      "utf8",
    ),
  );
  const localStatus = JSON.parse(
    await command("supabase", [
      "status",
      "--workdir",
      fixture,
      "--output",
      "json",
    ]),
  );
  if (
    localStatus.API_URL !== "http://127.0.0.1:61021" ||
    typeof localStatus.SERVICE_ROLE_KEY !== "string" ||
    typeof localStatus.ANON_KEY !== "string"
  )
    throw new Error("local_status_contract_invalid");
  // Only the local PostgREST socket is permitted. Spotify is a synthetic injected fetch.
  // Generated local keys remain in memory and private stdin, never command arguments/output.
  const restProof = JSON.parse(
    await command(
      "deno",
      [
        "run",
        "--no-prompt",
        "--no-remote",
        "--allow-net=127.0.0.1:61021",
        resolve(fixture, "supabase/tests/database/rest.ts"),
      ],
      JSON.stringify({
        origin: localStatus.API_URL,
        serviceKey: localStatus.SERVICE_ROLE_KEY,
        anonKey: localStatus.ANON_KEY,
      }),
    ),
  );
  if (
    restProof.passed !== true ||
    !Number.isInteger(restProof.assertions) ||
    restProof.assertions < 1
  )
    throw new Error("local_rest_proof_missing");
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
    update app.runtime_health set last_scheduler_at=null,last_maintenance_at=null where singleton;`);
  const deadline = Date.now() + 80_000;
  while (!received && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 1000));
  if (!received) throw new Error("scheduled_authenticated_http_not_observed");
  const heartbeat = (
    await sql("select last_scheduler_at is not null from app.runtime_health;")
  ).trim();
  if (heartbeat !== "t") throw new Error("scheduled_heartbeat_not_recorded");
  // The genuine cron request ID must identify the observed pg_net response.
  // This local response comes from the authenticated synthetic receiver above;
  // deployed verification separately proves the real jobs handler and removal.
  let correlated = false;
  const responseDeadline = Date.now() + 10000;
  while (!correlated && Date.now() < responseDeadline) {
    correlated =
      (
        await sql(`select exists(select 1 from app.cron_dispatches d
      join net._http_response r on r.id=d.request_id
      where d.dispatched_at>now()-interval '2 minutes'
      and r.status_code=200 and not coalesce(r.timed_out,false) and r.error_msg is null);`)
      ).trim() === "t";
    if (!correlated) await new Promise((done) => setTimeout(done, 250));
  }
  if (!correlated) throw new Error("scheduled_response_not_correlated");
  console.log(
    JSON.stringify({
      passed: true,
      sourceSha: head,
      sourceMode: workingTree ? "working-tree" : "committed",
      snapshotSha: snapshot.digest("hex"),
      ...assertions,
      rest: restProof,
      scheduledAuthenticatedHttp: true,
      scheduledResponseCorrelated: true,
      browserRequired: false,
    }),
  );
} catch (error) {
  // JSON parse/tool exceptions can quote provider output. Emit only our fixed blockers.
  const blocker =
    /^(local_[a-z_]+|foundation_migrations_required|vendor_schema_assertion_failed|scheduled_authenticated_http_not_observed|scheduled_heartbeat_not_recorded|scheduled_response_not_correlated)$/.test(
      error?.message ?? "",
    )
      ? error.message
      : "local_vendor_proof_failed";
  console.error(
    JSON.stringify({
      passed: false,
      sourceSha: head,
      blocker,
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
