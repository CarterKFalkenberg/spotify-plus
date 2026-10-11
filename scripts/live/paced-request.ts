import {
  SpotifyClient,
  SpotifyError,
} from "../../supabase/functions/_shared/spotify.ts";

// The adapter rejects a denied pacing slot before dispatch. Only that case may be
// scheduled again; a sent request, 429/quota, or ambiguous write always escapes.
export function pacedRequests(
  client: SpotifyClient,
  dispatchCount: () => number,
  wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
) {
  return async (input: Parameters<SpotifyClient["request"]>[0]) => {
    let waited = 0;
    for (let attempt = 0;; attempt++) {
      const before = dispatchCount();
      try {
        return await client.request(input);
      } catch (error) {
        if (
          !(error instanceof SpotifyError) || error.kind !== "cooldown" ||
          error.ambiguous || error.status !== null ||
          dispatchCount() !== before || attempt >= 10 ||
          error.retryAfterMs === null || !Number.isFinite(error.retryAfterMs) ||
          error.retryAfterMs < 0 || error.retryAfterMs > 2000
        ) throw error;
        const delay = Math.max(500, error.retryAfterMs);
        if (waited + delay > 10_000) throw error;
        waited += delay;
        await wait(delay);
      }
    }
  };
}
