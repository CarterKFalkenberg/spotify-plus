import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  coreProofArguments,
  redactedCoreResult,
} from "../../scripts/verify-stage.mjs";
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it("core child has only configured origins and private registry files; atomic writer preserves mode600 and rejects stale temporary files", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "core-proof-synthetic-"));
  directories.push(directory);
  const path = resolve(directory, "registry.json"),
    sibling = resolve(directory, "unrelated.json"),
    script = resolve(directory, "probe.ts");
  writeFileSync(sibling, "synthetic sentinel");
  writeFileSync(
    script,
    `
 import {writeCoreRegistry} from ${JSON.stringify(new URL("../../scripts/live/core-proof.ts", import.meta.url).href)};
 import {newRegistry} from ${JSON.stringify(new URL("../../scripts/live/core-fixtures.ts", import.meta.url).href)};
 const r=newRegistry(1,"a".repeat(64));
 await writeCoreRegistry(${JSON.stringify(path)},r);
 await Deno.writeTextFile(${JSON.stringify(path + ".tmp")},"interrupted registry",{mode:0o600});
 let staleRejected=false,denied=0;
 try {await writeCoreRegistry(${JSON.stringify(path)},r);}catch {staleRejected=true;}
 for(const operation of [()=>Deno.readTextFile(${JSON.stringify(sibling)}),()=>Deno.writeTextFile(${JSON.stringify(sibling)},"changed")]) {
  try {await operation();}catch(error) {if(error instanceof Deno.errors.NotCapable)denied++;}
 }
 console.log(JSON.stringify({staleRejected,denied}));
 `,
  );
  const args = coreProofArguments(
    {
      appUrl: "https://synthetic.workers.dev",
      supabaseProjectRef: "abcdefghijklmnopqrst",
    },
    path,
  );
  expect(args.slice(2, 5)).toEqual([
    "--allow-net=synthetic.workers.dev,abcdefghijklmnopqrst.supabase.co,api.supabase.com,api.spotify.com,accounts.spotify.com",
    `--allow-read=${path},${path}.tmp,${path}.lock`,
    `--allow-write=${path},${path}.tmp,${path}.lock`,
  ]);
  args[args.length - 1] = script;
  expect(
    JSON.parse(
      execFileSync("deno", args, {
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      }),
    ),
  ).toEqual({ staleRejected: true, denied: 2 });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(sibling, "utf8")).toBe("synthetic sentinel");
  expect(readFileSync(path + ".tmp", "utf8")).toBe("interrupted registry");
});
it("only validated counts and fixed booleans can escape core child output", () => {
  const value = { passed: true };
  for (const key of [
    "automaticImportComplete",
    "stableManualSync",
    "protectedCoreRoutes",
    "isolatedTagging",
    "changedOnlyUndo",
    "filterRevisionGuard",
    "previewPacingCredentialObservationUnchanged",
    "privateSnapshot",
    "orderedSnapshot",
    "requestIntentDeduplicated",
    "pinUnpinExtend",
    "regeneratePreservesNameAndNotes",
    "acceleratedDeadline",
    "authenticatedScheduledExpiry",
    "removedByContains",
    "removedByCurrentUserPlaylists",
    "fixturesCleaned",
  ])
    value[key] = true;
  for (const key of [
    "progressObservations",
    "activeTracks",
    "previewMatches",
    "previewPlayable",
    "previewExcluded",
    "previewDurationMs",
  ])
    value[key] = 1;
  expect(
    redactedCoreResult({
      ...value,
      raw: "must never leave child",
      token: "synthetic",
    }),
  ).not.toHaveProperty("raw");
  expect(
    redactedCoreResult({
      ...value,
      raw: "must never leave child",
      token: "synthetic",
    }),
  ).not.toHaveProperty("token");
  for (const patch of [
    { passed: false },
    { fixturesCleaned: false },
    { previewPlayable: -1 },
    { previewDurationMs: "synthetic data" },
  ])
    expect(() => redactedCoreResult({ ...value, ...patch })).toThrow(
      "core_proof_receipt_invalid",
    );
});

it("core expiry waits natural maintenance without proof-side scheduler enqueue or invocation", () => {
  const proof = readFileSync(
    new URL("../../scripts/live/core-proof.ts", import.meta.url),
    "utf8",
  );
  expect(proof).not.toMatch(
    /app_job_enqueue|scheduler_tick|app_maintenance|library_maintenance|playlist_maintenance|\/functions\/v1\/jobs/,
  );
  const fixtureHelpers = readFileSync(
    new URL("../../scripts/live/core-fixtures.ts", import.meta.url),
    "utf8",
  );
  expect(fixtureHelpers).not.toMatch(
    /insert\s+into\s+app\.jobs|app_job_enqueue|scheduler_tick|app_maintenance|library_maintenance|playlist_maintenance/i,
  );
  expect(proof).toContain("await fixtureStatement(duePlaylistSql(r))");
  expect(proof).toContain("await waitRemoved(r, 240)");
  expect(proof).toContain("join net._http_response h on h.id=d.request_id");
  const orchestration = readFileSync(
    new URL("../../scripts/verify-stage.mjs", import.meta.url),
    "utf8",
  );
  const apiOnly = orchestration.slice(
    orchestration.indexOf('if (stage === "api-proof") {'),
  );
  expect(apiOnly.indexOf('rpc("app_job_enqueue"')).toBeGreaterThan(0);
  expect(
    orchestration.slice(
      0,
      orchestration.indexOf('if (stage === "api-proof") {'),
    ),
  ).not.toContain('rpc("app_job_enqueue"');
});
