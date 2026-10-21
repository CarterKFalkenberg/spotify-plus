import type { Database } from "./database.ts";
import type { FeatureJob } from "./library.ts";
import { type SpotifyClient, SpotifyError } from "./spotify.ts";

export function artworkJobs(input: {
  db: Database;
  spotify: (
    epoch: number,
  ) => Pick<SpotifyClient, "getArtistArtwork" | "getPlaylistArtwork">;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): FeatureJob {
  const now = input.now ?? Date.now;
  const wait = input.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (job, deadline) => {
    if (job.kind !== "artwork" || job.epoch === null) {
      throw new Error("invalid_artwork_job");
    }
    const client = input.spotify(job.epoch);
    for (let count = 0; count < 8 && now() < deadline - 20000; count++) {
      const target = await input.db.rpc<
        { kind: "artist" | "playlist"; spotifyId: string } | null
      >("app_artwork_work", {
        p_epoch: job.epoch,
        p_id: job.id,
        p_lease: job.leaseToken,
      });
      // SQL atomically finishes an empty queue, or rejects the stale lease.
      if (!target) return null;
      let url: string | null;
      try {
        const result = target.kind === "artist"
          ? await client.getArtistArtwork(target.spotifyId)
          : await client.getPlaylistArtwork(target.spotifyId);
        url = result.artworkUrl;
      } catch (error) {
        // Unavailable images remain honest placeholders. Quota, transport and
        // authentication failures keep the durable work for normal job recovery.
        if (
          !(error instanceof SpotifyError) ||
          !["forbidden", "not_found", "response"].includes(error.kind)
        ) throw error;
        url = null;
      }
      if (
        !await input.db.rpc<boolean>("app_artwork_commit", {
          p_epoch: job.epoch,
          p_id: job.id,
          p_lease: job.leaseToken,
          p_kind: target.kind,
          p_spotify_id: target.spotifyId,
          p_url: url,
        })
      ) return null;
      await wait(550);
    }
    return { done: false, retryMs: 1000 };
  };
}
