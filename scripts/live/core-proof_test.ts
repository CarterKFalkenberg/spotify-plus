import {
  assertDisposableRenameAcknowledged,
  assertPreview,
  assertPreviewPage,
  assertProgress,
  type PlaylistReadinessWork,
  waitForPlaylistReady,
} from "./core-proof.ts";
import {
  cleanupFixturesSql,
  duePlaylistSql,
  insertFixturesSql,
  newRegistry,
  ProofFailure,
} from "./core-fixtures.ts";
import type {
  LibraryStatusDTO,
  ManagedPlaylistDTO,
  QueryPreviewResponse,
  TrackDTO,
} from "../../supabase/functions/_shared/contracts.ts";
import { equal } from "../../supabase/functions/_shared/testing.ts";
function fails(fn: () => unknown) {
  let failed = false;
  try {
    fn();
  } catch (error) {
    failed = error instanceof ProofFailure;
  }
  equal(failed, true);
}
const track = (key: string, likedAt: string, playable = true): TrackDTO => ({
  trackKey: key.repeat(64),
  tagIds: [],
  metadata: {
    title: "Synthetic",
    artists: [],
    album: "Synthetic",
    releaseDate: null,
    durationMs: 1000,
    explicit: false,
    artworkUrl: null,
    spotifyUrl: null,
    playableUri: playable ? "spotify:track:" + key.repeat(22) : null,
    likedAt,
    removedAt: null,
    acknowledgedAt: null,
  },
});
Deno.test("operator rename acknowledges only supported success and emits fixed status classes without vendor bodies", async () => {
  for (
    const [status, code] of [
      [200, null],
      [204, null],
      [400, "bad_request"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [500, "server_error"],
      [202, "unexpected_status"],
    ] as const
  ) {
    const response = new Response(
      status === 204 ? null : "synthetic vendor body",
      { status },
    );
    let failed: string | null = null;
    try {
      await assertDisposableRenameAcknowledged(response, () => {
        throw new Error("unexpected defer");
      });
    } catch (error) {
      equal(error instanceof ProofFailure, true);
      failed = (error as Error).message;
    }
    equal(failed, code === null ? null : `core_disposable_rename_${code}`);
    if (failed) equal(/^[a-z_]+$/.test(failed), true);
  }
});
Deno.test("operator rename 429 persists shared Retry-After then fails without replay or raw cooldown errors", async () => {
  const deferrals: unknown[] = [];
  for (const rejects of [false, true]) {
    const response = new Response("synthetic vendor body", {
      status: 429,
      headers: { "retry-after": "120" },
    });
    let code = "";
    try {
      await assertDisposableRenameAcknowledged(response, (input) => {
        deferrals.push(input);
        return rejects
          ? Promise.reject(new Error("synthetic private failure"))
          : Promise.resolve();
      });
    } catch (error) {
      equal(error instanceof ProofFailure, true);
      code = (error as Error).message;
    }
    equal(
      code,
      rejects
        ? "core_disposable_rename_cooldown_unconfirmed"
        : "core_disposable_rename_rate_limited",
    );
  }
  equal(deferrals, [{ retryAfterMs: 120000, kind: "rate_limit" }, {
    retryAfterMs: 120000,
    kind: "rate_limit",
  }]);
});
Deno.test("operator rename quota uses six-hour shared quota cooldown or longer Retry-After without leaking vendor fields", async () => {
  for (
    const [header, expected] of [["5", 21600000], ["86400", 86400000]] as const
  ) {
    const response = Response.json({
      error: {
        reason: "QUOTA_EXCEEDED",
        message: "synthetic private vendor field",
      },
    }, { status: 429, headers: { "retry-after": header } });
    const deferrals: unknown[] = [];
    let code = "";
    try {
      await assertDisposableRenameAcknowledged(response, (input) => {
        deferrals.push(input);
        return Promise.resolve();
      });
    } catch (error) {
      equal(error instanceof ProofFailure, true);
      code = (error as Error).message;
    }
    equal(code, "core_disposable_rename_quota");
    equal(deferrals, [{ retryAfterMs: expected, kind: "quota" }]);
  }
});
Deno.test("preview proof rejects stale count, unavailable duration, duplicate membership and wrong order", () => {
  const tracks = [
    track("a", "2026-10-11T12:00:00Z"),
    track("b", "2026-10-10T12:00:00Z", false),
  ];
  const page: QueryPreviewResponse = {
    query: { version: 1, root: { op: "tag", tagId: crypto.randomUUID() } },
    revision: { library: "1", annotations: "0" },
    generationReady: true,
    matchedCount: 2,
    playableCount: 1,
    excludedCount: 1,
    durationMs: 1000,
    tracks,
    nextCursor: null,
  };
  assertPreview(page, tracks);
  // PostgreSQL JSONB can reorder object fields without changing the stored AST.
  assertPreviewPage(page.query, page, {
    ...page,
    query: {
      root: {
        tagId: page.query.root.op === "tag" ? page.query.root.tagId : "",
        op: "tag",
      },
      version: 1,
    },
    revision: { annotations: "0", library: "1" },
  });
  fails(() =>
    assertPreviewPage(page.query, page, {
      ...page,
      query: { version: 1, root: { op: "tag", tagId: crypto.randomUUID() } },
    })
  );
  fails(() =>
    assertPreviewPage(page.query, page, {
      ...page,
      revision: { library: "2", annotations: "0" },
    })
  );
  for (
    const patch of [
      { matchedCount: 3 },
      { playableCount: 2 },
      { excludedCount: 0 },
      { durationMs: 2000 },
      { generationReady: false },
    ]
  ) {
    fails(() => assertPreview({ ...page, ...patch }, tracks));
    fails(() => assertPreviewPage(page.query, page, { ...page, ...patch }));
  }
  fails(() => assertPreview(page, [...tracks].reverse()));
  fails(() =>
    assertPreview({
      ...page,
      playableCount: 2,
      excludedCount: 0,
      durationMs: 2000,
    }, [tracks[0], tracks[0]])
  );
});
Deno.test("deterministic progress accepts explicit empty completion and rejects blocked/impossible counts", () => {
  const status: LibraryStatusDTO = {
    revision: { library: "0", annotations: "0" },
    initialSyncComplete: true,
    syncPhase: "idle",
    importedCount: 0,
    reportedTotal: 0,
    activeCount: 0,
    untaggedCount: 0,
    newCount: 0,
    lastCompletedAt: "2026-10-11T12:00:00Z",
    blockedBy: null,
  };
  assertProgress(status);
  for (
    const patch of [{ blockedBy: "quota" as const }, { newCount: 1 }, {
      importedCount: -1,
    }, { reportedTotal: NaN }]
  ) fails(() => assertProgress({ ...status, ...patch }));
});
Deno.test("operator SQL rejects malformed registry inputs before rendering a statement", () => {
  const registry = newRegistry(1, "a".repeat(64));
  for (
    const patch of [
      { epoch: NaN },
      { ownerFingerprint: "' OR true; --" },
      { run: "bad" },
      { tagIds: ["bad", "bad"] },
      { trackKeys: ["'", registry.trackKeys[1], registry.trackKeys[2]] },
      { spotifyIds: ["bad", registry.spotifyIds[1], registry.spotifyIds[2]] },
    ]
  ) {
    fails(() => insertFixturesSql({ ...registry, ...patch }));
    fails(() => cleanupFixturesSql({ ...registry, ...patch }, true));
  }
  fails(() => duePlaylistSql(registry));
});

const readyPlaylist: ManagedPlaylistDTO = {
  id: "00000000-0000-4000-8000-000000000001",
  revision: "3",
  name: "Synthetic playlist",
  spotifyUrl: null,
  query: { version: 1, root: { op: "tag", tagId: crypto.randomUUID() } },
  retention: "month",
  createdAt: "2026-10-11T12:00:00Z",
  expiresOn: "2026-11-11",
  trackCount: 1,
  status: "ready",
  blockedBy: null,
};
const retryWork: PlaylistReadinessWork = {
  status: "incomplete",
  blockedBy: "unavailable",
  operationState: "active",
  jobState: "queued",
};
async function readinessFailure(
  read: () => Promise<ManagedPlaylistDTO | null>,
  work: PlaylistReadinessWork | null,
  code: string,
  attempts = 120,
) {
  let reads = 0, pauses = 0;
  try {
    await waitForPlaylistReady(
      async () => {
        reads++;
        return await read();
      },
      () => Promise.resolve(work),
      (ms) => {
        equal(ms, 5000);
        pauses++;
        return Promise.resolve();
      },
      attempts,
    );
    throw new Error("expected readiness failure");
  } catch (error) {
    equal(error instanceof ProofFailure, true);
    equal((error as Error).message, code);
  }
  return { reads, pauses };
}
Deno.test("readiness waits through natural queued/running retries and returns only the ready DTO", async () => {
  for (const blockedBy of ["unavailable", "rateLimited"] as const) {
    let reads = 0, workReads = 0, pauses = 0;
    const result = await waitForPlaylistReady(
      () =>
        Promise.resolve(
          ++reads <= 2
            ? { ...readyPlaylist, status: "incomplete", blockedBy }
            : readyPlaylist,
        ),
      () =>
        Promise.resolve({
          ...retryWork,
          blockedBy,
          jobState: ++workReads === 1 ? "queued" : "running",
        }),
      (ms) => {
        equal(ms, 5000);
        pauses++;
        return Promise.resolve();
      },
    );
    equal(result, readyPlaylist);
    equal({ reads, workReads, pauses }, { reads: 3, workReads: 2, pauses: 2 });
  }
});
Deno.test("readiness fails immediately on permanent blocks, stalled/parked work and missing playlists", async () => {
  for (const blockedBy of ["reconnect", "quota"] as const) {
    equal(
      await readinessFailure(
        () =>
          Promise.resolve({
            ...readyPlaylist,
            status: "incomplete",
            blockedBy,
          }),
        retryWork,
        "core_playlist_work_blocked",
      ),
      { reads: 1, pauses: 0 },
    );
  }
  for (
    const work of [
      null,
      { ...retryWork, operationState: "stalled" },
      { ...retryWork, jobState: "parked" },
      { ...retryWork, jobState: "done" },
      { ...retryWork, jobState: "cancelled" },
      { ...retryWork, blockedBy: "quota" },
      { ...retryWork, status: "removing" },
    ]
  ) {
    equal(
      await readinessFailure(
        () =>
          Promise.resolve({
            ...readyPlaylist,
            status: "incomplete",
            blockedBy: "unavailable",
          }),
        work,
        "core_playlist_incomplete_requires_operator",
      ),
      { reads: 1, pauses: 0 },
    );
  }
  equal(
    await readinessFailure(
      () => Promise.resolve(null),
      retryWork,
      "core_playlist_work_blocked",
    ),
    { reads: 1, pauses: 0 },
  );
  equal(
    await readinessFailure(
      () =>
        Promise.resolve({
          ...readyPlaylist,
          status: "incomplete",
          blockedBy: null,
        }),
      { ...retryWork, blockedBy: null, operationState: "stalled" },
      "core_playlist_incomplete_requires_operator",
    ),
    { reads: 1, pauses: 0 },
  );
});
Deno.test("readiness re-polls completion racing the DTO and does not accept SQL as ready proof", async () => {
  let reads = 0;
  const completedWork = {
    status: "ready",
    blockedBy: null,
    operationState: null,
    jobState: null,
  };
  equal(
    await waitForPlaylistReady(
      () =>
        Promise.resolve(
          ++reads === 1
            ? {
              ...readyPlaylist,
              status: "incomplete",
              blockedBy: "unavailable",
            }
            : readyPlaylist,
        ),
      () => Promise.resolve(completedWork),
      () => Promise.resolve(),
    ),
    readyPlaylist,
  );
  equal(reads, 2);
  equal(
    await readinessFailure(
      () =>
        Promise.resolve({
          ...readyPlaylist,
          status: "incomplete",
          blockedBy: "unavailable",
        }),
      completedWork,
      "core_playlist_not_ready",
      3,
    ),
    { reads: 3, pauses: 3 },
  );
});
Deno.test("persistent retryable failure and pending work exhaust the bounded readiness wait", async () => {
  for (const status of ["incomplete", "pending"] as const) {
    equal(
      await readinessFailure(
        () =>
          Promise.resolve({
            ...readyPlaylist,
            status,
            blockedBy: status === "incomplete" ? "unavailable" : null,
          }),
        retryWork,
        "core_playlist_not_ready",
      ),
      { reads: 120, pauses: 120 },
    );
  }
});

// scripts/check runs this entrypoint explicitly; retain the fast proof boundary
// checks alongside the shared registry checks without changing the orchestrator.
import "./fast-proof_test.ts";
