import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
  SPOTIFY_SCOPES,
  SpotifyClient,
  type SpotifyDependencies,
  SpotifyError,
  type SpotifyErrorKind,
  type SpotifyRequest,
} from "./spotify.ts";

const PLAYLIST = "A".repeat(22);
const OTHER = "B".repeat(22);
const TRACK = "C".repeat(22);
const URI = `spotify:track:${TRACK}`;
const PLAYLIST_URI = `spotify:playlist:${PLAYLIST}`;
const DATE = "2026-10-11T10:00:00Z";

function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), { status, headers });
}
function playlist(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAYLIST,
    name: "Synthetic playlist",
    description: "Synthetic description",
    public: false,
    collaborative: false,
    owner: { id: "synthetic-owner" },
    snapshot_id: "synthetic-snapshot",
    items: { total: 0 },
    ...overrides,
  };
}
function track(overrides: Record<string, unknown> = {}) {
  return {
    id: TRACK,
    uri: URI,
    type: "track",
    name: "Synthetic track",
    artists: [{ id: OTHER, name: "Synthetic artist" }],
    album: {
      id: PLAYLIST,
      name: "Synthetic album",
      release_date: "2026-10",
      images: [{
        url: "https://example.test/synthetic.png",
        width: 300,
        height: 300,
      }],
    },
    duration_ms: 120_000,
    explicit: false,
    is_local: false,
    ...overrides,
  };
}
function page(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    items,
    total: items.length,
    offset: 0,
    limit: 50,
    next: null,
    ...overrides,
  };
}
type Reply = Response | (() => Response | Promise<Response>);
function harness(
  replies: Reply[] = [],
  overrides: Partial<SpotifyDependencies> = {},
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const events: string[] = [];
  const cooldowns: { retryAfterMs: number; kind: "rate_limit" | "quota" }[] =
    [];
  const deps: SpotifyDependencies = {
    tokens: {
      getAccessToken: () => {
        events.push("token");
        return Promise.resolve("synthetic-token");
      },
      refreshAccessToken: (token) => {
        strictEqual(token, "synthetic-token");
        events.push("refresh");
        return Promise.resolve("synthetic-refreshed-token");
      },
    },
    pacing: {
      acquire: (spacing) => {
        strictEqual(spacing, 500);
        events.push("permit");
        return Promise.resolve({ granted: true, retryAfterMs: 0 });
      },
      defer: (input) => {
        cooldowns.push(input);
        return Promise.resolve();
      },
    },
    isManagedPlaylist: (id) => Promise.resolve(id === PLAYLIST),
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      events.push("fetch");
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("Unexpected synthetic fetch");
      return Promise.resolve(typeof reply === "function" ? reply() : reply);
    }) as typeof fetch,
    now: () => Date.parse(DATE),
    ...overrides,
  };
  return { client: new SpotifyClient(deps), calls, events, cooldowns };
}
async function fails(
  action: () => unknown,
  kind: SpotifyErrorKind,
  ambiguous = false,
) {
  try {
    await action();
  } catch (error) {
    ok(error instanceof SpotifyError);
    strictEqual(error.kind, kind);
    strictEqual(error.ambiguous, ambiguous);
    return error;
  }
  throw new Error("Expected a guarded Spotify error");
}

Deno.test("initial scope set excludes profile, player and follow grants", () => {
  deepStrictEqual(SPOTIFY_SCOPES, [
    "user-library-read",
    "playlist-read-private",
    "playlist-modify-private",
    "playlist-modify-public",
    "user-library-modify",
  ]);
});

Deno.test("every unsupported saved-library write fails before token, pacing or fetch", async () => {
  const { client, events } = harness();
  const routes = [
    "/me/tracks",
    "/me/albums",
    "/me/episodes",
    "/me/shows",
    "/me/audiobooks",
    "/me/following",
    "/me/library",
    "/me/library/contains",
  ];
  for (const path of routes) {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "get"] as const) {
      // DELETE /me/library is allowed only with a valid managed-playlist query.
      await fails(
        () =>
          client.request(
            { method, path, body: { uris: [URI] } } as SpotifyRequest,
          ),
        "guard",
      );
    }
  }
  deepStrictEqual(events, []);
});

