import type { FeatureJob } from "./library.ts";
import type { Database } from "./database.ts";
import type { BackupStorage } from "./backups.ts";
import { SpotifyError } from "./spotify.ts";
export interface Job {
  id: string;
  kind: string;
  epoch: number | null;
  payload: Record<string, unknown>;
  attempts: number;
  leaseToken: string;
}
export interface JobContext {
  db: Database;
  backups: BackupStorage;
  sha: string;
  now?: () => number;
  library?: FeatureJob;
  playlist?: FeatureJob;
}
export async function drainJobs(
  context: JobContext,
  budgetMs = 80000,
): Promise<{ completed: number; retried: number }> {
  const { db, backups, sha } = context;
  const now = context.now ?? Date.now;
  const deadline = now() + Math.min(budgetMs, 80000);
  let completed = 0;
  let retried = 0;
  await db.rpc("app_jobs_started", { p_sha: sha });
  for (let count = 0; count < 20 && now() < deadline - 50000; count++) {
    const job = await db.rpc<Job | null>("app_job_claim", {
      p_lease_seconds: 100,
    });
    if (!job) break;
    try {
      if (job.kind === "scheduler_ping") {
        if (
          !await db.rpc<boolean>("app_maintenance", {
            p_id: job.id,
            p_lease: job.leaseToken,
            p_sha: sha,
          })
        ) continue;
      } else if (job.kind === "purge_backups") {
        if (typeof job.payload.epoch !== "number") {
          throw new Error("invalid_job");
        }
        const status = await db.rpc<{ epoch: number; state: string }>(
          "app_account_status",
        );
        if (
          status.epoch !== job.payload.epoch || status.state !== "disconnecting"
        ) {
          // A committed purge may outlive its worker's acknowledgement. Never purge a new connection.
          await db.rpc("app_job_finish", {
            p_id: job.id,
            p_lease: job.leaseToken,
            p_outcome: "done",
          });
          continue;
        }
        if (!await backups.purge()) throw new Error("backup_purge_pending");
        if (
          !await db.rpc<boolean>("app_job_renew", {
            p_id: job.id,
            p_lease: job.leaseToken,
          })
        ) {
          continue;
        }
        if (
          !await db.rpc<boolean>("app_disconnect_finish", {
            p_epoch: job.payload.epoch,
          })
        ) {
          continue;
        }
      } else if (
        (job.kind === "library_sync" || job.kind === "library_probe") &&
        context.library
      ) {
        const result = await context.library(job, deadline);
        if (!result) continue;
        if (!result.done) {
          await db.rpc("app_job_finish", {
            p_id: job.id,
            p_lease: job.leaseToken,
            p_outcome: "queued",
            p_retry_ms: result.retryMs ?? 1000,
            p_error: (result.retryMs ?? 0) >= 60000 ? "library_unstable" : null,
          });
          continue;
        }
      } else if (job.kind === "playlist" && context.playlist) {
        const result = await context.playlist(job, deadline);
        if (!result) continue;
        if (!result.done) {
          await db.rpc("app_job_finish", {
            p_id: job.id,
            p_lease: job.leaseToken,
            p_outcome: "queued",
            p_retry_ms: result.retryMs ?? 1000,
          });
          continue;
        }
      } else {
        // Feature handlers are added with their domain transactions. Unknown work is visible, not discarded.
        await db.rpc("app_job_finish", {
          p_id: job.id,
          p_lease: job.leaseToken,
          p_outcome: "parked",
          p_error: "unsupported_job",
        });
        continue;
      }
      if (
        await db.rpc<boolean>("app_job_finish", {
          p_id: job.id,
          p_lease: job.leaseToken,
          p_outcome: "done",
        })
      ) completed++;
    } catch (error) {
      const classified = error instanceof SpotifyError ? error : null;
      const reconnect = classified?.kind === "authentication";
      const delay = Math.max(
        classified?.retryAfterMs ?? 0,
        Math.min(300000, 1000 * 2 ** Math.min(job.attempts, 8)),
      );
      await db.rpc("app_job_finish", {
        p_id: job.id,
        p_lease: job.leaseToken,
        p_outcome: reconnect ? "parked" : "queued",
        p_retry_ms: delay,
        p_error: reconnect
          ? "reconnect"
          : classified?.kind ?? "worker_unavailable",
      });
      retried++;
    }
  }
  return { completed, retried };
}
