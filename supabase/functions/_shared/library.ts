import { SecretBox } from "./crypto.ts";
import type { Database } from "./database.ts";
import type { Job } from "./jobs.ts";
import {
  SpotifyClient,
  type SpotifyPage,
  type SpotifySavedTrack,
} from "./spotify.ts";
import { databasePacing, OwnerTokens } from "./tokens.ts";

export interface LibraryPageRow {
  trackKey: string;
  spotifyId: string;
  title: string;
  artists: { id: string | null; name: string }[];
  album: string;
  releaseDate: string | null;
  durationMs: number;
  explicit: boolean;
  artworkUrl: string | null;
  spotifyUrl: string;
  playableUri: string | null;
  likedAt: string;
}
interface LibraryCheckpoint {
  encryptedKey: string;
  offset: number;
  pass: number;
  runId: string | null;
  completed?: boolean;
}
export interface JobStep {
  done: boolean;
  retryMs?: number;
}
export type FeatureJob = (
  job: Job,
  deadline: number,
) => Promise<JobStep | null>;

// The wrapping key is deployment configuration. Only this random epoch-specific
// key derives track identities; its ciphertext disappears on disconnect.
export function newAnnotationKey(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
}
export async function annotationKey(key: string, id: string): Promise<string> {
  if (!/^[A-Za-z0-9]{22}$/.test(id)) throw new Error("invalid_track_identity");
  const bytes = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("invalid_annotation_key");
  const signingKey = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    new TextEncoder().encode(`spotify-plus:track:v1:${id}`),
  );
  return Array.from(
    new Uint8Array(signature),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function libraryPage(
  page: SpotifyPage<SpotifySavedTrack>,
  key: string,
) {
  let unresolved = 0;
  let skipped = 0;
  const rows: LibraryPageRow[] = [];
  for (const item of page.items) {
    const track = item.track;
    if (track?.isLocal) {
      skipped++;
      continue;
    }
    if (!track?.id) {
      // Without a stable identity, equal page counts cannot prove equal sets.
      unresolved++;
      continue;
    }
    rows.push({
      trackKey: await annotationKey(key, track.id),
      spotifyId: track.id,
      title: track.name,
      artists: track.artists.map(({ id, name }) => ({ id, name })),
      album: track.album.name,
      releaseDate: track.album.releaseDate || null,
      durationMs: track.durationMs,
      explicit: track.explicit,
      artworkUrl: track.album.images[0]?.url ?? null,
      spotifyUrl: `https://open.spotify.com/track/${track.id}`,
      playableUri: track.isPlayable && !track.isLocal ? track.uri : null,
      likedAt: new Date(item.addedAt).toISOString(),
    });
  }
  // Order is included only in the cheap head hint; full walks compare sets in SQL.
  const head = {
    total: page.total,
    members: rows.map(({ trackKey, likedAt }) => [trackKey, likedAt]),
    unresolved,
    skipped,
  };
  return { rows, unresolved, skipped, head };
}
export function createLibraryRunner(input: {
  db: Database;
  annotationBox: SecretBox;
  spotify: (epoch: number) => Pick<SpotifyClient, "getSavedTracksPage">;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): FeatureJob {
  const { db, annotationBox, spotify } = input;
  const now = input.now ?? Date.now;
  const wait = input.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (job, deadline) => {
    if (
      job.epoch === null ||
      !["library_sync", "library_probe"].includes(job.kind)
    ) throw new Error("invalid_library_job");
    const epoch = job.epoch;
    const encrypted = await annotationBox.encrypt(
      newAnnotationKey(),
      `annotation-key:${epoch}`,
    );
    // Checkpoint lookup fences the lease before reading credentials or Spotify.
    let checkpoint = await db.rpc<LibraryCheckpoint | null>(
      "app_library_job_state",
      {
        p_epoch: epoch,
        p_id: job.id,
        p_lease: job.leaseToken,
        p_encrypted_key: encrypted,
      },
    );
    if (!checkpoint) return null;
    if (checkpoint.completed) return { done: true };
    const key = await annotationBox.decrypt<string>(
      checkpoint.encryptedKey,
      `annotation-key:${epoch}`,
    );
    const client = spotify(epoch);
    for (let pages = 0; pages < 10 && now() < deadline - 20000; pages++) {
      if (
        !await db.rpc<boolean>("app_job_renew", {
          p_id: job.id,
          p_lease: job.leaseToken,
        })
      ) return null;
      const page = await client.getSavedTracksPage({
        offset: checkpoint.offset,
        limit: 50,
      });
      const projected = await libraryPage(page, key);
      if (job.kind === "library_probe") {
        const accepted = await db.rpc<boolean>("app_library_probe_commit", {
          p_epoch: epoch,
          p_id: job.id,
          p_lease: job.leaseToken,
          p_head: projected.head,
          p_complete: projected.unresolved === 0,
        });
        return accepted ? { done: true } : null;
      }
      const result = await db.rpc<JobStep | null>("app_library_page_commit", {
        p_epoch: epoch,
        p_id: job.id,
        p_lease: job.leaseToken,
        p_pass: checkpoint.pass,
        p_offset: checkpoint.offset,
        p_total: page.total,
        p_received: page.items.length,
        p_next_offset: page.nextOffset,
        p_rows: projected.rows,
        p_unresolved: projected.unresolved,
        p_head: projected.head,
      });
      if (!result || result.done || result.retryMs) return result;
      // Do not infer a new checkpoint locally: page commits may begin verification.
      checkpoint = await db.rpc<LibraryCheckpoint | null>(
        "app_library_job_state",
        {
          p_epoch: epoch,
          p_id: job.id,
          p_lease: job.leaseToken,
          p_encrypted_key: encrypted,
        },
      );
      if (!checkpoint) return null;
      if (checkpoint.completed) return { done: true };
      await wait(550);
    }
    return { done: false, retryMs: 1000 };
  };
}
export function librarySpotify(input: {
  db: Database;
  tokenBox: SecretBox;
  clientId: string;
  fetch?: typeof fetch;
}): (epoch: number) => SpotifyClient {
  return (epoch) =>
    new SpotifyClient({
      tokens: new OwnerTokens(
        input.db,
        input.tokenBox,
        epoch,
        input.clientId,
        input.fetch,
      ),
      pacing: databasePacing(input.db, epoch),
      isManagedPlaylist: () => Promise.resolve(false),
      fetch: input.fetch,
    });
}
