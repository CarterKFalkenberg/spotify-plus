import { assert, database, equal } from "./testing.ts";
import {
  type PlaylistSpotify,
  type PlaylistWork,
  runPlaylistJob,
} from "./playlist-runner.ts";
import {
  SpotifyClient,
  SpotifyError,
  type SpotifyPlaylist,
} from "./spotify.ts";
import type { Job } from "./jobs.ts";
import { creationMarker, playlistDescription } from "./playlist-domain.ts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const spotifyId = "p".repeat(22);
const uri = (i: number) => `spotify:track:${String(i).padStart(22, "0")}`;
const job: Job = {
  id,
  kind: "playlist",
  epoch: 1,
  payload: {},
  attempts: 1,
  leaseToken: id,
};
function harness(count = 250) {
  const work: PlaylistWork = {
    id,
    action: "create",
    spotifyId: null,
    name: "Synthetic snapshot",
    query: { version: 1, root: { op: "tag", tagId: id } },
    labels: { [id]: "Synthetic" },
    retention: "month",
    target: Array.from({ length: count }, (_, i) => uri(i)),
    createAttempted: false,
    scan: null,
  };
  let time = Date.parse("2026-01-31T17:00:00Z");
  const state = {
    work,
    active: true,
    items: [] as (string | null)[],
    listed: true,
    contained: true,
    exists: false,
    creates: 0,
    removes: 0,
    replacements: 0,
    appends: [] as number[],
    errors: [] as string[],
    complete: false,
    removed: false,
    expiresOn: null as string | null,
    fault: "",
    failNextLease: false,
    snapshot: 1,
    description: "",
    name: "Synthetic snapshot",
    public: false as boolean | null,
    collaborative: false,
    onCall: (_name: string) => {},
  };
  const metadata = (): SpotifyPlaylist => ({
    id: spotifyId,
    name: state.name,
    description: state.description,
    public: state.public,
    collaborative: state.collaborative,
    ownerId: "synthetic-owner",
    total: state.items.length,
    snapshotId: String(state.snapshot),
  });
  const call = (name: string) => {
    state.onCall(name);
    time += 50;
  };
  const spotify: PlaylistSpotify = {
    getCurrentUser: () => {
      call("identity");
      return Promise.resolve({
        accountId: "synthetic-account",
        id: "synthetic-owner",
      });
    },
    getCurrentUserPlaylistsPage: ({ offset = 0, limit = 50 } = {}) => {
      call("playlists");
      const items = state.exists && state.listed ? [metadata()] : [];
      return Promise.resolve({
        items: items.slice(offset, offset + limit),
        total: items.length,
        offset,
        limit,
        nextOffset: null,
      });
    },
    getPlaylist: () => {
      call("details");
      return Promise.resolve(metadata());
    },
    getPlaylistItemsPage: (_id, { offset = 0, limit = 50 } = {}) => {
      assert(limit >= 1 && limit <= 50);
      call("items");
      return Promise.resolve({
        items: state.items.slice(offset, offset + limit).map((uri) => ({
          addedAt: null,
          uri,
          isLocal: false,
          type: "track" as const,
        })),
        offset,
        limit,
        total: state.items.length,
        nextOffset: offset + limit < state.items.length ? offset + limit : null,
      });
    },
    createPrivatePlaylist: (input) => {
      call("create");
      state.creates++;
      state.exists = true;
      state.description = input.description;
      if (state.fault === "create") {
        state.fault = "";
        return Promise.reject(new SpotifyError("network", null, null, true));
      }
      return Promise.resolve(metadata());
    },
    replacePlaylistItems: (_id, uris) => {
      call("replace");
      state.replacements++;
      state.items = [...uris];
      state.snapshot++;
      return Promise.resolve({ snapshotId: String(state.snapshot) });
    },
    appendPlaylistItems: (_id, uris) => {
      call("append");
      state.appends.push(uris.length);
      state.items.push(...uris);
      state.snapshot++;
      if (state.fault === "append") {
        state.fault = "";
        return Promise.reject(new SpotifyError("response", 201, null, true));
      }
      return Promise.resolve({ snapshotId: String(state.snapshot) });
    },
    updatePlaylistDescription: (_id, value) => {
      call("description");
      state.description = value;
      state.public = false;
      state.collaborative = false;
      return Promise.resolve();
    },
    containsPlaylists: () => {
      call("contains");
      return Promise.resolve([state.contained]);
    },
    removeManagedPlaylists: () => {
      call("remove");
      state.removes++;
      if (state.fault === "remove404") {
        return Promise.reject(new SpotifyError("not_found", 404));
      }
      if (state.fault === "remove403") {
        return Promise.reject(new SpotifyError("forbidden", 403));
      }
      state.contained = false;
      state.listed = false;
      return Promise.resolve();
    },
  };
  const db = database((name, args) => {
    if (name === "app_playlist_work") {
      return state.active ? structuredClone(work) : null;
    }
    if (name === "app_playlist_fence") {
      if (state.failNextLease) state.active = false;
      return state.active;
    }
    if (name === "app_playlist_checkpoint") {
      if (!state.active) return false;
      Object.assign(work, args.p_patch);
      return true;
    }
    if (name === "app_playlist_failed") {
      state.errors.push(String(args.p_error));
      return true;
    }
    if (name === "app_playlist_complete") {
      if (!state.active) return false;
      state.complete = true;
      state.removed = args.p_removed === true;
      state.expiresOn = args.p_expires_on as string | null;
      return true;
    }
    throw Error("Unexpected synthetic RPC");
  });
  return {
    state,
    run: (budget = 80000, transport: PlaylistSpotify = spotify) =>
      runPlaylistJob(db, transport, job, time + budget, {
        now: () => time,
        sleep: (ms) => {
          time += ms;
          return Promise.resolve();
        },
      }),
  };
}
Deno.test("create writes 100-item chunks and verifies actual ordered contents before ready", async () => {
  const h = harness();
  equal(await h.run(), { done: true });
  equal(h.state.items, h.state.work.target);
  equal(h.state.appends, [100, 50]);
  equal(h.state.creates, 1);
  equal(h.state.replacements, 1);
  assert(h.state.complete);
  equal(h.state.expiresOn, "2026-02-28");
});
async function realAdapterRoundTrip(
  escaped = false,
  corruption: "description" | "snapshot" | null = null,
) {
  const h = harness(125);
  if (escaped) {
    h.state.work.labels[id] = 'A & B / "quoted" <tag> &amp; [/Tagger]';
  }
  const encode = (value: string) =>
    value.replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;")
      .replaceAll("/", "&#x2F;");
  let corrupt = false;
  let responseCount = 0;
  const calls: string[] = [];
  const pages: { offset: number; count: number; limit: number }[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status });
  const metadata = () => ({
    id: spotifyId,
    name: h.state.name,
    description: escaped ? encode(h.state.description) : h.state.description,
    public: h.state.public,
    collaborative: h.state.collaborative,
    owner: { id: "synthetic-owner" },
    snapshot_id: String(
      h.state.snapshot + (corrupt && corruption === "snapshot" ? 1 : 0),
    ),
    items: { total: h.state.items.length },
  });
  const client = new SpotifyClient({
    tokens: {
      getAccessToken: () => Promise.resolve("synthetic-token"),
      refreshAccessToken: () => {
        throw Error("Unexpected synthetic refresh");
      },
    },
    pacing: {
      acquire: () => Promise.resolve({ granted: true, retryAfterMs: 0 }),
      defer: () => Promise.resolve(),
    },
    isManagedPlaylist: (remoteId) =>
      Promise.resolve(h.state.work.spotifyId === remoteId),
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (method === "POST" && url.pathname === "/v1/me/playlists") {
        const body = JSON.parse(String(init?.body));
        equal(body.public, false);
        equal(body.collaborative, false);
        h.state.creates++;
        h.state.exists = true;
        h.state.description = body.description;
        return Promise.resolve(json(metadata(), 201));
      }
      assert(h.state.exists);
      if (method === "GET" && url.pathname === "/v1/me/library/contains") {
        return Promise.resolve(json([true]));
      }
      if (method === "GET" && url.pathname === `/v1/playlists/${spotifyId}`) {
        responseCount++;
        const value = metadata();
        if (corrupt && corruption === "description") {
          value.description += " changed";
        }
        return Promise.resolve(json(value));
      }
      if (method === "PUT" && url.pathname === `/v1/playlists/${spotifyId}`) {
        const body = JSON.parse(String(init?.body));
        equal(Object.keys(body), ["description", "public", "collaborative"]);
        // Model a provider that resets omitted metadata visibility. The adapter
        // must send fixed values, not rely on omission preserving state.
        h.state.public = body.public ?? true;
        h.state.collaborative = body.collaborative ?? true;
        h.state.description = body.description;
        corrupt = corruption !== null;
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (
        method === "GET" && url.pathname === `/v1/playlists/${spotifyId}/items`
      ) {
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        equal(limit, 50);
        const items = h.state.items.slice(offset, offset + limit).map((
          uri,
        ) => ({
          added_at: null,
          is_local: false,
          item: { type: "track", uri },
        }));
        const nextOffset = offset + items.length;
        const responseLimit = h.state.items.length === 0 ? 0 : limit;
        pages.push({ offset, count: items.length, limit: responseLimit });
        return Promise.resolve(json({
          items,
          offset,
          total: h.state.items.length,
          limit: responseLimit,
          next: nextOffset < h.state.items.length
            ? `https://api.spotify.com/v1/playlists/${spotifyId}/items?offset=${nextOffset}&limit=${limit}`
            : null,
        }));
      }
      if (
        (method === "PUT" || method === "POST") &&
        url.pathname === `/v1/playlists/${spotifyId}/items`
      ) {
        const body = JSON.parse(String(init?.body));
        if (method === "PUT") {
          h.state.replacements++;
          h.state.items = body.uris;
        } else {
          h.state.appends.push(body.uris.length);
          h.state.items.push(...body.uris);
        }
        h.state.snapshot++;
        return Promise.resolve(
          json(
            { snapshot_id: String(h.state.snapshot) },
            method === "POST" ? 201 : 200,
          ),
        );
      }
      throw Error("Unexpected synthetic transport request");
    }) as typeof fetch,
  });
  equal(await h.run(80000, client), { done: true });
  equal(h.state.errors, []);
  assert(h.state.complete);
  equal(h.state.creates, 1);
  equal(h.state.work.spotifyId, spotifyId);
  equal(h.state.replacements, 1);
  equal(h.state.appends, [25]);
  equal(h.state.items, h.state.work.target);
  equal(pages, [
    { offset: 0, count: 0, limit: 0 },
    { offset: 0, count: 50, limit: 50 },
    { offset: 50, count: 50, limit: 50 },
    { offset: 100, count: 25, limit: 50 },
  ]);
  equal(calls.filter((call) => call === "POST /v1/me/playlists").length, 1);
  if (!escaped) return;
  // User notes include literal entity syntax as well as characters Spotify
  // escapes; neither may acquire another encoding layer on regeneration.
  const prefix = "Notes &amp; / <x>  ";
  const suffix = "  'end' &#47;";
  h.state.description = prefix + h.state.description + suffix;
  h.state.name = "Owner renamed synthetic";
  h.state.work.action = "regenerate";
  h.state.work.retention = "pinned";
  h.state.complete = false;
  const result = await h.run(80000, client);
  if (corruption) {
    equal(result?.done, false);
    equal(h.state.errors, ["remote_changed"]);
    assert(!h.state.complete);
    return;
  }
  equal(result, { done: true });
  assert(h.state.complete);
  equal(h.state.name, "Owner renamed synthetic");
  assert(h.state.description.startsWith(prefix));
  assert(h.state.description.endsWith(suffix));
  equal(h.state.description.split(creationMarker(id)).length, 2);
  equal(h.state.description.split("[/Tagger]").length, 2);
  assert(h.state.description.includes("Pinned; never expires"));
  const once = h.state.description;
  equal(await h.run(80000, client), { done: true });
  equal(h.state.description, once);
  assert(responseCount > 0);
}
Deno.test("real runner and adapter populate a newly created playlist with a zero-limit empty page", () =>
  realAdapterRoundTrip());
