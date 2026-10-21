// Disposable, synthetic PostgreSQL integration harness. Never reads .local or cloud credentials.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const container = `spotify-plus-fast-tagging-test-${process.pid}`;
const network = container + "-network";
const rest = container + "-rest";
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function command(args, input = "", executable = "docker") {
  const child = spawn(executable, args, {
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
  if (status !== 0) throw new Error(`Synthetic test command failed: ${errors}`);
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
      "20261011000800_expire_failed_reconciliation.sql",
      "20261011000900_artwork.sql",
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
  await sql(
    await readFile(new URL("./artwork.sql", import.meta.url), "utf8"),
  );
  // The same mandatory-rollback proof used on deployment runs against synthetic
  // installed SQL here. The outer transaction supplies an isolated owner only.
  const deployedFastSql = await command(
    [
      "eval",
      "--no-remote",
      'import {newRegistry} from "./scripts/live/core-fixtures.ts"; ' +
      'import {fastProofSql} from "./scripts/live/fast-proof-sql.ts"; ' +
      'console.log(fastProofSql(newRegistry(1,"a".repeat(64))));',
    ],
    "",
    "deno",
  );
  await sql(
    "begin; select public.app_connect(1,'synthetic-account',repeat('a',64),true,'synthetic',now()+interval '1 hour',now(),repeat('b',64),true); " +
      "update app.jobs set state='done' where id is not null; " +
      deployedFastSql + " rollback;",
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
    // Same v16.4 bytes as ECR, without its shared download quota; see IMAGES.md.
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
  // These are intentionally valid cache names outside the old filter-name limit.
  // Equal long prefixes must not merge, and blank names must never select all.
  const albums = [
    "",
    " \t\n ",
    "\u00a0\u2003\ufeff",
    "Synthetic Album",
    "synthetic  album",
    "🎷".repeat(240) + "a",
    "🎷".repeat(240) + "b",
    "Café",
    "Cafe\u0301",
  ];
  const albumIdentity = (name) =>
    "album:" + createHash("sha256")
      .update(name.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase())
      .digest("hex");
  const expectedKeys = new Map();
  const albumRows = albums.map((album, index) => ({
    album,
    trackKey: (index + 2).toString().padStart(64, "0"),
  }));
  for (const { album, trackKey: key } of albumRows) {
    const value = albumIdentity(album);
    expectedKeys.set(value, [...(expectedKeys.get(value) ?? []), key]);
  }
  await sql(`
    insert into app.annotations(track_key,epoch)
      select (fixture->>'trackKey'),1 from jsonb_array_elements(${
    literal(albumRows)
  }) fixture;
    insert into app.track_metadata(track_key,spotify_id,title,artists,album,liked_at,added_run_id)
      select fixture->>'trackKey',lpad(ord::text,22,'0'),'Synthetic album fixture','[]'::jsonb,fixture->>'album',now(),'11111111-1111-4111-8111-111111111111'::uuid
      from jsonb_array_elements(${
    literal(albumRows)
  }) with ordinality as fixtures(fixture,ord);
  `);
  const albumFilter = {
    membership: "active",
    search: "",
    untagged: false,
    newOnly: false,
    artistId: null,
  };
  const groups = await rpc("app_library_search", {
    p_epoch: 1,
    p_request: {
      filter: albumFilter,
      groupBy: "album",
      cursor: null,
      limit: 100,
    },
  });
  const albumFacets = await rpc("app_library_facets", {
    p_epoch: 1,
    p_request: {
      filter: albumFilter,
      facet: "album",
      cursor: null,
      limit: 100,
    },
  });
  if (
    groups.totalTracks !== albums.length ||
    groups.totalGroups !== expectedKeys.size ||
    albumFacets.totalOptions !== expectedKeys.size
  ) {
    throw new Error("Album groups/facets lost cache names");
  }
  const albumTag = await rpc("app_tag_create", {
    p_epoch: 1,
    p_name: "Album roundtrip",
  });
  for (const row of [...groups.groups, ...albumFacets.options]) {
    const keys = expectedKeys.get(row.value);
    if (
      !keys || row.trackCount !== keys.length ||
      (row.value === albumIdentity("") && row.name !== "Album unavailable")
    ) {
      throw new Error("Album response identity/count mismatch");
    }
    const current = await rpc("app_library_status", { p_epoch: 1 });
    const selection = row.selection ?? {
      kind: "filter",
      filter: { ...albumFilter, album: row.value },
    };
    // Parse the real SQL response through the same boundary as the HTTP route.
    const request = JSON.parse(
      await command(
        [
          "eval",
          "--no-remote",
          'import { parseTagAction } from "./supabase/functions/_shared/contracts.ts"; ' +
          "const raw = await new Response(Deno.stdin.readable).json(); " +
          "console.log(JSON.stringify(parseTagAction(raw)));",
        ],
        JSON.stringify({
          selection: { ...selection, expectedRevision: current.revision },
          action: "add",
          tagId: albumTag.tag.id,
        }),
        "deno",
      ),
    );
    const result = await rpc("app_tag_action", {
      p_epoch: 1,
      p_session_hash: "b".repeat(64),
      p_request: request,
    });
    const actual = JSON.parse(
      await sql(
        `select coalesce(jsonb_agg(track_key order by track_key),'[]'::jsonb) from app.track_tags where tag_id='${albumTag.tag.id}' and present;`,
      ),
    );
    if (
      result.selectedCount !== keys.length ||
      result.changedCount !== keys.length ||
      JSON.stringify(actual) !== JSON.stringify([...keys].sort())
    ) {
      throw new Error("Returned album selection mutated a different set");
    }
    const undone = await rpc("app_tag_undo", {
      p_epoch: 1,
      p_session_hash: "b".repeat(64),
      p_action_id: result.actionId,
    });
    if (undone.restoredCount !== keys.length || undone.skippedCount !== 0) {
      throw new Error("Album roundtrip undo failed");
    }
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
