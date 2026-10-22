import { createSourcesRunner, sourcePage } from "./sources.ts";
import {
  emptySourceRequest,
  sourceSelection,
  sourcesList,
} from "./sources-contracts.ts";
import { SecretBox } from "./crypto.ts";
import type { SpotifyPlaylist, SpotifyTrack } from "./spotify.ts";
import { SpotifyClient, SpotifyError } from "./spotify.ts";
import { assert, database, equal, rejects, TEST_KEY } from "./testing.ts";
const sourceId = "p".repeat(22);
const box = new SecretBox(TEST_KEY);
const track: SpotifyTrack = {
  id: "a".repeat(22),
  uri: `spotify:track:${"a".repeat(22)}`,
  name: "Synthetic title",
  artists: [{ id: "b".repeat(22), name: "Synthetic artist" }],
  album: {
    id: "c".repeat(22),
    name: "Synthetic album",
    releaseDate: "2026",
    images: [],
  },
  durationMs: 120000,
  explicit: false,
  isLocal: false,
  isPlayable: true,
};
const metadata: SpotifyPlaylist = {
  id: sourceId,
  name: "Synthetic source",
  description: null,
  public: false,
  collaborative: false,
  ownerId: "synthetic-owner",
  snapshotId: "snapshot",
  total: 1,
};
const job = {
  id: "synthetic-job",
  kind: "source_sync",
  epoch: 1,
  payload: {},
  attempts: 1,
  leaseToken: "synthetic-lease",
};
async function fixture(overrides: Record<string, unknown> = {}) {
  return {
    offset: 0,
    snapshotId: null,
    sourceId,
    previousSnapshotId: null,
    lastSyncedAt: null,
    encryptedKey: await box.encrypt(TEST_KEY, "annotation-key:1"),
    accountId: "synthetic-owner",
    enabled: true,
    terminal: false,
    ...overrides,
  };
}
Deno.test("source contracts bind explicit IDs, reject unknown fields and bound list and batch sizes", async () => {
  equal(
    sourceSelection({ ids: ["liked", sourceId, "liked"], enabled: false }),
    { ids: ["liked", sourceId], enabled: false },
  );
  equal(
    sourcesList(
      new URL("https://synthetic.example/api/sources?offset=50&limit=100"),
    ),
    { search: "", offset: 50, limit: 100 },
  );
  for (
    const v of [
      { ids: [], enabled: true },
      { ids: [sourceId], enabled: "true" },
      { ids: ["bad"], enabled: false },
      { ids: [sourceId], enabled: true, filter: {} },
    ]
  ) await rejects(() => Promise.resolve(sourceSelection(v)));
  for (
    const q of ["limit=101", "offset=-1", "search=a&search=b", "unknown=a"]
  ) {
    await rejects(() =>
      Promise.resolve(sourcesList(new URL(`https://synthetic.example/?${q}`)))
    );
  }
  await rejects(() => Promise.resolve(emptySourceRequest({ query: "hidden" })));
});
Deno.test("source projection skips local and episode entries, separates unresolved coverage and preserves rich versions", async () => {
  const p = await sourcePage({
    total: 4,
    offset: 0,
    limit: 50,
    nextOffset: null,
    items: [
      {
        addedAt: "2026-01-01T00:00:00Z",
        uri: track.uri,
        isLocal: false,
        type: "track",
        track: { ...track, name: "Synthetic title (Live)" },
      },
      { addedAt: null, uri: null, isLocal: true, type: "track" },
      { addedAt: null, uri: null, isLocal: false, type: "episode" },
      { addedAt: null, uri: null, isLocal: false, type: "unavailable" },
    ],
  }, TEST_KEY);
  equal(p.skipped, 2);
  equal(p.unresolved, 1);
  equal(p.rows.length, 1);
  equal(p.rows[0].title, "Synthetic title (Live)");
});
Deno.test("missing playlist addition dates carry explicit first-discovery persistence marker", async () => {
  const p = await sourcePage({
    total: 1,
    offset: 0,
    limit: 50,
    nextOffset: null,
    items: [{
      addedAt: null,
      uri: track.uri,
      isLocal: false,
      type: "track",
      track,
    }],
  }, TEST_KEY);
  equal(p.rows[0].addedAtMissing, true);
});
Deno.test("unchanged playlist snapshot skips content reads and disabled source reads nothing", async () => {
  for (const enabled of [true, false]) {
    let reads = 0;
    let finishes = 0;
    const state = await fixture({
      enabled,
      lastSyncedAt: "2026-01-01T00:00:00Z",
      previousSnapshotId: "snapshot",
    });
    const runner = createSourcesRunner({
      db: database((name) => {
        if (name === "app_source_job_state") return state;
        if (name === "app_source_finish") {
          finishes++;
          return { done: true };
        }
        throw Error("unexpected RPC");
      }),
      annotationBox: box,
      spotify: () => ({
        getPlaylist: () => {
          reads++;
          return Promise.resolve(metadata);
        },
        getPlaylistItemsPage: () => {
          throw Error("content fetched");
        },
        getCurrentUserPlaylistsPage: () => {
          throw Error("discovery fetched");
        },
      }),
    });
    equal(await runner(job, Date.now() + 80000), { done: true });
    equal(reads, enabled ? 1 : 0);
    equal(finishes, enabled ? 1 : 0);
  }
});
Deno.test("source walk validates before and after snapshots with bounded50item pages and no per-song call", async () => {
  const state = await fixture();
  const calls: string[] = [];
  let done = false;
  const runner = createSourcesRunner({
    annotationBox: box,
    wait: async () => {},
    db: database((name, args) => {
      calls.push(name);
      if (name === "app_source_job_state") return state;
      if (name === "app_job_renew") return true;
      if (name === "app_source_page_commit") {
        equal(args.p_snapshot, "snapshot");
        equal((args.p_rows as unknown[]).length, 1);
        return { done: false, terminal: true };
      }
      if (name === "app_source_finish") {
        equal(args.p_snapshot, "changed");
        done = true;
        return { done: false, retryMs: 60000 };
      }
      throw Error("unexpected RPC");
    }),
    spotify: () => ({
      getPlaylist: () =>
        Promise.resolve({
          ...metadata,
          snapshotId: done || calls.includes("app_source_page_commit")
            ? "changed"
            : "snapshot",
        }),
      getPlaylistItemsPage: (_id, query) => {
        equal(query, { offset: 0, limit: 50 });
        return Promise.resolve({
          offset: 0,
          limit: 50,
          nextOffset: null,
          total: 1,
          items: [{
            addedAt: "2026-01-01T00:00:00Z",
            uri: track.uri,
            isLocal: false,
            type: "track",
            track,
          }],
        });
      },
      getCurrentUserPlaylistsPage: () => {
        throw Error("unexpected");
      },
    }),
  });
  equal(await runner(job, Date.now() + 80000), { done: false, retryMs: 60000 });
  assert(done);
});
Deno.test("selection and lease are rechecked before content; access failure records fixed error and cooldown retries", async () => {
  for (
    const reason of ["disabled", "lease", "forbidden", "cooldown"] as const
  ) {
    const state = await fixture();
    let states = 0;
    let content = 0;
    let finishes = 0;
    const runner = createSourcesRunner({
      annotationBox: box,
      wait: async () => {},
      db: database((name, args) => {
        if (name === "app_source_job_state") {
          states++;
          return { ...state, enabled: reason !== "disabled" || states === 1 };
        }
        if (name === "app_job_renew") return reason !== "lease";
        if (name === "app_source_finish") {
          finishes++;
          equal(args.p_error, "forbidden");
          return { done: true };
        }
        throw Error("unexpected RPC");
      }),
      spotify: () => ({
        getPlaylist: () => Promise.resolve(metadata),
        getPlaylistItemsPage: () => {
          content++;
          throw new SpotifyError(
            reason === "forbidden" ? "forbidden" : "cooldown",
          );
        },
        getCurrentUserPlaylistsPage: () => {
          throw Error("unexpected");
        },
      }),
    });
    if (reason === "cooldown") {
      await rejects(
        () => runner(job, Date.now() + 80000),
        (e) => e instanceof SpotifyError && e.kind === "cooldown",
      );
    } else await runner(job, Date.now() + 80000);
    equal(content, ["disabled", "lease"].includes(reason) ? 0 : 1);
    equal(finishes, reason === "forbidden" ? 1 : 0);
  }
});
Deno.test("partial200metadata followed by403or404contents finishes unavailable without weakening transport", async () => {
  for (const status of [403, 404]) {
    const state = await fixture();
    const events: string[] = [];
    const client = new SpotifyClient({
      tokens: {
        getAccessToken: () => Promise.resolve("synthetic-token"),
        refreshAccessToken: () => Promise.resolve("synthetic-token"),
      },
      pacing: {
        acquire: () => Promise.resolve({ granted: true, retryAfterMs: 0 }),
        defer: () => Promise.resolve(),
      },
      isManagedPlaylist: () => Promise.resolve(false),
      fetch: (request) => {
        const url = new URL(String(request));
        events.push(url.pathname);
        if (url.pathname.endsWith("/items")) {
          equal(url.searchParams.get("limit"), "1");
          equal(url.searchParams.get("offset"), "0");
          return Promise.resolve(new Response(null, { status }));
        }
        return Promise.resolve(Response.json({
          id: sourceId,
          name: "Synthetic partial playlist",
          description: null,
          public: false,
          collaborative: false,
          owner: { id: "synthetic-owner" },
          snapshot_id: "snapshot",
          // Missing collection total is an actual strict adapter failure.
        }));
      },
    });
    const runner = createSourcesRunner({
      annotationBox: box,
      spotify: () => client,
      wait: (ms) => {
        equal(ms, 550);
        events.push("spacing");
        return Promise.resolve();
      },
      db: database((name, args) => {
        events.push(name);
        if (name === "app_source_job_state") return state;
        if (name === "app_job_renew") return true;
        if (name === "app_source_finish") {
          equal(args.p_error, status === 403 ? "forbidden" : "not_found");
          equal(args.p_snapshot, null);
          return { done: true };
        }
        throw Error("unexpected RPC");
      }),
    });
    equal(await runner(job, Date.now() + 80000), { done: true });
    equal(events, [
      "app_source_job_state",
      `/v1/playlists/${sourceId}`,
      "spacing",
      "app_source_job_state",
      "app_job_renew",
      `/v1/playlists/${sourceId}/items`,
      "app_source_finish",
    ]);
  }
});
Deno.test("response access probe retains strict failures and propagates retry and reconnect errors", async () => {
  for (
    const outcome of [
      "success",
      "response",
      "authentication",
      "quota",
      "rate_limit",
      "cooldown",
      "network",
      "control_unavailable",
      "http",
    ] as const
  ) {
    const state = await fixture();
    const original = new SpotifyError("response");
    const probeError = outcome === "success" ? null : new SpotifyError(outcome);
    let probes = 0;
    let finishes = 0;
    const runner = createSourcesRunner({
      annotationBox: box,
      wait: async () => {},
      db: database((name, args) => {
        if (name === "app_source_job_state") return state;
        if (name === "app_job_renew") return true;
        if (name === "app_source_finish") {
          finishes++;
          equal(args.p_error, "response");
          equal(args.p_snapshot, null);
          return { done: true };
        }
        throw Error("unexpected RPC");
      }),
      spotify: () => ({
        getPlaylist: () => Promise.reject(original),
        getPlaylistItemsPage: (_id, query) => {
          probes++;
          equal(query, { offset: 0, limit: 1 });
          return probeError ? Promise.reject(probeError) : Promise.resolve({
            items: [],
            total: 0,
            offset: 0,
            limit: 1,
            nextOffset: null,
          });
        },
        getCurrentUserPlaylistsPage: () => {
          throw Error("unexpected discovery");
        },
      }),
    });
    if (["success", "response"].includes(outcome)) {
      equal(await runner(job, Date.now() + 80000), { done: true });
      equal(finishes, 1);
    } else {
      await rejects(
        () => runner(job, Date.now() + 80000),
        (e) => e === probeError,
      );
      equal(finishes, 0);
    }
    equal(probes, 1);
  }
});
Deno.test("response access probe fences late selection changes and stale leases", async () => {
  for (const reason of ["disabled", "stale", "renewal"] as const) {
    const state = await fixture();
    let states = 0;
    let renewals = 0;
    const runner = createSourcesRunner({
      annotationBox: box,
      wait: async () => {},
      db: database((name) => {
        if (name === "app_source_job_state") {
          states++;
          return states === 1 ? state : reason === "stale" ? null : {
            ...state,
            enabled: reason !== "disabled",
          };
        }
        if (name === "app_job_renew") {
          renewals++;
          return false;
        }
        throw Error("unexpected RPC");
      }),
      spotify: () => ({
        getPlaylist: () => Promise.reject(new SpotifyError("response")),
        getPlaylistItemsPage: () => {
          throw Error("stale content probe");
        },
        getCurrentUserPlaylistsPage: () => {
          throw Error("unexpected discovery");
        },
      }),
    });
    equal(
      await runner(job, Date.now() + 80000),
      reason === "disabled" ? { done: true } : null,
    );
    equal(states, 2);
    equal(renewals, reason === "renewal" ? 1 : 0);
  }
});
Deno.test("postwalk metadata response failure probes access without confirming scanned content", async () => {
  const state = await fixture();
  let metadataReads = 0;
  let contentReads = 0;
  let commits = 0;
  const runner = createSourcesRunner({
    annotationBox: box,
    wait: async () => {},
    db: database((name, args) => {
      if (name === "app_source_job_state") return state;
      if (name === "app_job_renew") return true;
      if (name === "app_source_page_commit") {
        commits++;
        return { done: false, terminal: true };
      }
      if (name === "app_source_finish") {
        equal(args.p_snapshot, null);
        equal(args.p_error, "not_found");
        return { done: true };
      }
      throw Error("unexpected RPC");
    }),
    spotify: () => ({
      getPlaylist: () =>
        ++metadataReads === 1
          ? Promise.resolve(metadata)
          : Promise.reject(new SpotifyError("response")),
      getPlaylistItemsPage: (_id, query) => {
        contentReads++;
        equal(query, { offset: 0, limit: contentReads === 1 ? 50 : 1 });
        return contentReads === 1
          ? Promise.resolve({
            items: [],
            total: 0,
            offset: 0,
            limit: 50,
            nextOffset: null,
          })
          : Promise.reject(new SpotifyError("not_found", 404));
      },
      getCurrentUserPlaylistsPage: () => {
        throw Error("unexpected discovery");
      },
    }),
  });
  equal(await runner(job, Date.now() + 80000), { done: true });
  equal(metadataReads, 2);
  equal(contentReads, 2);
  equal(commits, 1);
});
Deno.test("large source imports checkpoint at50items and five pages per invocation then resume exact offset", async () => {
  const state = { ...await fixture(), snapshotId: null as string | null };
  let contentCalls = 0;
  let metadataCalls = 0;
  const runner = createSourcesRunner({
    annotationBox: box,
    wait: () => Promise.resolve(),
    db: database((name, args) => {
      if (name === "app_source_job_state") return { ...state };
      if (name === "app_job_renew") return true;
      if (name === "app_source_page_commit") {
        equal(args.p_offset, state.offset);
        equal((args.p_rows as unknown[]).length, 50);
        equal(args.p_received, 50);
        state.offset += 50;
        state.snapshotId = "snapshot";
        return { done: false, terminal: false };
      }
      throw Error("unexpected RPC");
    }),
    spotify: () => ({
      getPlaylist: () => {
        metadataCalls++;
        return Promise.resolve(metadata);
      },
      getPlaylistItemsPage: (_id, query) => {
        contentCalls++;
        equal(query, { offset: state.offset, limit: 50 });
        return Promise.resolve({
          offset: state.offset,
          limit: 50,
          total: 10000,
          nextOffset: state.offset + 50,
          items: Array.from({ length: 50 }, (_, i) => ({
            addedAt: "2026-01-01T00:00:00Z",
            uri: track.uri,
            isLocal: false,
            type: "track" as const,
            track: {
              ...track,
              id: (state.offset + i).toString(36).padStart(22, "0"),
            },
          })),
        });
      },
      getCurrentUserPlaylistsPage: () => {
        throw Error("unexpected");
      },
    }),
  });
  equal(await runner(job, Date.now() + 80000), { done: false, retryMs: 1000 });
  equal(state.offset, 250);
  equal(contentCalls, 5);
  equal(metadataCalls, 1);
  equal(await runner(job, Date.now() + 80000), { done: false, retryMs: 1000 });
  equal(state.offset, 500);
  equal(contentCalls, 10);
  equal(metadataCalls, 2);
});
