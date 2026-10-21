import { artworkJobs } from "./artwork.ts";
import { artworkUrl, SpotifyClient, SpotifyError } from "./spotify.ts";
import { database, equal, rejects } from "./testing.ts";
const ID = "A".repeat(22);
const job = {
  id: "job",
  kind: "artwork",
  epoch: 1,
  leaseToken: "lease",
  attempts: 1,
  payload: {},
};

Deno.test("artwork adapter uses fixed read paths and normalizes safe direct image URLs", async () => {
  const paths: string[] = [];
  const client = new SpotifyClient({
    tokens: {
      getAccessToken: () => Promise.resolve("synthetic"),
      refreshAccessToken: () => Promise.resolve("synthetic"),
    },
    pacing: {
      acquire: () => Promise.resolve({ granted: true, retryAfterMs: 0 }),
      defer: () => Promise.resolve(),
    },
    isManagedPlaylist: () => Promise.resolve(false),
    fetch: ((url: string) => {
      paths.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(
          url.includes("/artists/")
            ? {
              images: [{ url: "http://unsafe.test/a" }, {
                url: "https://images.test/artist",
              }],
            }
            : [],
        )),
      );
    }) as typeof fetch,
  });
  equal(await client.getArtistArtwork(ID), {
    artworkUrl: "https://images.test/artist",
  });
  equal(await client.getPlaylistArtwork(ID), { artworkUrl: null });
  equal(paths, [
    `https://api.spotify.com/v1/artists/${ID}`,
    `https://api.spotify.com/v1/playlists/${ID}/images`,
  ]);
  await rejects(
    () => client.getArtistArtwork("../me"),
    (e) => e instanceof SpotifyError && e.kind === "guard",
  );
  await rejects(
    () =>
      client.request({
        method: "PUT",
        path: `/playlists/${ID}/images`,
        body: "bad",
      }),
    (e) => e instanceof SpotifyError && e.kind === "guard",
  );
  for (
    const value of [
      "javascript:alert(1)",
      "http://images.test/a",
      "https://user:pass@images.test/a",
      "https://images.test/a#fragment",
      "bad",
      null,
    ]
  ) equal(artworkUrl(value), null);
});
Deno.test("artwork worker fences every call, checkpoints null for unavailable art and stops after eight", async () => {
  const events: string[] = [];
  let commits = 0;
  const runner = artworkJobs({
    db: database((name, args) => {
      events.push(name);
      if (name === "app_artwork_work") return { kind: "artist", spotifyId: ID };
      if (name === "app_artwork_commit") {
        equal(args.p_url, null);
        commits++;
        return true;
      }
    }),
    spotify: () => ({
      getArtistArtwork: () => {
        events.push("remote");
        throw new SpotifyError("forbidden", 403);
      },
      getPlaylistArtwork: () => Promise.resolve({ artworkUrl: null }),
    }),
    now: () => 0,
    wait: () => Promise.resolve(),
  });
  equal(await runner(job, 80000), { done: false, retryMs: 1000 });
  equal(commits, 8);
  equal(events.slice(0, 3), [
    "app_artwork_work",
    "remote",
    "app_artwork_commit",
  ]);
});
Deno.test("artwork stale lease prevents remote reads; quota remains retryable without null checkpoint", async () => {
  let calls = 0;
  const spotify = () => ({
    getArtistArtwork: () => {
      calls++;
      throw new SpotifyError("quota", 429, 30000);
    },
    getPlaylistArtwork: () => Promise.resolve({ artworkUrl: null }),
  });
  equal(
    await artworkJobs({ db: database(() => null), spotify })(
      job,
      Date.now() + 80000,
    ),
    null,
  );
  equal(calls, 0);
  const runner = artworkJobs({
    db: database((name) => {
      equal(name, "app_artwork_work");
      return { kind: "artist", spotifyId: ID };
    }),
    spotify,
  });
  await rejects(
    () => runner(job, Date.now() + 80000),
    (e) => e instanceof SpotifyError && e.kind === "quota",
  );
  equal(calls, 1);
});
