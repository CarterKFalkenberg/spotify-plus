import { createSourcesRunner, sourcePage } from "./sources.ts";
import {
  emptySourceRequest,
  sourceSelection,
  sourcesList,
} from "./sources-contracts.ts";
import { SecretBox } from "./crypto.ts";
import type { SpotifyPlaylist, SpotifyTrack } from "./spotify.ts";
import { SpotifyError } from "./spotify.ts";
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
