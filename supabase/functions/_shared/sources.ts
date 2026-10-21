import type { Database } from "./database.ts";
import { SecretBox } from "./crypto.ts";
import type { Job } from "./jobs.ts";
import {
  type FeatureJob,
  type JobStep,
  libraryPage,
  newAnnotationKey,
} from "./library.ts";
import {
  SpotifyClient,
  SpotifyError,
  type SpotifyPage,
  type SpotifyPlaylistItem,
} from "./spotify.ts";
interface Checkpoint {
  offset: number;
  snapshotId: string | null;
  sourceId: string | null;
  previousSnapshotId: string | null;
  lastSyncedAt: string | null;
  encryptedKey: string;
  accountId: string;
  enabled: boolean;
  terminal: boolean;
}
export async function sourcePage(
  page: SpotifyPage<SpotifyPlaylistItem>,
  key: string,
) {
  let skipped = 0;
  let unresolved = 0;
  const items = [];
  for (const item of page.items) {
    if (item.isLocal || item.type === "episode") {
      skipped++;
      continue;
    }
    if (!item.track?.id || item.type !== "track") {
      unresolved++;
      continue;
    }
    items.push({
      track: item.track,
      addedAt: item.addedAt ?? "1970-01-01T00:00:00Z",
    });
  }
  const result = await libraryPage({ ...page, items }, key);
  return {
    rows: result.rows,
    skipped,
    unresolved: unresolved + result.unresolved,
  };
}
export function createSourcesRunner(input: {
  db: Database;
  annotationBox: SecretBox;
  spotify: (
    epoch: number,
  ) => Pick<
    SpotifyClient,
    "getCurrentUserPlaylistsPage" | "getPlaylist" | "getPlaylistItemsPage"
  >;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): FeatureJob {
  const now = input.now ?? Date.now;
  const wait = input.wait ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (job: Job, deadline: number) => {
    if (
      job.epoch === null ||
      !["source_discovery", "source_sync"].includes(job.kind)
    ) throw new Error("invalid_source_job");
    const epoch = job.epoch;
    const encrypted = await input.annotationBox.encrypt(
      newAnnotationKey(),
      `annotation-key:${epoch}`,
    );
    const state = () =>
      input.db.rpc<Checkpoint | null>("app_source_job_state", {
        p_epoch: epoch,
        p_id: job.id,
        p_lease: job.leaseToken,
        p_encrypted_key: encrypted,
      });
    const finish = (snapshot: string | null, error: string | null = null) =>
      input.db.rpc<JobStep | null>("app_source_finish", {
        p_epoch: epoch,
        p_id: job.id,
        p_lease: job.leaseToken,
        p_snapshot: snapshot,
        p_error: error,
      });
    let checkpoint = await state();
    if (!checkpoint) return null;
    if (!checkpoint.enabled) return { done: true };
    const client = input.spotify(epoch);
    const key = await input.annotationBox.decrypt<string>(
      checkpoint.encryptedKey,
      `annotation-key:${epoch}`,
    );
    try {
      let snapshot: string | null = null;
      if (checkpoint.sourceId) {
        const before = await client.getPlaylist(checkpoint.sourceId);
        snapshot = before.snapshotId;
        if (checkpoint.snapshotId && checkpoint.snapshotId !== snapshot) {
          return await finish(snapshot);
        }
        if (
          checkpoint.terminal ||
          (!checkpoint.snapshotId && checkpoint.lastSyncedAt &&
            checkpoint.previousSnapshotId === snapshot)
        ) return await finish(snapshot);
        await wait(550);
      }
      for (let count = 0; count < 5 && now() < deadline - 20000; count++) {
        // Re-check selection and lease immediately before every content request.
        checkpoint = await state();
        if (!checkpoint) return null;
        if (!checkpoint.enabled) return { done: true };
        if (
          !await input.db.rpc<boolean>("app_job_renew", {
            p_id: job.id,
            p_lease: job.leaseToken,
          })
        ) return null;
        if (!checkpoint.sourceId) {
          const page = await client.getCurrentUserPlaylistsPage({
            offset: checkpoint.offset,
            limit: 50,
          });
          const result = await input.db.rpc<JobStep | null>(
            "app_source_discovery_commit",
            {
              p_epoch: epoch,
              p_id: job.id,
              p_lease: job.leaseToken,
              p_offset: checkpoint.offset,
              p_total: page.total,
              p_received: page.items.length,
              p_next_offset: page.nextOffset,
              p_sources: page.items.map((p) => ({
                id: p.id,
                name: p.name,
                artworkUrl: p.artworkUrl ?? null,
                total: p.total,
                eligible: p.ownerId === checkpoint!.accountId ||
                  p.collaborative,
              })),
            },
          );
          if (!result || result.done || result.retryMs) return result;
        } else {
          const page = await client.getPlaylistItemsPage(checkpoint.sourceId, {
            offset: checkpoint.offset,
            limit: 50,
          });
          const projected = await sourcePage(page, key);
          const result = await input.db.rpc<
            JobStep & { terminal?: boolean } | null
          >("app_source_page_commit", {
            p_epoch: epoch,
            p_id: job.id,
            p_lease: job.leaseToken,
            p_offset: checkpoint.offset,
            p_total: page.total,
            p_received: page.items.length,
            p_next_offset: page.nextOffset,
            p_snapshot: snapshot,
            p_rows: projected.rows,
            p_skipped: projected.skipped,
            p_unresolved: projected.unresolved,
          });
          if (!result || result.done || result.retryMs) return result;
          if (result.terminal) {
            await wait(550);
            const after = await client.getPlaylist(checkpoint.sourceId);
            return await finish(after.snapshotId);
          }
        }
        await wait(550);
      }
      return { done: false, retryMs: 1000 };
    } catch (error) {
      if (
        checkpoint?.sourceId && error instanceof SpotifyError &&
        ["forbidden", "not_found", "response"].includes(error.kind)
      ) return await finish(null, error.kind);
      throw error;
    }
  };
}
