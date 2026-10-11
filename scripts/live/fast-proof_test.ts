import { newRegistry } from "./core-fixtures.ts";
import { fastProofSql } from "./fast-proof-sql.ts";
import { runFastProof } from "./fast-proof.ts";
Deno.test("fast transaction is rollback-only, rejects unvalidated identities and never invokes owner purge or Spotify work", () => {
  const r = newRegistry(1, "a".repeat(64)), sql = fastProofSql(r);
  if (
    !sql.includes("exception when sqlstate 'ZX001'") ||
    !sql.includes("fast_rollback_failed") ||
    /app_disconnect|app_connect|app_job_enqueue|playlist_operation\(/.test(sql)
  ) throw new Error("unsafe proof");
  for (
    const patch of [{ epoch: 0 }, { trackKeys: ["malformed"] }, {
      requestId: "'unsafe",
    }]
  ) {
    let failed = false;
    try {
      fastProofSql({ ...r, ...patch });
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("unvalidated SQL");
  }
  if (typeof runFastProof !== "function") throw new Error("proof unavailable");
});