Deno.test("path, method, header and query tricks cannot widen the allowlist", async () => {
  const { client, events } = harness();
  const paths = [
    "https://api.spotify.com/v1/me/library",
    "//api.spotify.com/v1/me/library",
    "/v1/me/library",
    "/me/library/",
    "/me//library",
    "/me/%6cibrary",
    "/me/library%3Furis=anything",
    "/me/library?uris=anything",
    "/me/library#x",
    "/me/library/../tracks",
    "/me/library/%2e%2e/tracks",
    "/me\\library",
    "/ME/library",
    "/me/library\n",
    `/playlists/${PLAYLIST}/followers`,
    `/users/synthetic-owner/playlists`,
    `/playlists/${PLAYLIST}/tracks`,
  ];
  for (const path of paths) {
    await fails(
      () =>
        client.request({
          method: "DELETE",
          path,
          query: { uris: PLAYLIST_URI },
        }),
      "guard",
    );
  }
  await fails(
    () =>
      client.request(
        {
          method: "DELETE",
          path: "/me/library",
          query: { uris: PLAYLIST_URI },
          headers: { "X-HTTP-Method-Override": "PUT" },
        } as SpotifyRequest,
      ),
    "guard",
  );
  await fails(
    () =>
      client.request({
        method: "DELETE",
        path: "/me/library",
        query: { uris: PLAYLIST_URI, ids: TRACK },
      }),
    "guard",
  );
  await fails(
    () => client.request({ method: "GET", path: "/me/player" }),
    "guard",
  );
  await fails(
    () => client.request({ method: "GET", path: "/audio-features" }),
    "guard",
  );
  deepStrictEqual(events, []);
});

Deno.test("removal rejects mixed, malformed, encoded, empty and unmanaged playlist URIs", async () => {
  const { client, calls } = harness();
  const invalid = [
    "",
    URI,
    `${PLAYLIST_URI},${URI}`,
    `spotify:album:${PLAYLIST}`,
    `spotify:user:${PLAYLIST}`,
    `spotify:playlist:${OTHER}`,
    "spotify:playlist:short",
    `spotify:playlist:${PLAYLIST}x`,
    `spotify:playlist:${PLAYLIST}/`,
    `spotify:playlist:${PLAYLIST}\n`,
    ` ${PLAYLIST_URI}`,
    `${PLAYLIST_URI},`,
    `SPOTIFY:playlist:${PLAYLIST}`,
    encodeURIComponent(PLAYLIST_URI),
    Array(41).fill(PLAYLIST_URI).join(","),
  ];
  for (const uris of invalid) {
    await fails(() =>
      client.request({
        method: "DELETE",
        path: "/me/library",
        query: { uris },
      }), "guard");
  }
  await fails(
    () => client.removeManagedPlaylists([`${PLAYLIST},${URI}`]),
    "guard",
  );
  await fails(() => client.removeManagedPlaylists([]), "guard");
  strictEqual(calls.length, 0);
});

Deno.test("managed removal has exact query-only semantics and does not follow redirects", async () => {
  const { client, calls } = harness([new Response(null, { status: 200 })]);
  await client.removeManagedPlaylists(Array(40).fill(PLAYLIST));
  strictEqual(calls.length, 1);
  strictEqual(calls[0].url.origin, "https://api.spotify.com");
  strictEqual(calls[0].url.pathname, "/v1/me/library");
  strictEqual(
    calls[0].url.searchParams.get("uris"),
    Array(40).fill(PLAYLIST_URI).join(","),
  );
  strictEqual(calls[0].init.method, "DELETE");
  strictEqual(calls[0].init.body, undefined);
  strictEqual(calls[0].init.redirect, "manual");
});

