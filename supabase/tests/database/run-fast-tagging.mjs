// Disposable, synthetic PostgreSQL integration harness. Never reads .local or cloud credentials.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const container = `spotify-plus-fast-tagging-test-${process.pid}`;
const network = container + "-network";
const rest = container + "-rest";
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
    await readFile(new URL("./fast-tagging.sql", import.meta.url), "utf8"),
  );
  await sql(`
    select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true);
    insert into app.annotations values(repeat('1',64),1);
    insert into app.tags(id,epoch,name,normalized_name) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'Synthetic','synthetic');
    insert into app.track_tags(track_key,tag_id,present) values(repeat('1',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  `);
  const revision = JSON.parse(await sql("select app.library_revision();"));
  const literal = (value) =>
    "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
  const race = await Promise.allSettled(
    ["One", "Two"].map((name) =>
      sql(
        `select public.app_tags_manage(1,repeat('b',64),${
          literal({
            action: "rename",
            tagId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name,
            expectedRevision: revision,
          })
        });`,
      )
    ),
  );
  if (
    race.filter((r) => r.status === "fulfilled").length !== 1 ||
    race.filter((r) =>
        r.status === "rejected" && r.reason.message.includes("stale_revision")
      ).length !== 1
  ) throw new Error("Vocabulary revision race failed");
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
    "public.ecr.aws/supabase/postgrest:v16.4",
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
  let status;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      status = await rpc("app_library_status", { p_epoch: 1 });
      break;
    } catch {
      if (attempt === 59) throw new Error("Synthetic PostgREST startup failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!status?.revision) throw new Error("Missing PostgREST library revision");
  const vocabulary = await rpc("app_tags_vocabulary", {
    p_epoch: 1,
    p_request: { search: "", sort: "mostUsed", cursor: null, limit: 9 },
  });
  if (
    vocabulary.tags.length !== 1 ||
    vocabulary.tags[0].id !== "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  ) throw new Error("PostgREST vocabulary projection failed");
  const selection = await rpc("app_tags_selection", {
    p_epoch: 1,
    p_request: {
      selection: { kind: "tracks", trackKeys: ["1".repeat(64)] },
      tagIds: [vocabulary.tags[0].id],
      expectedRevision: status.revision,
    },
  });
  if (
    selection.tags[0].state !== "all" || selection.tags[0].assignedCount !== 1
  ) throw new Error("PostgREST tri-state failed");
  const preview = await rpc("app_tags_manage_preview", {
    p_epoch: 1,
    p_request: {
      action: "delete",
      tagId: vocabulary.tags[0].id,
      expectedRevision: status.revision,
    },
  });
  const deleted = await rpc("app_tags_manage", {
    p_epoch: 1,
    p_session_hash: "b".repeat(64),
    p_request: {
      action: "delete",
      tagId: vocabulary.tags[0].id,
      expectedRevision: status.revision,
      confirmedAssignmentCount: preview.assignmentCount,
    },
  });
  const undo = await rpc("app_tag_undo", {
    p_epoch: 1,
    p_session_hash: "b".repeat(64),
    p_action_id: deleted.actionId,
  });
  if (undo.restoredCount !== 1) throw new Error("PostgREST delete undo failed");
  const facets = await rpc("app_library_facets", {
    p_epoch: 1,
    p_request: {
      filter: {
        membership: "active",
        search: "",
        untagged: false,
        newOnly: false,
        artistId: null,
      },
      facet: "decade",
      cursor: null,
      limit: 10,
    },
  });
  if (facets.totalOptions !== 0) {
    throw new Error("PostgREST empty facets failed");
  }
  await sql("set role anon;"); // Separate direct privilege check below, independent of test-only REST role.
  if (
    await sql(
      "select has_function_privilege('anon','public.app_tags_manage(bigint,text,jsonb)','EXECUTE');",
    ) !== "f"
  ) throw new Error("Anonymous vocabulary write privilege leaked");
  console.log(
    "Synthetic fast-tagging PostgreSQL/PostgREST transactions, revision race and role boundaries passed.",
  );
} finally {
  await command(["rm", "--force", "--volumes", rest]).catch(() => {});
  await command(["rm", "--force", "--volumes", container]).catch(() => {});
  await command(["network", "rm", network]).catch(() => {});
}
