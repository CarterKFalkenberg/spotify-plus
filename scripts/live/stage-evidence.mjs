import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { requireCheck } from "./config.mjs";
export function committedBackupSnapshot(root, head) {
  const files = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "--name-only",
      head,
      "supabase/migrations",
      "supabase/functions",
      "supabase/tests/database",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter((path) => /\.(sql|ts|mjs)$/.test(path))
    .sort();
  const hash = createHash("sha256");
  for (const path of files)
    hash
      .update(path)
      .update("\0")
      .update(execFileSync("git", ["show", `${head}:${path}`], { cwd: root }))
      .update("\0");
  return hash.digest("hex");
}
function fresh(value, head, now, code) {
  const time = Date.parse(value?.verifiedAt);
  requireCheck(
    value?.buildSha === head &&
      value.passed === true &&
      Number.isFinite(time) &&
      time <= now &&
      now - time <= 60 * 60_000,
    code,
  );
}
export function validateSoftwareChecks(value, head, now = Date.now()) {
  fresh(value, head, now, "fresh_exact_head_software_checks_required");
  requireCheck(
    value.source === "orchestrator-scripts-check" &&
      value.fullCheck === true &&
      value.syntheticBrowser === true,
    "full_synthetic_checks_required",
  );
  return { fullCheck: true, syntheticBrowser: true };
}
export function validateIsolatedBackup(
  value,
  head,
  snapshot,
  now = Date.now(),
) {
  fresh(value, head, now, "fresh_isolated_backup_evidence_required");
  const proof = value.checker;
  requireCheck(
    value.source === "scripts/check-supabase.mjs" &&
      proof?.passed === true &&
      proof.sourceMode === "committed" &&
      proof.sourceSha === head &&
      proof.snapshotSha === snapshot &&
      proof.scheduledAuthenticatedHttp === true &&
      proof.scheduledResponseCorrelated === true,
    "committed_actual_storage_evidence_required",
  );
  const b = proof.annotationBackups;
  requireCheck(
    b?.status === "passed" &&
      Number.isSafeInteger(b.assertions) &&
      b.assertions >= 20 &&
      Number.isSafeInteger(b.storageRaceIterations) &&
      b.storageRaceIterations >= 4 &&
      b.isolatedRestore === true &&
      b.lateUploadRejected === true &&
      [400, 404].includes(b.lateUploadHttpStatus),
    "actual_encrypted_restore_and_storage_fence_required",
  );
  return {
    actualEncryptedIsolatedRestore: true,
    storageRaceIterations: b.storageRaceIterations,
    assertions: b.assertions,
    lateUploadRejected: true,
    lateUploadHttpStatus: b.lateUploadHttpStatus,
  };
}
