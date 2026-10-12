import { playlistJobs } from "./playlist-runtime.ts";
import { SecretBox } from "./crypto.ts";
import { playlistDescription } from "./playlist-domain.ts";
import { assert, database, equal, TEST_KEY } from "./testing.ts";
import type { Job } from "./jobs.ts";
import type { PlaylistWork } from "./playlist-runner.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const spotifyId = "p".repeat(22);
const job: Job = {
  id,
  kind: "playlist",
  epoch: 1,
  payload: {},
  attempts: 1,
  leaseToken: id,
};
async function fixture() {
  const box = new SecretBox(TEST_KEY);
  const encrypted = await box.encrypt({
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
  }, "tokens:1");
  const state = {
    active: true,
    complete: false,
    completion: null as Record<string, unknown> | null,
    stored: [] as unknown[],
    failTokenFence: false,
    deferred: 0,
  };
  const work: PlaylistWork = {
    id,
    action: "expire",
    spotifyId,
    name: "Synthetic",
    query: { version: 1, root: { op: "tag", tagId: id } },
    labels: {},
    retention: "month",
    target: [],
    createAttempted: false,
    scan: null,
  };
  const db = database((name, args) => {
    if (name === "app_playlist_work") return work;
    if (name === "app_playlist_fence") return state.active;
    if (name === "app_token_claim") {
      if (state.failTokenFence) state.active = false;
      return { action: "cached", encryptedTokens: encrypted, version: 1 };
    }
    if (name === "app_pacing_acquire") {
      assert(state.active);
      return { granted: true, retryAfterMs: 0 };
    }
    if (name === "app_pacing_defer") {
      state.deferred = args.p_retry_ms as number;
      return undefined;
    }
    if (name === "app_playlist_managed") {
      return args.p_epoch === 1 && args.p_spotify_id === spotifyId;
    }
    if (name === "app_playlist_checkpoint") {
      state.stored.push(args.p_patch);
      return state.active;
    }
    if (name === "app_playlist_failed") {
      state.stored.push(args.p_error);
      return state.active;
    }
    if (name === "app_playlist_complete") {
      state.complete = true;
      state.completion = args;
      return state.active;
    }
    throw new Error("Unexpected synthetic RPC");
  });
  return { box, state, work, db };
}
Deno.test("runtime uses shared guarded adapter for playlist-only removal and both absence routes", async () => {
  const f = await fixture();
  let contained = true;
  const calls: string[] = [];
  const request: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    if (init?.method === "DELETE") {
      equal(url.pathname, "/v1/me/library");
      equal(url.searchParams.get("uris"), `spotify:playlist:${spotifyId}`);
      contained = false;
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (url.pathname.endsWith("/contains")) {
      return Promise.resolve(Response.json([contained]));
    }
    if (url.pathname === "/v1/me/playlists") {
      return Promise.resolve(
        Response.json({
          items: [],
          offset: 0,
          limit: 50,
          total: 0,
          next: null,
        }),
      );
    }
    throw new Error("Unexpected synthetic endpoint");
  };
  equal(
    await playlistJobs(f.db, f.box, "synthetic-client", request)(
      job,
      Date.now() + 80000,
    ),
    { done: true },
  );
  assert(f.state.complete);
  equal(calls, [
    "GET /v1/me/library/contains",
    "DELETE /v1/me/library",
    "GET /v1/me/library/contains",
    "GET /v1/me/playlists",
    "GET /v1/me/library/contains",
  ]);
});
Deno.test("runtime fences disconnect after token lookup and before fetch", async () => {
  const f = await fixture();
  f.state.failTokenFence = true;
  let calls = 0;
  const request: typeof fetch = () => {
    calls++;
    throw new Error("Unexpected fetch");
  };
  await playlistJobs(f.db, f.box, "synthetic-client", request)(
    job,
    Date.now() + 80000,
  );
  equal(calls, 0);
  assert(!f.state.complete);
});
Deno.test("runtime sends explicit private creation and preserves an ambiguous create marker", async () => {
  const f = await fixture();
  f.work.action = "create";
  f.work.spotifyId = null;
  f.work.target = [`spotify:track:${"t".repeat(22)}`];
  let calls = 0;
  const request: typeof fetch = (input, init) => {
    calls++;
    equal(new URL(String(input)).pathname, "/v1/me/playlists");
    equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    equal(body.public, false);
    equal(body.collaborative, false);
    assert(body.description.includes(`[Tagger:${id}]`));
    return Promise.reject(new Error("Synthetic lost response"));
  };
  equal(
    (await playlistJobs(f.db, f.box, "synthetic-client", request)(
      job,
      Date.now() + 80000,
    ))?.done,
    false,
  );
  equal(calls, 1);
  equal(f.state.stored, [{ createAttempted: true }, "network"]);
  assert(!f.state.complete);
});
Deno.test("runtime quota response extends shared cooldown and keeps operation incomplete", async () => {
  const f = await fixture();
  let calls = 0;
  const request: typeof fetch = () => {
    calls++;
    return Promise.resolve(
      Response.json({ error: { reason: "QUOTA_EXCEEDED" } }, {
        status: 429,
        headers: { "retry-after": "1" },
      }),
    );
  };
  const result = await playlistJobs(f.db, f.box, "synthetic-client", request)(
    job,
    Date.now() + 80000,
  );
  assert(result && !result.done && result.retryMs! >= 21600000);
  equal(calls, 1);
  equal(f.state.deferred, 21600000);
  equal(f.state.stored, ["quota"]);
  assert(!f.state.complete);
});

