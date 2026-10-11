import type { Database } from "./database.ts";
import type { SecretBox } from "./crypto.ts";
import type { Job } from "./jobs.ts";
import { databasePacing, OwnerTokens } from "./tokens.ts";
import { SpotifyClient, SpotifyError } from "./spotify.ts";
import { runPlaylistJob } from "./playlist-runner.ts";

export function playlistJobs(
  db: Database,
  box: SecretBox,
  clientId: string,
  request: typeof fetch = fetch,
) {
  return async (job: Job, deadline: number) => {
    if (job.kind !== "playlist") return null;
    if (job.epoch === null) throw new Error("invalid_job");
    const epoch = job.epoch;
    const pacing = databasePacing(db, epoch);
    async function active() {
      if (
        !await db.rpc<boolean>("app_playlist_fence", {
          p_job: job.id,
          p_lease: job.leaseToken,
        })
      ) {
        throw new SpotifyError("control_unavailable");
      }
    }
    const spotify = new SpotifyClient({
      tokens: new OwnerTokens(db, box, epoch, clientId, request),
      pacing: {
        acquire: async (interval) => {
          // This check occurs after token lookup/refresh, immediately before the
          // shared pacing gate and each provider request, including a GET retry.
          await active();
          return await pacing.acquire(interval);
        },
        defer: pacing.defer,
      },
      isManagedPlaylist: async (id) => {
        await active();
        return await db.rpc<boolean>("app_playlist_managed", {
          p_epoch: epoch,
          p_spotify_id: id,
        });
      },
      fetch: request,
    });
    return await runPlaylistJob(db, spotify, job, deadline);
  };
}
