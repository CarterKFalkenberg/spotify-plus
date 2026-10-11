import { pacedRequests } from "./paced-request.ts";
import {
  SpotifyClient,
  SpotifyError,
} from "../../supabase/functions/_shared/spotify.ts";
import {
  equal,
  mockResponse,
  rejects,
} from "../../supabase/functions/_shared/testing.ts";

function fixture(
  options: { status?: number; deny?: boolean; refreshBusy?: boolean } = {},
) {
  let now = 0, next = 0, dispatched = 0, waits = 0;
  const client = new SpotifyClient({
    tokens: {
      getAccessToken: () => Promise.resolve("synthetic-token"),
      refreshAccessToken: () =>
        Promise.reject(new SpotifyError("cooldown", null, 500)),
    },
    pacing: {
      acquire: (spacing) => {
        if (options.deny || now < next) {
          return Promise.resolve({
            granted: false,
            retryAfterMs: Math.max(500, next - now),
          });
        }
        next = now + spacing;
        return Promise.resolve({ granted: true, retryAfterMs: 0 });
      },
      defer: () => Promise.resolve(),
    },
    isManagedPlaylist: () => Promise.resolve(true),
    fetch: (url) => {
      dispatched++;
      if (options.refreshBusy) return mockResponse(null, { status: 401 });
      if (String(url).includes("/contains")) return mockResponse("[false]");
      return mockResponse(null, { status: options.status ?? 204 });
    },
  });
  return {
    request: pacedRequests(client, () => dispatched, (delay) => {
      waits++;
      now += delay;
      return Promise.resolve();
    }),
    stats: () => ({ dispatched, waits }),
  };
}
const remove = {
  method: "DELETE",
  path: "/me/library",
  query: { uris: "spotify:playlist:AAAAAAAAAAAAAAAAAAAAAA" },
} as const;
Deno.test("live pacing schedules containment after removal without replaying the mutation", async () => {
  const test = fixture();
  await test.request(remove);
  equal(
    await test.request({
      method: "GET",
      path: "/me/library/contains",
      query: remove.query,
    }),
    [false],
  );
  equal(test.stats(), { dispatched: 2, waits: 1 });
});
Deno.test("live pacing bounds permanently denied slots without any Spotify dispatch", async () => {
  const test = fixture({ deny: true });
  await rejects(
    () => test.request(remove),
    (e) => e instanceof SpotifyError && e.kind === "cooldown",
  );
  equal(test.stats(), { dispatched: 0, waits: 10 });
});
for (const status of [429, 503]) {
  Deno.test(`live pacing never replays a dispatched ${status} mutation`, async () => {
    const test = fixture({ status });
    await rejects(
      () => test.request(remove),
      (e) =>
        e instanceof SpotifyError &&
        (status === 429 ? e.kind === "rate_limit" : e.ambiguous),
    );
    equal(test.stats(), { dispatched: 1, waits: 0 });
  });
}
Deno.test("live pacing does not reschedule cooldown after an already dispatched authentication refusal", async () => {
  const test = fixture({ refreshBusy: true });
  await rejects(
    () =>
      test.request({
        method: "GET",
        path: "/me/library/contains",
        query: remove.query,
      }),
    (e) => e instanceof SpotifyError && e.kind === "cooldown",
  );
  equal(test.stats(), { dispatched: 1, waits: 0 });
});
