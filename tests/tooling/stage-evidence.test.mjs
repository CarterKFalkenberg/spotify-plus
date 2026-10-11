import { expect, it } from "vitest";
import {
  validateIsolatedBackup,
  validateSoftwareChecks,
} from "../../scripts/live/stage-evidence.mjs";
import {
  fastProofArguments,
  redactedFastResult,
} from "../../scripts/verify-stage.mjs";
const head = "a".repeat(40),
  snapshot = "b".repeat(64),
  now = Date.now();
const software = {
  source: "orchestrator-scripts-check",
  buildSha: head,
  verifiedAt: new Date(now).toISOString(),
  passed: true,
  fullCheck: true,
  syntheticBrowser: true,
};
const backup = {
  source: "scripts/check-supabase.mjs",
  buildSha: head,
  verifiedAt: software.verifiedAt,
  passed: true,
  checker: {
    passed: true,
    sourceMode: "committed",
    sourceSha: head,
    snapshotSha: snapshot,
    scheduledAuthenticatedHttp: true,
    scheduledResponseCorrelated: true,
    annotationBackups: {
      status: "passed",
      assertions: 40,
      storageRaceIterations: 4,
      isolatedRestore: true,
      lateUploadRejected: true,
      lateUploadHttpStatus: 400,
    },
  },
};
it("requires fresh exact-head complete checks and rejects future, absent, stale or partial evidence", () => {
  expect(validateSoftwareChecks(software, head, now)).toEqual({
    fullCheck: true,
    syntheticBrowser: true,
  });
  for (const patch of [
    { buildSha: "c".repeat(40) },
    { verifiedAt: new Date(now + 1).toISOString() },
    { verifiedAt: new Date(now - 3600001).toISOString() },
    { syntheticBrowser: false },
    { fullCheck: false },
    { source: "agent-report" },
  ])
    expect(() =>
      validateSoftwareChecks({ ...software, ...patch }, head, now),
    ).toThrow();
});
it("binds actual isolated Storage/restore proof to committed source and rejects stand-ins or missing fence HTTP", () => {
  expect(
    validateIsolatedBackup(backup, head, snapshot, now)
      .actualEncryptedIsolatedRestore,
  ).toBe(true);
  for (const patch of [
    { sourceMode: "working-tree" },
    { snapshotSha: "c".repeat(64) },
    { sourceSha: "c".repeat(40) },
    { scheduledResponseCorrelated: false },
    {
      annotationBackups: {
        ...backup.checker.annotationBackups,
        lateUploadHttpStatus: null,
      },
    },
    {
      annotationBackups: {
        ...backup.checker.annotationBackups,
        storageRaceIterations: 3,
      },
    },
    {
      annotationBackups: {
        ...backup.checker.annotationBackups,
        isolatedRestore: false,
      },
    },
  ])
    expect(() =>
      validateIsolatedBackup(
        { ...backup, checker: { ...backup.checker, ...patch } },
        head,
        snapshot,
        now,
      ),
    ).toThrow();
});
it("fast child cannot dispatch to Spotify or read credential files and output is a fixed projection", () => {
  const args = fastProofArguments(
    { appUrl: "https://synthetic.workers.dev" },
    "/private/registry",
  );
  expect(args[2]).toBe("--allow-net=synthetic.workers.dev,api.supabase.com");
  expect(args[3]).toBe(
    "--allow-read=/private/registry,/private/registry.tmp,/private/registry.lock",
  );
  const proof = {
    passed: true,
    transactionalFastTagging: true,
    fixturesRolledBack: true,
    authenticatedFastReads: true,
    assertions: 20,
    metadata: "synthetic sentinel",
  };
  expect(redactedFastResult(proof)).not.toHaveProperty("metadata");
  expect(() =>
    redactedFastResult({ ...proof, fixturesRolledBack: false }),
  ).toThrow();
});
