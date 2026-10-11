import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spotifyProofArguments } from "../../scripts/verify-stage.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(
    resolve(tmpdir(), "spotify-permissions-synthetic-"),
  );
  directories.push(directory);
  const registry = resolve(directory, "registry.json");
  const sibling = resolve(directory, "unrelated.json");
  writeFileSync(sibling, "synthetic unrelated file");
  const script = resolve(directory, "proof.ts");
  const implementation = new URL(
    "../../scripts/live/spotify-proof.ts",
    import.meta.url,
  ).href;
  writeFileSync(
    script,
    `
    import { writeRegistry } from ${JSON.stringify(implementation)};
    let saved = false, renameDenied = false, deniedSiblings = 0;
    try {
      await writeRegistry(${JSON.stringify(registry)}, {
        operation: "synthetic-operation", epoch: 1, ownerFingerprint: "synthetic-owner",
        playlistId: null, status: "creating",
      });
      saved = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotCapable)) throw new Error("unexpected_registry_failure");
      renameDenied = true;
    }
    for (const operation of [
      () => Deno.readTextFile(${JSON.stringify(sibling)}),
      () => Deno.writeTextFile(${JSON.stringify(sibling)}, "must remain unchanged"),
    ]) {
      try { await operation(); }
      catch (error) {
        if (!(error instanceof Deno.errors.NotCapable)) throw new Error("unexpected_sibling_failure");
        deniedSiblings++;
      }
    }
    console.log(JSON.stringify({ saved, renameDenied, deniedSiblings }));
  `,
  );
  const args = spotifyProofArguments(
    { supabaseProjectRef: "abcdefghijklmnopqrst" },
    registry,
  );
  // Execute the same permission flags and the actual registry implementation,
  // substituting only a synthetic entrypoint which never calls Spotify or a DB.
  args[args.length - 1] = script;
  const run = () =>
    JSON.parse(
      execFileSync("deno", args, {
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      }),
    );
  return { registry, sibling, args, run };
}
it("actual registry rename succeeds with narrowly scoped production permissions and denies sibling access", () => {
  const { registry, sibling, args, run } = fixture();
  expect(args.filter((arg) => arg.startsWith("--allow-"))).toEqual([
    "--allow-net=abcdefghijklmnopqrst.supabase.co,api.spotify.com,accounts.spotify.com",
    `--allow-read=${registry},${registry}.tmp`,
    `--allow-write=${registry},${registry}.tmp`,
  ]);
  expect(run()).toEqual({
    saved: true,
    renameDenied: false,
    deniedSiblings: 2,
  });
  expect(JSON.parse(readFileSync(registry, "utf8"))).toMatchObject({
    operation: "synthetic-operation",
    status: "creating",
    playlistId: null,
  });
  expect(existsSync(registry + ".tmp")).toBe(false);
  expect(readFileSync(sibling, "utf8")).toBe("synthetic unrelated file");
});
it("omitting read permission for the temporary source reproduces the pre-create rename failure", () => {
  const { registry, args, run } = fixture();
  args[args.findIndex((arg) => arg.startsWith("--allow-read="))] =
    `--allow-read=${registry}`;
  expect(run()).toEqual({
    saved: false,
    renameDenied: true,
    deniedSiblings: 2,
  });
  expect(existsSync(registry)).toBe(false);
  expect(JSON.parse(readFileSync(registry + ".tmp", "utf8"))).toMatchObject({
    status: "creating",
    playlistId: null,
  });
});
