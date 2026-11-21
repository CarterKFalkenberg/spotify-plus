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
  const db = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      if (_name === "app_review_worker") return Promise.resolve(state);
      events.push(String(args.p_event ?? "scan"));
      return Promise.resolve(allowed);
    },
  } as Database;
  const client = {
    getPlaylist: () =>
      Promise.resolve({
        ownerId: "owner",
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
      return Promise.resolve([true]);
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
  deepStrictEqual(f.events, ["contains", "restore_intent", "undone"]);
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