for (const action of ["create", "regenerate"] as const) {
  Deno.test(`runtime ${action} completes through the real adapter with 50-item reads and 100-item writes`, async () => {
    const f = await fixture();
    const target = Array.from(
      { length: 125 },
      (_, index) => `spotify:track:${String(index + 1).padStart(22, "0")}`,
    );
    f.work.action = action;
    f.work.spotifyId = action === "create" ? null : spotifyId;
    f.work.target = target;
    f.work.labels = { [id]: "Synthetic tag" };
    const name = action === "create" ? f.work.name : "Synthetic owner rename";
    const outside = action === "create" ? "" : "Preserve owner text.\n";
    let description = outside +
      playlistDescription(id, "Old query", "2026-01-01", null);
    // Regeneration must read beyond the first page to find this unavailable
    // position and replace the existing sequence rather than trust its prefix.
    let items: (string | null)[] = action === "create" ? [] : [...target];
    if (action === "regenerate") items[55] = null;
    let snapshot = 0, creates = 0;
    const reads: { offset: number; total: number }[] = [];
    const writes: { method: string; count: number }[] = [];
    const details = () => ({
      id: spotifyId,
      name,
      description,
      public: false,
      collaborative: false,
      owner: { id: "synthetic-owner" },
      snapshot_id: String(snapshot),
      items: { total: items.length },
    });
    const request: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      equal(url.origin, "https://api.spotify.com");
      equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer synthetic-access",
      );
      const method = init?.method;
      if (url.pathname === "/v1/me/playlists" && method === "POST") {
        equal(action, "create");
        const body = JSON.parse(String(init?.body));
        equal(body, {
          name,
          description: body.description,
          public: false,
          collaborative: false,
        });
        assert(body.description.includes(`[Tagger:${id}]`));
        description = body.description;
        creates++;
        return Promise.resolve(Response.json(details(), { status: 201 }));
      }
      if (url.pathname === "/v1/me/library/contains" && method === "GET") {
        equal(url.searchParams.get("uris"), `spotify:playlist:${spotifyId}`);
        return Promise.resolve(Response.json([true]));
      }
      if (url.pathname === `/v1/playlists/${spotifyId}`) {
        if (method === "GET") return Promise.resolve(Response.json(details()));
        equal(method, "PUT");
        const body = JSON.parse(String(init?.body));
        equal(Object.keys(body), ["description", "public", "collaborative"]);
        equal(body.public, false);
        equal(body.collaborative, false);
        description = body.description;
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      equal(url.pathname, `/v1/playlists/${spotifyId}/items`);
      if (method === "GET") {
        const limit = Number(url.searchParams.get("limit"));
        equal(limit, 50);
        const offset = Number(url.searchParams.get("offset"));
        reads.push({ offset, total: items.length });
        const page = items.slice(offset, offset + limit);
        const next = offset + page.length < items.length
          ? `${url.origin}${url.pathname}?offset=${
            offset + page.length
          }&limit=${limit}`
          : null;
        return Promise.resolve(Response.json({
          items: page.map((uri) => ({
            added_at: null,
            is_local: false,
            item: uri === null ? null : { type: "track", uri },
          })),
          offset,
          limit,
          total: items.length,
          next,
        }));
      }
      assert(method === "PUT" || method === "POST");
      const body = JSON.parse(String(init?.body));
      equal(Object.keys(body), ["uris"]);
      writes.push({ method, count: body.uris.length });
      items = method === "PUT" ? [...body.uris] : [...items, ...body.uris];
      return Promise.resolve(
        Response.json({ snapshot_id: String(++snapshot) }, {
          status: method === "POST" ? 201 : 200,
        }),
      );
    };
    equal(
      await playlistJobs(f.db, f.box, "synthetic-client", request)(
        job,
        Date.now() + 80000,
      ),
      { done: true },
    );
    assert(f.state.complete);
    equal(f.state.stored.filter((value) => typeof value === "string"), []);
    equal(items, target);
    equal(creates, action === "create" ? 1 : 0);
    equal(writes, [{ method: "PUT", count: 100 }, {
      method: "POST",
      count: 25,
    }]);
    const fullScan = [0, 50, 100].map((offset) => ({ offset, total: 125 }));
    equal(
      reads,
      action === "create"
        ? [{ offset: 0, total: 0 }, ...fullScan]
        : [...fullScan, ...fullScan],
    );
    equal(f.state.completion?.p_name, name);
    assert(description.startsWith(outside));
    assert(description.includes("Regenerate overwrites manual edits"));
    assert(typeof f.state.completion?.p_expires_on === "string");
  });
}
