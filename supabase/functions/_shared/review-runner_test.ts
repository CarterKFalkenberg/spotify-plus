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
  const db = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      if (_name === "app_review_worker") return Promise.resolve(state);
      events.push(String(args.p_event ?? "scan"));
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
        snapshotId: "before",
        total: 0,
        id: playlist,
        name: "Synthetic playlist",
        description: null,
        public: false,
        collaborative: false,
      }),
    getPlaylistItemsPage: () =>
      Promise.resolve({
        items: [],
        total: 0,
        nextOffset: null,
        offset: 0,
        limit: 50,
      }),
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
      strictEqual(snapshot, "before");
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
Deno.test("review unlike pending rechecks changed destination snapshot before unliking", async () => {
  const f = fixture();
  f.state.operation!.phase = "unlike_pending";
  f.state.items[0].state = "confirmed";
  f.state.memberships[0].status = "present";
  f.state.memberships[0].snapshot_id = "externally-removed-version";
  await f.run();
  deepStrictEqual(f.events, ["contains", "scan"]);
});
Deno.test("review unlike pending only sends after every fresh destination version matches", async () => {
  const f = fixture();
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
Deno.test("Undo sends only acknowledged one-copy same-version reversal after durable intent", async () => {
  const f = reversingFixture();
  await f.run();
  deepStrictEqual(f.events, ["reverse_intent", "reverse", "reverse_check"]);
});
Deno.test("Undo preserves preexisting, unconfirmed, changed and duplicate memberships", async () => {
  for (
    const scenario of [
      "preexisting",
      "unconfirmed",
      "changed",
      "duplicate",
      "liveChanged",
    ]
  ) {
    const f = reversingFixture();
    if (["preexisting", "unconfirmed"].includes(scenario)) {
      f.state.items[0].state = scenario;
    }
    if (scenario === "changed") f.state.memberships[0].snapshot_id = "changed";
    if (scenario === "duplicate") f.state.memberships[0].occurrences = 2;
    if (scenario === "ownerChanged") f.setOwner("another-profile");
    if (scenario === "liveChanged") {
      f.state.items[0].snapshot_id = "different-ack";
      f.state.memberships[0].snapshot_id = "different-ack";
    }
    await f.run();
    deepStrictEqual(f.events, [
      scenario === "preexisting" ? "undone" : "reverse_unavailable",
    ]);
  }
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