Deno.test("real adapter metadata writes preserve escaped notes and visibility despite omitted-field reset", () =>
  realAdapterRoundTrip(true));

Deno.test("matching disclosure still repairs public/null/collaborative visibility before ready", async () => {
  for (
    const visibility of [
      { public: true, collaborative: false },
      { public: null, collaborative: false },
      { public: false, collaborative: true },
    ]
  ) {
    const h = harness(2);
    equal(await h.run(), { done: true });
    const before = {
      name: h.state.name,
      description: h.state.description,
      items: [...h.state.items],
      snapshot: h.state.snapshot,
    };
    Object.assign(h.state, visibility);
    h.state.complete = false;
    let updates = 0;
    h.state.onCall = (name) => {
      if (name === "description") updates++;
    };
    equal(await h.run(), { done: true });
    equal(updates, 1);
    equal(h.state.public, false);
    equal(h.state.collaborative, false);
    equal(h.state.complete, true);
    equal({
      name: h.state.name,
      description: h.state.description,
      items: h.state.items,
      snapshot: h.state.snapshot,
    }, before);
  }
});
Deno.test("persistent public/null/collaborative confirmation never reaches ready despite exact disclosure/items", async () => {
  for (
    const visibility of [
      { public: true, collaborative: false },
      { public: null, collaborative: false },
      { public: false, collaborative: true },
    ]
  ) {
    const h = harness(2);
    equal(await h.run(), { done: true });
    const description = h.state.description;
    h.state.complete = false;
    h.state.onCall = (name) => {
      if (name === "details") Object.assign(h.state, visibility);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      equal((await h.run())?.done, false);
      equal(h.state.complete, false);
      equal(h.state.description, description);
      equal(h.state.items, h.state.work.target);
    }
    equal(h.state.errors, ["remote_changed", "remote_changed"]);
    equal(h.state.creates, 1);
  }
});
Deno.test("reconcile repairs visibility with exact current notes and scrubbed labels, refusing changed snapshots or persistent visibility", async () => {
  for (const fault of ["", "public", "null", "snapshot", "description"]) {
    const h = harness(2);
    equal(await h.run(), { done: true });
    h.state.work.action = "reconcile";
    h.state.work.labels = {};
    h.state.work.target = [];
    h.state.name = "Owner renamed synthetic";
    h.state.description = "Outside notes &amp;  \n" + h.state.description;
    const before = h.state.description;
    h.state.public = true;
    h.state.complete = false;
    let updated = false;
    h.state.onCall = (name) => {
      if (name === "description") updated = true;
      if (name === "details" && updated) {
        if (fault === "public") h.state.public = true;
        if (fault === "null") h.state.public = null;
        if (fault === "snapshot") h.state.snapshot++;
        if (fault === "description") h.state.description += " changed";
      }
    };
    equal((await h.run())?.done, fault === "");
    equal(h.state.complete, fault === "");
    equal(h.state.errors, fault ? ["remote_changed"] : []);
    equal(h.state.name, "Owner renamed synthetic");
    if (fault !== "description") equal(h.state.description, before);
    equal(h.state.items, [uri(0), uri(1)]);
    equal(h.state.creates, 1);
    equal(updated, true);
  }
});
Deno.test("escaped confirmation still rejects actual description edits", () =>
  realAdapterRoundTrip(true, "description"));
