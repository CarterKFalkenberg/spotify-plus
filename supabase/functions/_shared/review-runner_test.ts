import { deepStrictEqual, strictEqual } from "node:assert/strict";
import type { Database } from "./database.ts";
import type { Job } from "./jobs.ts";
import { createReviewRunner, type ReviewWorkerState } from "./review-runner.ts";
import { SpotifyError } from "./spotify.ts";
const uri = "spotify:track:" + "t".repeat(22);
const playlist = "p".repeat(22);
const job = {
  epoch: 1,
  id: "job",
  leaseToken: "lease",
  kind: "review",
} as Job;
function fixture() {
  const events: string[] = [];
  const observations: Record<string, unknown>[] = [];
  const state: ReviewWorkerState = {
    accountId: "owner",
    trackKey: "1".repeat(64),
    uri,
    operation: {
      id: "operation",
      status: "adding",
      phase: "adding",
      kind: "done",
    },
    items: [{ playlist_id: playlist, state: "pending", snapshot_id: null }],
    destinations: [playlist],
    cache: [],
    memberships: [{
      playlist_id: playlist,
      status: "absent",
      snapshot_id: "before",
      next_offset: 0,
      observed: 0,
      occurrences: 0,
      total: 0,
      checked_at: new Date(100000).toISOString(),
    }],
  };
  let allowed = true;
  let appendError: unknown;
  let reverseError: unknown;
  let liked = true;
  let ownerProfile = "profile";
  let metadataSnapshot = "before";
  const reversals: unknown[][] = [];
  let remoteUris: string[] = [];
  let itemReads = 0;
  let metadataTotal: number | null = null;
  let pageTotal: number | null = null;
  const db = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      if (_name === "app_review_worker") return Promise.resolve(state);
      events.push(String(args.p_event ?? "scan"));
      if (_name === "app_review_scan") {
        observations.push(args.p_observation as Record<string, unknown>);
      }
      return Promise.resolve(allowed);
    },
  } as Database;
  const client = {
    getCurrentUser: () =>
      Promise.resolve({ accountId: "owner", id: "profile" }),
    getPlaylist: () =>
      Promise.resolve({
        ownerId: ownerProfile,
        ownerAccountId: null,
        ownerProfileId: ownerProfile,
        snapshotId: metadataSnapshot,
        total: metadataTotal ?? remoteUris.length,
        id: playlist,
        name: "Synthetic playlist",
        description: null,
        public: false,
        collaborative: false,
      }),
    getPlaylistItemsPage: (
      _id: string,
      query?: { offset?: number; limit?: number },
    ) => {
      itemReads++;
      return Promise.resolve({
        items: remoteUris.map((uri) => ({
          uri,
          addedAt: null,
          isLocal: false,
          type: "track" as const,
        })),
        total: pageTotal ?? remoteUris.length,
        nextOffset: null,
        offset: query?.offset ?? 0,
        limit: 50,
      });
    },
    containsTracks: () => {
      events.push("contains");
      return Promise.resolve([liked]);
    },
    reviewAppend: () => {
      events.push("append");
      return appendError
        ? Promise.reject(appendError)
        : Promise.resolve({ snapshotId: "after" });
    },
    reviewUnlike: () => {
      events.push("unlike");
      return Promise.resolve();
    },
    reviewReverse: (
      _operation: string,
      _playlist: string,
      _uri: string,
      snapshot: string,
    ) => {
      reversals.push([_operation, _playlist, _uri, snapshot]);
      events.push("reverse");
      return reverseError
        ? Promise.reject(reverseError)
        : Promise.resolve({ snapshotId: "removed" });
    },
    reviewRestore: () => {
      events.push("restore");
      return Promise.resolve();
    },
  };
  const run = createReviewRunner({
    db,
    spotify: () => client,
    now: () => 100000,
    wait: () => Promise.resolve(),
  });
  return {
    state,
    events,
    observations,
    reversals,
    setSnapshot: (value: string) => metadataSnapshot = value,
    itemReads: () => itemReads,
    setItems: (uris: string[]) => remoteUris = uris,
    setMetadataTotal: (value: number) => metadataTotal = value,
    setPageTotal: (value: number) => pageTotal = value,
    run: () => run(job, 200000),
    deny: () => allowed = false,
    fail: (error: unknown) => appendError = error,
    failReverse: (error: unknown) => reverseError = error,
    setLiked: (value: boolean) => liked = value,
    setOwner: (value: string) => ownerProfile = value,
  };
}
Deno.test("review commits append intent before dispatch and never unlikes in that invocation", async () => {
  const f = fixture();
  await f.run();
  deepStrictEqual(f.events, ["append_intent", "append", "append_confirmed"]);
});
Deno.test("review never sends append when SQL rejects its intent", async () => {
  const f = fixture();
  f.deny();
  strictEqual(await f.run(), null);
  deepStrictEqual(f.events, ["append_intent"]);
});
Deno.test("review reclaimed sending work reconciles without replay", async () => {
  const f = fixture();
  f.state.items[0].state = "sending";
  await f.run();
  deepStrictEqual(f.events, ["append_uncertain"]);
});
Deno.test("review ambiguous append absent on later scan parks without replay or unlike", async () => {
  const f = fixture();
  f.fail(new SpotifyError("network", null, null, true));
  await f.run();
  deepStrictEqual(f.events, ["append_intent", "append", "append_uncertain"]);
  f.events.length = 0;
  f.state.items[0].state = "unconfirmed";
  await f.run();
  deepStrictEqual(f.events, ["attention"]);
});
Deno.test("review acknowledged destination missing later blocks unlike", async () => {
  const f = fixture();
  f.state.items[0].state = "confirmed";
  await f.run();
  deepStrictEqual(f.events, ["attention"]);
});
Deno.test("review preexisting membership bypasses append", async () => {
  const f = fixture();
  f.state.memberships[0].status = "present";
  await f.run();
  deepStrictEqual(f.events, ["preexisting"]);
});
Deno.test("review restores liked membership using durable intent and later verification", async () => {
  const f = fixture();
  f.state.operation!.phase = "restore_pending";
  f.state.operation!.status = "undoing";
  await f.run();
  deepStrictEqual(f.events, ["contains", "restore_intent", "restored"]);
});
Deno.test("review unlike pending requires an item read from its final round before unliking", async () => {
  const f = fixture();
  f.state.operation!.phase = "unlike_pending";
  f.state.items[0].state = "confirmed";
  f.state.memberships[0].status = "present";
  f.state.memberships[0].snapshot_id = "externally-removed-version";
  await f.run();
  deepStrictEqual(f.events, ["contains", "scan"]);
});
Deno.test("review unlike pending only sends after every destination is confirmed in its final round", async () => {
  const f = fixture();
  f.state.operation!.verification_started_at = new Date(0).toISOString();
  f.state.operation!.phase = "unlike_pending";
  f.state.items[0].state = "confirmed";
  f.state.memberships[0].status = "present";
  await f.run();
  deepStrictEqual(f.events, [
    "contains",
    "unlike_intent",
    "unlike",
    "unlike_check",
  ]);
});

