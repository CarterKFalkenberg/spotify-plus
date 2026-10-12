import type { Database } from "./database.ts";
import type { Job } from "./jobs.ts";
import type { Retention, StoredQuery } from "./contracts.ts";
import { SpotifyClient, SpotifyError } from "./spotify.ts";
import {
  creationMarker,
  expiryDate,
  playlistDescription,
  PlaylistError,
  renderQuery,
  verifiedPrefix,
} from "./playlist-domain.ts";

type Scan = {
  kind: "discover" | "membership" | "items";
  offset: number;
  total: number | null;
  found: string | null;
  snapshot: string | null;
  prefix: boolean;
};
export interface PlaylistWork {
  id: string;
  action:
    | "create"
    | "regenerate"
    | "extend"
    | "pin"
    | "unpin"
    | "delete"
    | "expire"
    | "reconcile";
  spotifyId: string | null;
  name: string;
  query: StoredQuery;
  labels: Record<string, string>;
  retention: Retention;
  target: string[];
  createAttempted: boolean;
  scan: Scan | null;
}
export type PlaylistSpotify = Pick<
  SpotifyClient,
  | "getCurrentUser"
  | "getCurrentUserPlaylistsPage"
  | "getPlaylist"
  | "getPlaylistItemsPage"
  | "createPrivatePlaylist"
  | "replacePlaylistItems"
  | "appendPlaylistItems"
  | "updatePlaylistDescription"
  | "containsPlaylists"
  | "removeManagedPlaylists"
>;
class YieldWork extends Error {}

/** Each call is bounded; durable scans permit large libraries to cross job leases.
 * A scan checkpoint is read evidence only. Every resumed write verifies remote
 * order and snapshot again; no stored append offset authorizes a POST replay. */