Deno.test("mutable request data cannot change after ownership validation starts", async () => {
  let release!: (value: boolean) => void;
  const { client, calls } = harness([
    json({ snapshot_id: "synthetic-snapshot" }, 201),
  ], {
    isManagedPlaylist: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const input: SpotifyRequest = {
    method: "POST",
    path: `/playlists/${PLAYLIST}/items`,
    body: { uris: [URI] },
  };
  const pending = client.request(input);
  input.path = "/me/tracks";
  (input.body as { uris: string[] }).uris.push(`spotify:episode:${OTHER}`);
  release(true);
  await pending;
  strictEqual(calls[0].url.pathname, `/v1/playlists/${PLAYLIST}/items`);
  deepStrictEqual(JSON.parse(String(calls[0].init.body)), { uris: [URI] });
});

Deno.test("serialized body tricks and sparse URI arrays fail closed", async () => {
  const { client, calls } = harness();
  const bodies = [
    { uris: [URI], toJSON: () => ({ uris: [`spotify:episode:${OTHER}`] }) },
    { uris: new Array(1) },
    { uris: [null] },
    { uris: [URI], position: 0 },
  ];
  for (const body of bodies) {
    await fails(() =>
      client.request({
        method: "POST",
        path: `/playlists/${PLAYLIST}/items`,
        body,
      }), "guard");
  }
  strictEqual(calls.length, 0);
});

Deno.test("create is explicitly private and existing names cannot be rewritten", async () => {
  const { client, calls } = harness([
    json(playlist(), 201),
    new Response(null, { status: 200 }),
  ]);
  await client.createPrivatePlaylist({
    name: "Synthetic playlist",
    description: "Synthetic description",
  });
  await client.updatePlaylistDescription(PLAYLIST, "Synthetic new description");
  deepStrictEqual(JSON.parse(String(calls[0].init.body)), {
    name: "Synthetic playlist",
    description: "Synthetic description",
    public: false,
    collaborative: false,
  });
  deepStrictEqual(JSON.parse(String(calls[1].init.body)), {
    description: "Synthetic new description",
  });
  strictEqual(calls[0].url.pathname, "/v1/me/playlists");
  for (
    const body of [
      { name: "Synthetic", description: "Synthetic" },
      {
        name: "Synthetic",
        description: "Synthetic",
        public: true,
        collaborative: false,
      },
      {
        name: "Synthetic",
        description: "Synthetic",
        public: false,
        collaborative: true,
      },
    ]
  ) {
    await fails(
      () => client.request({ method: "POST", path: "/me/playlists", body }),
      "guard",
    );
  }
  await fails(
    () =>
      client.request({
        method: "PUT",
        path: `/playlists/${PLAYLIST}`,
        body: { name: "Overwritten" },
      }),
    "guard",
  );
  strictEqual(calls.length, 2);
});

Deno.test("all existing-playlist writes require managed ownership; dependency failure fails closed", async () => {
  const { client, calls } = harness();
  await fails(() => client.replacePlaylistItems(OTHER, [URI]), "guard");
  await fails(() => client.appendPlaylistItems(OTHER, [URI]), "guard");
  await fails(
    () => client.updatePlaylistDescription(OTHER, "Synthetic"),
    "guard",
  );
  strictEqual(calls.length, 0);
  const broken = harness([], {
    isManagedPlaylist: () => {
      throw new Error("sensitive database data");
    },
  });
  await fails(
    () => broken.client.removeManagedPlaylists([PLAYLIST]),
    "control_unavailable",
  );
  deepStrictEqual(broken.events, []);
});

Deno.test("playlist writes preserve ordered chunks and enforce track-only 100-item limit", async () => {
  const { client, calls } = harness([
    json({ snapshot_id: "one" }),
    json({ snapshot_id: "two" }, 201),
    json({ snapshot_id: "three" }),
  ]);
  const uris = Array.from(
    { length: 100 },
    (_, index) => `spotify:track:${String(index).padStart(22, "0")}`,
  );
  await client.replacePlaylistItems(PLAYLIST, uris);
  await client.appendPlaylistItems(PLAYLIST, [URI]);
  await client.replacePlaylistItems(PLAYLIST, []);
  deepStrictEqual(JSON.parse(String(calls[0].init.body)), { uris });
  deepStrictEqual(calls.map((call) => call.init.method), [
    "PUT",
    "POST",
    "PUT",
  ]);
  for (
    const invalid of [
      [...uris, URI],
      [`spotify:episode:${TRACK}`],
      [PLAYLIST_URI],
      ["spotify:local:synthetic"],
      [`${URI},${URI}`],
    ]
  ) {
    await fails(() => client.replacePlaylistItems(PLAYLIST, invalid), "guard");
  }
  await fails(() => client.appendPlaylistItems(PLAYLIST, []), "guard");
  strictEqual(calls.length, 3);
});

Deno.test("owner binding requires immutable account_id and strips other profile fields", async () => {
  const { client } = harness([
    json({
      account_id: "synthetic-account",
      id: "synthetic-owner",
      email: "synthetic@example.test",
      display_name: "Synthetic",
    }),
  ]);
  deepStrictEqual(await client.getCurrentUser(), {
    accountId: "synthetic-account",
    id: "synthetic-owner",
  });
  await fails(
    () => harness([json({ id: "synthetic-owner" })]).client.getCurrentUser(),
    "response",
  );
});

Deno.test("saved-track metadata is minimal, null entries retained, unusable URI excluded", async () => {
  const { client } = harness([json(page([
    {
      added_at: DATE,
      track: track({
        popularity: 99,
        external_ids: { isrc: "synthetic" },
        preview_url: "https://example.test/audio",
      }),
    },
    { added_at: DATE, track: null },
    {
      added_at: DATE,
      track: track({
        id: null,
        uri: "spotify:local:synthetic",
        is_local: true,
      }),
    },
    { added_at: DATE, track: track({ is_playable: false }) },
  ]))]);
  const result = await client.getSavedTracksPage();
  strictEqual(result.total, 4);
  strictEqual(result.items.length, 4);
  strictEqual(result.items[0].track?.uri, URI);
  strictEqual(result.items[0].track?.album.releaseDate, "2026-10");
  ok(!("popularity" in result.items[0].track!));
  ok(!("external_ids" in result.items[0].track!));
  ok(!("preview_url" in result.items[0].track!));
  strictEqual(result.items[1].track, null);
  strictEqual(result.items[2].track?.uri, null);
  strictEqual(result.items[2].track?.isPlayable, false);
  strictEqual(result.items[3].track?.isPlayable, false);
});

Deno.test("playlist current and legacy item wrappers normalize without dropping unavailable positions", async () => {
  const { client } = harness([json(page([
    { added_at: DATE, is_local: false, item: track() },
    { added_at: null, is_local: false, track: track() },
    { added_at: null, is_local: false, item: null, track: track() },
    {
      added_at: DATE,
      is_local: true,
      item: track({ uri: "spotify:local:synthetic" }),
    },
    {
      added_at: DATE,
      is_local: false,
      item: { type: "episode", uri: `spotify:episode:${TRACK}` },
    },
  ]))]);
  const result = await client.getPlaylistItemsPage(PLAYLIST);
  deepStrictEqual(result.items.map((item) => item.uri), [
    URI,
    URI,
    null,
    null,
    `spotify:episode:${TRACK}`,
  ]);
  deepStrictEqual(result.items.map((item) => item.type), [
    "track",
    "track",
    "unavailable",
    "track",
    "episode",
  ]);
  await fails(
    () =>
      harness([json(page([{ added_at: DATE, is_local: false }]))]).client
        .getPlaylistItemsPage(PLAYLIST),
    "response",
  );
});

Deno.test("current-user playlist collection and metadata normalize current items with legacy fallback", async () => {
  const legacy: Record<string, unknown> = playlist();
  delete legacy.items;
  const { client, calls } = harness([
    json(page([playlist()])),
    json({ ...legacy, tracks: { total: 3 } }),
  ]);
  strictEqual((await client.getCurrentUserPlaylistsPage()).items[0].total, 0);
  strictEqual((await client.getPlaylist(PLAYLIST)).total, 3);
  strictEqual(calls[0].url.pathname, "/v1/me/playlists");
  await fails(
    () =>
      harness([json(playlist({ items: null, tracks: { total: 3 } }))]).client
        .getPlaylist(PLAYLIST),
    "response",
  );
});

Deno.test("paging validates bounds, echoed offsets, and next links without following them", async () => {
  const next = "https://api.spotify.com/v1/me/tracks?offset=1&limit=1";
  const { client, calls } = harness([
    json(
      page([{ added_at: DATE, track: track() }], { total: 2, limit: 1, next }),
    ),
  ]);
  strictEqual((await client.getSavedTracksPage({ limit: 1 })).nextOffset, 1);
  strictEqual(calls.length, 1);
  for (
    const query of [{ limit: 51 }, { limit: 0 }, { offset: -1 }, {
      offset: 1.5,
    }, { limit: "50" }] as Record<string, string | number>[]
  ) {
    await fails(
      () => client.request({ method: "GET", path: "/me/tracks", query }),
      "guard",
    );
  }
  for (
    const badNext of [
      "https://example.test/?offset=1",
      "https://api.spotify.com/v1/me/tracks?offset=0",
      "https://api.spotify.com/v1/me/tracks?offset=3",
      "https://api.spotify.com/v1/me/playlists?offset=1",
    ]
  ) {
    await fails(
      () =>
        harness([
          json(
            page([{ added_at: DATE, track: track() }], {
              total: 2,
              next: badNext,
            }),
          ),
        ]).client.getSavedTracksPage(),
      "response",
    );
  }
  await fails(
    () => harness([json(page([], { offset: 1 }))]).client.getSavedTracksPage(),
    "response",
  );
});

Deno.test("empty first playlist-items page accepts the observed terminal zero limit", async () => {
  for (const limit of [1, 50]) {
    const { client, calls } = harness([json(page([], { limit: 0 }))]);
    deepStrictEqual(await client.getPlaylistItemsPage(PLAYLIST, { limit }), {
      items: [],
      total: 0,
      offset: 0,
      limit: 0,
      nextOffset: null,
    });
    strictEqual(calls[0].url.searchParams.get("limit"), String(limit));
  }
});

Deno.test("zero playlist-items limit rejects inconsistent and malformed pages", async () => {
  for (
    const overrides of [
      { total: 1 },
      { offset: 1 },
      { items: [{ added_at: DATE, item: track(), is_local: false }] },
      {
        next: `https://api.spotify.com/v1/playlists/${PLAYLIST}/items?offset=1`,
      },
      { next: "https://example.test/?offset=1" },
      { next: "invalid-url" },
      { next: undefined },
      { next: 0 },
      { limit: 1 },
      { limit: -1 },
      { limit: "0" },
      { total: "0" },
      { items: null },
    ]
  ) {
    await fails(() =>
      harness([json(page([], { limit: 0, ...overrides }))])
        .client.getPlaylistItemsPage(PLAYLIST), "response");
  }
  // Even an echoed nonzero offset cannot widen the observed first-page case.
  await fails(() =>
    harness([json(page([], { limit: 0, offset: 1 }))])
      .client.getPlaylistItemsPage(PLAYLIST, { offset: 1 }), "response");
  await fails(() =>
    harness([json(page([], { limit: 0 }))])
      .client.getPlaylistItemsPage(PLAYLIST, { offset: 1 }), "response");
});

Deno.test("empty saved-track and playlist-collection pages still require echoed limits", async () => {
  await fails(() =>
    harness([json(page([], { limit: 0 }))]).client
      .getSavedTracksPage(), "response");
  await fails(() =>
    harness([json(page([], { limit: 0 }))]).client
      .getCurrentUserPlaylistsPage(), "response");
});

Deno.test("nonempty playlist-items pages retain limit, offset, item-bound and next-URL checks", async () => {
  const item = { added_at: DATE, item: track(), is_local: false };
  for (
    const overrides of [
      { limit: 0 },
      { limit: 1 },
      { offset: 1 },
      { next: "https://example.test/?offset=1" },
      { next: "https://api.spotify.com/v1/me/tracks?offset=1" },
      {
        next: `https://api.spotify.com/v1/playlists/${PLAYLIST}/items?offset=0`,
      },
      {
        next: `https://api.spotify.com/v1/playlists/${PLAYLIST}/items?offset=2`,
      },
    ]
  ) {
    await fails(() =>
      harness([json(page([item], overrides))]).client
        .getPlaylistItemsPage(PLAYLIST), "response");
  }
  await fails(() =>
    harness([json(page([item, item], { limit: 1 }))]).client
      .getPlaylistItemsPage(PLAYLIST, { limit: 1 }), "response");
});

Deno.test("containment validates exact positional booleans and never treats GET playlist as deletion proof", async () => {
  const { client, calls } = harness([json([false, true])]);
  deepStrictEqual(await client.containsPlaylists([PLAYLIST, OTHER]), [
    false,
    true,
  ]);
  strictEqual(calls[0].url.pathname, "/v1/me/library/contains");
  await fails(
    () => harness([json([false])]).client.containsPlaylists([PLAYLIST, OTHER]),
    "response",
  );
  await fails(
    () => harness([json(["false"])]).client.containsPlaylists([PLAYLIST]),
    "response",
  );
});

Deno.test("shared pacing prevents concurrent clients from dispatching inside a granted interval", async () => {
  let now = 0;
  let nextAt = 0;
  const pacing: SpotifyDependencies["pacing"] = {
    acquire: (spacing) => {
      const retryAfterMs = Math.max(0, nextAt - now);
      if (retryAfterMs) {
        return Promise.resolve({ granted: false, retryAfterMs });
      }
      nextAt = now + spacing;
      return Promise.resolve({ granted: true, retryAfterMs: 0 });
    },
    defer: ({ retryAfterMs }) => {
      nextAt = Math.max(nextAt, now + retryAfterMs);
      return Promise.resolve();
    },
  };
  const one = harness([json({ account_id: "synthetic", id: "synthetic" })], {
    pacing,
  });
  const two = harness([json({ account_id: "synthetic", id: "synthetic" })], {
    pacing,
  });
  await Promise.all([
    one.client.getCurrentUser(),
    fails(() => two.client.getCurrentUser(), "cooldown"),
  ]);
  strictEqual(one.calls.length + two.calls.length, 1);
  now = 500;
  await two.client.getCurrentUser();
  strictEqual(two.calls.length, 1);
});

Deno.test("pacing failure or invalid permits never falls back to an unpaced request", async () => {
  for (
    const acquire of [
      () => {
        throw new Error("sensitive control error");
      },
      () => Promise.resolve({ granted: true, retryAfterMs: 10 }),
      () => Promise.resolve({ granted: false, retryAfterMs: NaN }),
    ]
  ) {
    const { client, calls } = harness([], {
      pacing: { acquire, defer: () => Promise.resolve() },
    });
    await fails(() => client.getCurrentUser(), "control_unavailable");
    strictEqual(calls.length, 0);
  }
});

Deno.test("read 401 refreshes once through the serialized provider with a fresh permit", async () => {
  const { client, calls, events } = harness([
    new Response(null, { status: 401 }),
    json({ account_id: "synthetic", id: "synthetic" }),
  ]);
  await client.getCurrentUser();
  deepStrictEqual(events, [
    "token",
    "permit",
    "fetch",
    "refresh",
    "permit",
    "fetch",
  ]);
  strictEqual(
    new Headers(calls[1].init.headers).get("Authorization"),
    "Bearer synthetic-refreshed-token",
  );
  const twice = harness([
    new Response(null, { status: 401 }),
    new Response(null, { status: 401 }),
  ]);
  await fails(() => twice.client.getCurrentUser(), "authentication");
  strictEqual(twice.calls.length, 2);
  strictEqual(twice.events.filter((event) => event === "refresh").length, 1);
});

Deno.test("writes do not refresh/replay a 401; 403 remains a generic forbidden status", async () => {
  const one = harness([json({ error: { message: "sensitive" } }, 401)]);
  await fails(
    () => one.client.appendPlaylistItems(PLAYLIST, [URI]),
    "authentication",
  );
  strictEqual(one.calls.length, 1);
  ok(!one.events.includes("refresh"));
  const two = harness([
    json({ error: { message: "Not allowlisted or something else" } }, 403),
  ]);
  const error = await fails(() => two.client.getCurrentUser(), "forbidden");
  strictEqual(error.status, 403);
  ok(!error.message.includes("allowlisted"));
});

Deno.test("429 honors Retry-After and persists shared cooldown without replay", async () => {
  for (const header of ["120", "Sun, 11 Oct 2026 10:02:00 GMT"]) {
    const { client, calls, cooldowns } = harness([
      json({ error: { reason: "RATE_LIMITED" } }, 429, {
        "Retry-After": header,
      }),
    ]);
    const error = await fails(() => client.getCurrentUser(), "rate_limit");
    strictEqual(error.retryAfterMs, 120_000);
    deepStrictEqual(cooldowns, [{ kind: "rate_limit", retryAfterMs: 120_000 }]);
    strictEqual(calls.length, 1);
  }
  const malformed = harness([
    new Response("not-json", {
      status: 429,
      headers: { "Retry-After": "nonsense" },
    }),
  ]);
  strictEqual(
    (await fails(() => malformed.client.getCurrentUser(), "rate_limit"))
      .retryAfterMs,
    30_000,
  );
});

Deno.test("quota exhaustion parks for hours while honoring a longer provider delay", async () => {
  for (
    const [header, expected] of [["5", 21_600_000], [
      "86400",
      86_400_000,
    ]] as const
  ) {
    const { client, cooldowns, calls } = harness([
      json(
        { error: { reason: "QUOTA_EXCEEDED", message: "sensitive upstream" } },
        429,
        { "Retry-After": header },
      ),
    ]);
    strictEqual(
      (await fails(() => client.getCurrentUser(), "quota")).retryAfterMs,
      expected,
    );
    deepStrictEqual(cooldowns, [{ kind: "quota", retryAfterMs: expected }]);
    strictEqual(calls.length, 1);
  }
});

Deno.test("failed cooldown persistence is redacted and still exposes the required retry delay", async () => {
  const { client } = harness([
    json({ error: {} }, 429, { "Retry-After": "90" }),
  ], {
    pacing: {
      acquire: () => Promise.resolve({ granted: true, retryAfterMs: 0 }),
      defer: () => {
        throw new Error("secret database details");
      },
    },
  });
  const error = await fails(
    () => client.getCurrentUser(),
    "control_unavailable",
  );
  strictEqual(error.retryAfterMs, 90_000);
  strictEqual(error.status, 429);
});

Deno.test("lost create/append responses remain ambiguous and are never retried", async () => {
  for (const operation of ["create", "append"] as const) {
    for (
      const reply of [
        () => {
          throw new Error("secret token or metadata in network error");
        },
        () => json({ error: { message: "sensitive" } }, 503),
        () => new Response("{truncated", { status: 201 }),
        () => json({}, 201),
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://example.test/steal" },
          }),
      ]
    ) {
      const { client, calls, events } = harness([reply]);
      let caught: unknown;
      try {
        if (operation === "create") {
          await client.createPrivatePlaylist({
            name: "Synthetic",
            description: "Synthetic",
          });
        } else await client.appendPlaylistItems(PLAYLIST, [URI]);
      } catch (error) {
        caught = error;
      }
      ok(caught instanceof SpotifyError);
      strictEqual(caught.ambiguous, true);
      strictEqual(calls.length, 1);
      ok(!events.includes("refresh"));
      ok(!JSON.stringify(caught).includes("secret"));
      ok(!String(caught).includes("sensitive"));
      ok(!("cause" in caught));
    }
  }
});