function reversingFixture() {
  const f = fixture();
  f.state.operation!.phase = "reversing";
  f.state.operation!.status = "undoing";
  f.state.items[0].state = "confirmed";
  f.state.items[0].snapshot_id = "before";
  f.state.memberships[0].status = "present";
  f.state.memberships[0].occurrences = 1;
  return f;
}
Deno.test("Undo restores like before any playlist reversal and verifies it later", async () => {
  const f = reversingFixture();
  f.state.operation!.phase = "restore_pending";
  f.setLiked(false);
  await f.run();
  deepStrictEqual(f.events, [
    "contains",
    "restore_intent",
    "restore",
    "restore_check",
  ]);
  f.events.length = 0;
  f.setLiked(true);
  f.state.operation!.phase = "restore_check";
  await f.run();
  deepStrictEqual(f.events, ["contains", "restored"]);
});
Deno.test("Undo targets the persisted append ACK despite an unchanged older GET snapshot", async () => {
  const f = reversingFixture();
  f.state.items[0].snapshot_id = "append-ack";
  await f.run();
  deepStrictEqual(f.events, ["reverse_intent", "reverse", "reverse_check"]);
  deepStrictEqual(f.reversals, [["operation", playlist, uri, "append-ack"]]);
});
Deno.test("Undo preserves preexisting, unconfirmed, unstable and duplicate memberships", async () => {
  for (
    const scenario of [
      "preexisting",
      "unconfirmed",
      "changed",
      "duplicate",
      "ownerChanged",
      "unconfigured",
      "missingAck",
      "unavailable",
    ]
  ) {
    const f = reversingFixture();
    if (["preexisting", "unconfirmed"].includes(scenario)) {
      f.state.items[0].state = scenario;
    }
    if (scenario === "changed") f.state.memberships[0].snapshot_id = "changed";
    if (scenario === "duplicate") f.state.memberships[0].occurrences = 2;
    if (scenario === "ownerChanged") f.setOwner("another-profile");
    if (scenario === "unconfigured") f.state.destinations = [];
    if (scenario === "missingAck") f.state.items[0].snapshot_id = null;
    if (scenario === "unavailable") {
      f.state.memberships[0].status = "unavailable";
    }
    await f.run();
    deepStrictEqual(f.events, [
      scenario === "preexisting" ? "undone" : "reverse_unavailable",
    ]);
  }
});
Deno.test("Undo may target its historical ACK after stable observed unrelated changes", async () => {
  const f = reversingFixture();
  f.state.items[0].snapshot_id = "append-ack";
  f.state.memberships[0].snapshot_id = "new-read-version";
  f.setSnapshot("new-read-version");
  await f.run();
  deepStrictEqual(f.reversals, [["operation", playlist, uri, "append-ack"]]);
});
Deno.test("Undo stale intent never dispatches and stale observations are refreshed", async () => {
  const denied = reversingFixture();
  denied.deny();
  strictEqual(await denied.run(), null);
  deepStrictEqual(denied.events, ["reverse_intent"]);
  const stale = reversingFixture();
  stale.state.memberships[0].checked_at = new Date(0).toISOString();
  await stale.run();
  deepStrictEqual(stale.events, ["scan"]);
});
Deno.test("Undo ambiguous and reclaimed removals reconcile without replay", async () => {
  const f = reversingFixture();
  f.failReverse(new SpotifyError("network", null, null, true));
  await f.run();
  deepStrictEqual(f.events, ["reverse_intent", "reverse", "reverse_check"]);
  f.events.length = 0;
  f.state.items[0].state = "reverse_sending";
  await f.run();
  deepStrictEqual(f.events, ["reverse_check"]);
  f.events.length = 0;
  f.state.items[0].state = "reverse_check";
  await f.run();
  deepStrictEqual(f.events, ["reverse_unavailable"]);
});
Deno.test("Undo removal acknowledgement alone cannot complete; read absence is required", async () => {
  const f = reversingFixture();
  f.state.items[0].state = "reverse_check";
  f.state.memberships = [];
  await f.run();
  deepStrictEqual(f.events, ["scan"]);
  f.events.length = 0;
  f.state.memberships = [{
    playlist_id: playlist,
    status: "absent",
    snapshot_id: "removed",
    next_offset: 0,
    observed: 0,
    occurrences: 0,
    total: 0,
    checked_at: new Date(100000).toISOString(),
  }];
  await f.run();
  deepStrictEqual(f.events, ["reversed"]);
  f.events.length = 0;
  f.state.items[0].state = "reversed";
  await f.run();
  deepStrictEqual(f.events, ["undone"]);
});