export async function runPlaylistJob(
  db: Database,
  spotify: PlaylistSpotify,
  job: Job,
  deadline: number,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<{ done: boolean; retryMs?: number } | null> {
  if (job.kind !== "playlist") return null;
  const args = { p_job: job.id, p_lease: job.leaseToken };
  const work = await db.rpc<PlaylistWork | null>("app_playlist_work", args);
  if (!work) return { done: true };
  let calls = 0;
  async function fence() {
    if (clock.now() > deadline - 50000 || calls >= 120) throw new YieldWork();
    if (!await db.rpc<boolean>("app_playlist_fence", args)) {
      throw new PlaylistError("lease_lost");
    }
  }
  async function remote<T>(action: () => Promise<T>): Promise<T> {
    for (;;) {
      await fence();
      calls++;
      try {
        return await action();
      } catch (error) {
        if (
          error instanceof SpotifyError && error.kind === "cooldown" &&
          error.retryAfterMs !== null && error.retryAfterMs <= 1000
        ) {
          await clock.sleep(error.retryAfterMs);
          continue;
        }
        throw error;
      }
    }
  }
  async function checkpoint(patch: Record<string, unknown>) {
    if (
      !await db.rpc<boolean>("app_playlist_checkpoint", {
        ...args,
        p_patch: patch,
      })
    ) {
      throw new PlaylistError("lease_lost");
    }
  }
  const scanStart = (
    kind: Scan["kind"],
    snapshot: string | null = null,
  ): Scan => ({
    kind,
    offset: 0,
    total: null,
    found: null,
    snapshot,
    prefix: true,
  });
  async function collection(
    kind: "discover" | "membership",
  ): Promise<string | null> {
    let scan = work!.scan?.kind === kind ? work!.scan : scanStart(kind);
    for (;;) {
      const page = await remote(() =>
        spotify.getCurrentUserPlaylistsPage({ offset: scan.offset, limit: 50 })
      );
      if (scan.total !== null && scan.total !== page.total) {
        await checkpoint({ scan: null });
        throw new PlaylistError("remote_changed");
      }
      for (const item of page.items) {
        const match = kind === "discover"
          ? item.description?.includes(creationMarker(work!.id))
          : item.id === work!.spotifyId;
        if (match) {
          if (scan.found !== null && scan.found !== item.id) {
            throw new PlaylistError("duplicate_marker");
          }
          scan.found = item.id;
        }
      }
      scan = {
        ...scan,
        total: page.total,
        offset: page.offset + page.items.length,
      };
      if (page.nextOffset === null) {
        if (scan.offset !== page.total) {
          throw new PlaylistError("remote_changed");
        }
        await checkpoint({ scan: null });
        work!.scan = null;
        return scan.found;
      }
      await checkpoint({ scan });
      work!.scan = scan;
    }
  }
  async function complete(
    expiresOn: string | null,
    name: string,
    removed = false,
  ) {
    if (
      !await db.rpc<boolean>("app_playlist_complete", {
        ...args,
        p_expires_on: expiresOn,
        p_name: name,
        p_removed: removed,
      })
    ) throw new PlaylistError("lease_lost");
  }

  try {
    if (!work.spotifyId) {
      if (work.action !== "create") throw new PlaylistError("invalid_work");
      if (!work.createAttempted) {
        try {
          const created = await remote(async () => {
            await checkpoint({ createAttempted: true });
            work.createAttempted = true;
            return await spotify.createPrivatePlaylist({
              name: work.name,
              description: playlistDescription(
                work.id,
                renderQuery(work.query, work.labels),
                expiryDate(clock.now(), work.retention),
                null,
              ),
            });
          });
          await checkpoint({ spotifyId: created.id, scan: null });
          work.spotifyId = created.id;
        } catch (error) {
          // A local quota/cooldown/guard failure or explicit HTTP rejection did
          // not create anything. Unknown successful/transport responses do.
          if (error instanceof SpotifyError && !error.ambiguous) {
            await checkpoint({ createAttempted: false });
          }
          throw error;
        }
      } else {
        const found = await collection("discover");
        if (!found) throw new PlaylistError("creation_unknown");
        const current = await remote(() => spotify.getCurrentUser());
        const candidate = await remote(() => spotify.getPlaylist(found));
        if (
          candidate.ownerId !== current.id || candidate.public !== false ||
          candidate.collaborative ||
          !candidate.description?.includes(creationMarker(work.id))
        ) throw new PlaylistError("creation_unknown");
        await checkpoint({ spotifyId: found, scan: null });
        work.spotifyId = found;
      }
    }
    const id = work.spotifyId;
    const deleting = work.action === "delete" || work.action === "expire";
    let contained = (await remote(() => spotify.containsPlaylists([id])))[0];
    if (deleting) {
      try {
        await remote(() => spotify.removeManagedPlaylists([id]));
      } catch (error) {
        // Already-absent DELETEs may report 404. It is only a cue to check both
        // saved-library routes; it is never itself proof of removal.
        if (!(error instanceof SpotifyError && error.kind === "not_found")) {
          throw error;
        }
      }
      contained = (await remote(() => spotify.containsPlaylists([id])))[0];
    }
    if (!contained || deleting) {
      const saved = await collection("membership");
      // Both routes must agree; an accessible object/404/403 is not saved-library evidence.
      if (!contained && !saved) {
        if (work.action === "create") {
          throw new PlaylistError("removal_unconfirmed");
        }
        if ((await remote(() => spotify.containsPlaylists([id])))[0]) {
          throw new PlaylistError("removal_unconfirmed");
        }
        await complete(null, work.name, true);
        return { done: true };
      }
      throw new PlaylistError("removal_unconfirmed");
    }
    let details = await remote(() => spotify.getPlaylist(id));
    if (work.action === "reconcile") {
      // Completed operations scrub query labels. Reconciliation must preserve
      // the current disclosure/outside notes rather than render from that state.
      if (details.public !== false || details.collaborative !== false) {
        const description = details.description;
        if (description === null) {
          throw new PlaylistError("remote_changed");
        }
        await remote(() => spotify.updatePlaylistDescription(id, description));
        const confirmed = await remote(() => spotify.getPlaylist(id));
        if (
          confirmed.public !== false || confirmed.collaborative !== false ||
          confirmed.description !== details.description ||
          confirmed.snapshotId !== details.snapshotId
        ) throw new PlaylistError("remote_changed");
        details = confirmed;
      }
      await complete(null, details.name);
      return { done: true };
    }
    const contents = work.action === "create" || work.action === "regenerate";
    if (contents) {
      if (
        !work.target.length ||
        work.target.some((uri) => !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri))
      ) {
        throw new PlaylistError("invalid_work");
      }
      for (;;) {
        let scan = work.scan?.kind === "items" &&
            work.scan.snapshot === details.snapshotId
          ? work.scan
          : scanStart("items", details.snapshotId);
        for (;;) {
          const page = await remote(() =>
            spotify.getPlaylistItemsPage(id, {
              offset: scan.offset,
              // Spotify item reads cap at 50; write chunks below permit 100.
              limit: 50,
            })
          );
          if (scan.total !== null && scan.total !== page.total) {
            await checkpoint({ scan: null });
            throw new PlaylistError("remote_changed");
          }
          scan.prefix &&= verifiedPrefix(
            work.target.slice(scan.offset),
            page.items.map((item) => item.uri),
          );
          scan = {
            ...scan,
            total: page.total,
            offset: page.offset + page.items.length,
          };
          if (page.nextOffset === null) break;
          await checkpoint({ scan });
          work.scan = scan;
        }
        details = await remote(() => spotify.getPlaylist(id));
        if (
          scan.snapshot !== details.snapshotId || scan.offset !== scan.total
        ) {
          await checkpoint({ scan: null });
          throw new PlaylistError("remote_changed");
        }
        await checkpoint({ scan: null });
        work.scan = null;
        if (scan.prefix && scan.offset === work.target.length) break;
        let position = scan.prefix ? scan.offset : 0;
        if (position === 0) {
          const result = await remote(() =>
            spotify.replacePlaylistItems(id, work.target.slice(0, 100))
          );
          details = { ...details, snapshotId: result.snapshotId };
          position = Math.min(100, work.target.length);
        }
        while (position < work.target.length) {
          const chunk = work.target.slice(position, position + 100);
          const result = await remote(() =>
            spotify.appendPlaylistItems(id, chunk)
          );
          details = { ...details, snapshotId: result.snapshotId };
          position += chunk.length;
        }
        // Read all items again, including null/local positions, before ready.
      }
    }
    // Re-read just before updating: never send a name and never reuse old user text.
    const current = await remote(() => spotify.getPlaylist(id));
    if (contents && current.snapshotId !== details.snapshotId) {
      throw new PlaylistError("remote_changed");
    }
    const expiresOn = expiryDate(clock.now(), work.retention);
    const description = playlistDescription(
      work.id,
      renderQuery(work.query, work.labels),
      expiresOn,
      current.description,
    );
    if (
      current.description !== description || current.public !== false ||
      current.collaborative !== false
    ) {
      await remote(() => spotify.updatePlaylistDescription(id, description));
    }
    const confirmed = await remote(() => spotify.getPlaylist(id));
    if (
      confirmed.description !== description ||
      confirmed.public !== false || confirmed.collaborative !== false ||
      (contents && confirmed.snapshotId !== current.snapshotId)
    ) {
      throw new PlaylistError("remote_changed");
    }
    await complete(expiresOn, confirmed.name);
    return { done: true };
  } catch (error) {
    if (error instanceof YieldWork) return { done: false, retryMs: 500 };
    if (error instanceof PlaylistError && error.kind === "lease_lost") {
      return { done: true };
    }
    const provider = error instanceof SpotifyError ? error : null;
    const kind = provider?.kind ??
      (error instanceof PlaylistError ? error.kind : "unavailable");
    const retryMs = Math.max(
      provider?.retryAfterMs ?? 0,
      Math.min(300000, 1000 * 2 ** Math.min(job.attempts, 8)),
    );
    await db.rpc("app_playlist_failed", {
      ...args,
      p_error: kind,
      p_retry_ms: retryMs,
    });
    return { done: false, retryMs };
  }
}
