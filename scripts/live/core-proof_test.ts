import {
  assertPreview,
  assertPreviewPage,
  assertProgress,
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

// scripts/check runs this entrypoint explicitly; retain the fast proof boundary
// checks alongside the shared registry checks without changing the orchestrator.
import "./fast-proof_test.ts";