Deno.test("write timeout aborts the fetch and remains ambiguous; reads are safe to reschedule", async () => {
  for (const write of [false, true]) {
    let calls = 0;
    const { client } = harness([], {
      timeoutMs: 5,
      fetch: ((_input: unknown, init?: RequestInit) => {
        calls++;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("sensitive abort")),
            { once: true },
          );
        });
      }) as typeof fetch,
    });
    await fails(
      () =>
        write
          ? client.appendPlaylistItems(PLAYLIST, [URI])
          : client.getCurrentUser(),
      "network",
      write,
    );
    strictEqual(calls, 1);
  }
});

Deno.test("unconfirmed private creation and malformed successful writes are ambiguous", async () => {
  await fails(
    () =>
      harness([json(playlist({ public: true }), 201)]).client
        .createPrivatePlaylist({ name: "Synthetic", description: "Synthetic" }),
    "response",
    true,
  );
  await fails(
    () => harness([json({})]).client.replacePlaylistItems(PLAYLIST, [URI]),
    "response",
    true,
  );
  await fails(
    () =>
      harness([new Response(null, { status: 408 })]).client
        .removeManagedPlaylists([PLAYLIST]),
    "http",
    true,
  );
});

Deno.test("token-provider errors never leak tokens or upstream causes", async () => {
  const { client, calls } = harness([], {
    tokens: {
      getAccessToken: () => {
        throw new Error("sensitive synthetic-token");
      },
      refreshAccessToken: () => {
        throw new Error("sensitive refresh-token");
      },
    },
  });
  const error = await fails(
    () => client.getCurrentUser(),
    "control_unavailable",
  );
  strictEqual(calls.length, 0);
  ok(!JSON.stringify(error).includes("sensitive"));
  ok(!("cause" in error));
});