Deno.test("escaped confirmation still rejects actual snapshot changes", () =>
  realAdapterRoundTrip(true, "snapshot"));

Deno.test("ambiguous create resolves durable marker without repeating POST", async () => {
  const h = harness(2);
  h.state.fault = "create";
  equal((await h.run())?.done, false);
  assert(!h.state.complete);
  assert(h.state.work.createAttempted);
  equal(h.state.work.spotifyId, null);
  equal((await h.run())?.done, true);
  equal(h.state.creates, 1);
  equal(h.state.items, h.state.work.target);
});
Deno.test("unresolved marker remains incomplete on repeated Retry, never duplicates create", async () => {
  const h = harness(2);
  h.state.work.createAttempted = true;
  h.state.exists = false;
  for (let i = 0; i < 3; i++) equal((await h.run())?.done, false);
  equal(h.state.creates, 0);
  equal(h.state.errors, [
    "creation_unknown",
    "creation_unknown",
    "creation_unknown",
  ]);
});
Deno.test("lost append response is recovered by verified prefix without duplicate tracks", async () => {
  const h = harness();
  h.state.fault = "append";
  equal((await h.run())?.done, false);
  equal(h.state.items.length, 200);
  equal((await h.run())?.done, true);
  equal(h.state.appends, [100, 50]);
  equal(h.state.items, h.state.work.target);
});
Deno.test("restarted operation rebuilds a divergent/null remote sequence", async () => {
  const h = harness();
  h.state.work.spotifyId = spotifyId;
  h.state.exists = true;
  h.state.items = [uri(0), null, uri(2), uri(2)];
  await h.run();
  equal(h.state.replacements, 1);
  equal(h.state.items, h.state.work.target);
});
Deno.test("regenerate preserves Spotify rename and outside description; incomplete retains old clock", async () => {
  const h = harness();
  h.state.work.spotifyId = spotifyId;
  h.state.work.action = "regenerate";
  h.state.exists = true;
  h.state.name = "Owner renamed this";
  h.state.description = "Owner notes  \n" +
    playlistDescription(id, "old", "2025-01-01", null) + "  More notes";
  h.state.fault = "append";
  await h.run();
  assert(!h.state.complete);
  equal(h.state.expiresOn, null);
  await h.run();
  assert(h.state.complete);
  equal(h.state.name, "Owner renamed this");
  assert(
    h.state.description.startsWith("Owner notes  \n") &&
      h.state.description.endsWith("  More notes"),
  );
  assert(h.state.description.includes(creationMarker(id)));
  equal(h.state.expiresOn, "2026-02-28");
});
Deno.test("lease loss/disconnect immediately fences the next Spotify mutation and late checkpoint", async () => {
  const h = harness();
  h.state.onCall = (name) => {
    if (name === "replace") h.state.failNextLease = true;
  };
  await h.run();
  equal(h.state.appends, []);
  assert(!h.state.complete);
});
Deno.test("cleanup confirms containment and collection absence while accessible playlist remains", async () => {
  const h = harness(2);
  h.state.work.spotifyId = spotifyId;
  h.state.work.action = "expire";
  h.state.exists = true;
  await h.run();
  equal(h.state.removes, 1);
  assert(h.state.removed && h.state.complete && h.state.exists);
});
Deno.test("external absence retires without a DELETE, route disagreement is not success", async () => {
  const h = harness(2);
  h.state.work.spotifyId = spotifyId;
  h.state.exists = true;
  h.state.contained = false;
  h.state.work.action = "reconcile";
  await h.run();
  assert(!h.state.complete);
  equal(h.state.errors, ["removal_unconfirmed"]);
  h.state.listed = false;
  await h.run();
  assert(h.state.removed);
  equal(h.state.removes, 0);
});
Deno.test("bounded work yields and resumes an ordered scan under a new lease", async () => {
  const h = harness(1200);
  equal((await h.run(51000))?.done, false);
  assert(!h.state.complete);
  assert(h.state.work.scan?.kind === "items" && h.state.work.scan.offset > 0);
  for (let i = 0; i < 10 && !h.state.complete; i++) await h.run();
  assert(h.state.complete);
  equal(h.state.items, h.state.work.target);
  equal(h.state.creates, 1);
});
Deno.test("a newly created playlist with delayed visibility remains incomplete, never falsely removed", async () => {
  const h = harness(2);
  h.state.contained = false;
  h.state.listed = false;
  equal((await h.run())?.done, false);
  assert(!h.state.complete && !h.state.removed);
  h.state.contained = true;
  h.state.listed = true;
  equal((await h.run())?.done, true);
  equal(h.state.creates, 1);
});
Deno.test("Pin updates only disclosure and preserves actual items and current name", async () => {
  const h = harness(2);
  h.state.work.spotifyId = spotifyId;
  h.state.exists = true;
  h.state.work.action = "pin";
  h.state.work.retention = "pinned";
  h.state.items = [uri(900)];
  h.state.name = "Current name";
  h.state.description = "User text";
  await h.run();
  assert(h.state.complete);
  equal(h.state.items, [uri(900)]);
  equal(h.state.name, "Current name");
  equal(h.state.appends, []);
  equal(h.state.replacements, 0);
  assert(
    h.state.description.startsWith("User text\n") &&
      h.state.description.includes("Pinned; never expires"),
  );
});
Deno.test("remote snapshot change while reading pages prevents append or ready", async () => {
  const h = harness(250);
  h.state.work.spotifyId = spotifyId;
  h.state.exists = true;
  h.state.items = h.state.work.target.slice(0, 120);
  let changed = false;
  h.state.onCall = (name) => {
    if (name === "items" && !changed) {
      h.state.snapshot++;
      changed = true;
    }
  };
  equal((await h.run())?.done, false);
  equal(h.state.appends, []);
  assert(!h.state.complete);
  equal(h.state.errors, ["remote_changed"]);
  equal((await h.run())?.done, true);
  equal(h.state.items, h.state.work.target);
});
Deno.test("short drain never marks an unissued create as attempted", async () => {
  const h = harness(2);
  equal((await h.run(49000))?.done, false);
  assert(!h.state.work.createAttempted);
  equal(h.state.creates, 0);
});
Deno.test("cleanup repeated DELETE is safe when containment and collection initially disagree", async () => {
  const h = harness(2);
  h.state.work.spotifyId = spotifyId;
  h.state.exists = true;
  h.state.work.action = "delete";
  h.state.contained = false;
  h.state.listed = true;
  await h.run();
  equal(h.state.removes, 1);
  assert(h.state.removed && h.state.complete);
});
Deno.test("more than one hundred write chunks survive bounded drains with exact ordered contents", async () => {
  const h = harness(10501);
  for (let i = 0; i < 10 && !h.state.complete; i++) await h.run();
  assert(h.state.complete);
  equal(h.state.creates, 1);
  assert(
    h.state.appends.length > 100 &&
      h.state.appends.every((size) => size > 0 && size <= 100),
  );
  equal(h.state.items, h.state.work.target);
});
Deno.test("DELETE 404 requires both absence checks, and 403 never claims removal", async () => {
  const h = harness(2);
  h.state.work.spotifyId = spotifyId;
  h.state.work.action = "expire";
  h.state.exists = true;
  h.state.fault = "remove404";
  await h.run();
  assert(!h.state.complete);
  h.state.contained = false;
  h.state.listed = false;
  await h.run();
  assert(h.state.removed && h.state.complete);
  const denied = harness(2);
  denied.state.work.spotifyId = spotifyId;
  denied.state.work.action = "delete";
  denied.state.fault = "remove403";
  await denied.run();
  assert(!denied.state.complete && !denied.state.removed);
});