Deno.test("review reads changed items even when a ready cache and GET snapshot are unchanged", async () => {
  for (const nowPresent of [true, false]) {
    const f = fixture();
    f.state.items[0].state = "confirmed";
    f.state.memberships = [];
    f.state.cache = [{
      playlist_id: playlist,
      status: "ready",
      snapshot_id: "before",
      next_offset: 0,
      observed: nowPresent ? 0 : 1,
      occurrences: nowPresent ? 0 : 1,
      total: nowPresent ? 0 : 1,
      checked_at: new Date(0).toISOString(),
    }];
    f.setItems(nowPresent ? [uri] : []);
    f.setMetadataTotal(nowPresent ? 0 : 1);
    await f.run();
    strictEqual(f.itemReads(), 1);
    strictEqual(f.observations[0].status, nowPresent ? "present" : "absent");
    strictEqual(f.observations[0].occurrences, nowPresent ? 1 : 0);
    strictEqual(f.observations[0].reset, true);
  }
});
Deno.test("a final round with twenty slow destinations keeps its early observations valid", async () => {
  const f = fixture();
  f.state.operation!.phase = "unlike_pending";
  f.state.operation!.verification_started_at = new Date(0).toISOString();
  f.state.items = Array.from(
    { length: 20 },
    (_, n) => ({
      playlist_id: String(n).padStart(22, "p"),
      state: "preexisting",
      snapshot_id: null,
    }),
  );
  f.state.destinations = f.state.items.map((i) => i.playlist_id);
  f.state.memberships = f.state.items.map((i, n) => ({
    playlist_id: i.playlist_id,
    status: "present",
    snapshot_id: "unchanged",
    next_offset: 0,
    observed: 1,
    occurrences: 1,
    total: 1,
    checked_at: new Date(n * 1000).toISOString(),
  }));
  await f.run();
  deepStrictEqual(f.events, [
    "contains",
    "unlike_intent",
    "unlike",
    "unlike_check",
  ]);
  strictEqual(f.itemReads(), 0);
});
Deno.test("prior-round presence cannot authorize unlike even when already unliked remotely", async () => {
  const f = fixture();
  f.setLiked(false);
  f.state.operation!.phase = "unlike_pending";
  f.state.operation!.verification_started_at = new Date(150000).toISOString();
  f.state.items[0].state = "preexisting";
  f.state.memberships[0].status = "present";
  await f.run();
  deepStrictEqual(f.events, ["contains", "scan"]);
});
Deno.test("uncertain unlike retries begin a new round before any second dispatch", async () => {
  const f = fixture();
  f.state.operation!.phase = "unlike_check";
  await f.run();
  deepStrictEqual(f.events, ["contains", "unlike_retry"]);
});

Deno.test("review invalidates a partial walk when item-page totals change despite unchanged metadata", async () => {
  const f = fixture();
  f.state.items[0].state = "confirmed";
  f.state.memberships = [];
  f.state.cache = [{
    playlist_id: playlist,
    status: "checking",
    snapshot_id: "before",
    next_offset: 50,
    observed: 50,
    occurrences: 0,
    total: 100,
    checked_at: null,
  }];
  f.setItems([uri]);
  f.setPageTotal(51);
  f.setMetadataTotal(100);
  await f.run();
  strictEqual(f.observations[0].status, "checking");
  strictEqual(f.observations[0].offset, 0);
  strictEqual(f.observations[0].observed, 0);
  strictEqual(f.observations[0].reset, true);
});