Deno.test("classified token failures preserve reconnect and retry semantics without leaking causes", async () => {
  for (const kind of ["authentication", "cooldown", "network"] as const) {
    const { client, calls } = harness([], {
      tokens: {
        getAccessToken: () => {
          const error = new SpotifyError(
            kind,
            null,
            kind === "cooldown" ? 60_000 : null,
          );
          error.message = "sensitive upstream";
          throw error;
        },
        refreshAccessToken: () => Promise.resolve("synthetic-token"),
      },
    });
    const error = await fails(() => client.getCurrentUser(), kind);
    strictEqual(error.retryAfterMs, kind === "cooldown" ? 60_000 : null);
    ok(!String(error).includes("sensitive"));
    strictEqual(calls.length, 0);
  }
});

Deno.test("malformed Retry-After values use a conservative fallback", async () => {
  for (const header of ["-1", "NaN", "Infinity", "1e9", ""]) {
    const { client } = harness([
      json({ error: {} }, 429, { "Retry-After": header }),
    ]);
    strictEqual(
      (await fails(() => client.getCurrentUser(), "rate_limit")).retryAfterMs,
      30_000,
    );
  }
});

Deno.test("playlist description response normalization is shared, single-pass and outbound text stays plain", async () => {
  const raw =
    "&#91;Tagger:x&#93; &amp; &lt; &gt; &quot; &apos; &#39; &#x2F; &#47; &#x1F60D; &amp;amp; &amp;#47; &unknown; &#0; &#xD800; &#1114112;";
  const canonical =
    "[Tagger:x] & < > \" ' ' / / 😍 &amp; &#47; &unknown; &#0; &#xD800; &#1114112;";
  const h = harness([
    json(playlist({ description: raw }), 201),
    json(playlist({ description: raw })),
    json(page([playlist({ description: raw })])),
    new Response(null, { status: 200 }),
    json(playlist({ description: null })),
  ]);
  strictEqual(
    (await h.client.createPrivatePlaylist({
      name: "Synthetic",
      description: canonical,
    })).description,
    canonical,
  );
  strictEqual((await h.client.getPlaylist(PLAYLIST)).description, canonical);
  strictEqual(
    (await h.client.getCurrentUserPlaylistsPage({ offset: 0, limit: 50 }))
      .items[0].description,
    canonical,
  );
  await h.client.updatePlaylistDescription(PLAYLIST, canonical);
  strictEqual(JSON.parse(String(h.calls[0].init.body)).description, canonical);
  strictEqual(JSON.parse(String(h.calls[3].init.body)).description, canonical);
  strictEqual((await h.client.getPlaylist(PLAYLIST)).description, null);
});
