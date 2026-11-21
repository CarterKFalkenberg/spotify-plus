import { afterEach, expect, it, vi } from "vitest";
import {
  review,
  reviewCommand,
  reviewDestinations,
  reviewWorking,
} from "../../app/src/review-api";
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const destination = {
  id: "a".repeat(22),
  name: "Synthetic destination",
  artworkUrl: null,
  spotifyUrl: `https://open.spotify.com/playlist/${"a".repeat(22)}`,
  configured: true,
  available: true,
  membership: "absent",
  errorCode: null,
};
const state = () => ({
  sessionId: uuid,
  revision: "1",
  remaining: 3,
  skipped: 1,
  current: null,
  destinations: [destination],
  draft: null,
  operation: null,
  undo: null,
  syncStatus: "ready",
  discoveryStatus: "ready",
});
afterEach(() => vi.unstubAllGlobals());
it("validates exact-track review status independently from source membership", () => {
  expect(review(state()).remaining).toBe(3);
  expect(reviewWorking(review(state()))).toBe(false);
  for (const membership of ["unknown", "checking"])
    expect(
      reviewWorking(
        review({ ...state(), destinations: [{ ...destination, membership }] }),
      ),
    ).toBe(true);
  expect(reviewWorking(review({ ...state(), syncStatus: "pending" }))).toBe(
    true,
  );
});
it.each([
  { ...state(), revision: "-1" },
  { ...state(), sessionId: "other" },
  { ...state(), remaining: -1 },
  { ...state(), destinations: [destination, destination] },
  { ...state(), destinations: [{ ...destination, membership: "maybe" }] },
  {
    ...state(),
    destinations: [{ ...destination, spotifyUrl: "javascript:alert(1)" }],
  },
  {
    ...state(),
    destinations: [{ ...destination, artworkUrl: "javascript:alert(1)" }],
  },
  {
    ...state(),
    draft: {
      trackKey: "a".repeat(64),
      revision: "1",
      destinationIds: [destination.id, destination.id],
    },
  },
  {
    ...state(),
    operation: {
      id: uuid,
      trackKey: "a".repeat(64),
      kind: "done",
      status: "completed",
      errorCode: null,
      completedDestinations: 2,
      totalDestinations: 1,
      reversalIncomplete: false,
    },
  },
])("rejects invalid server review contracts", (value) =>
  expect(() => review(value)).toThrow(),
);
it("parses configured and unavailable destination identities without silently dropping them", () => {
  const parsed = reviewDestinations({
    revision: "2",
    items: [{ ...destination, available: false, membership: "unavailable" }],
    discoveryStatus: "unavailable",
  });
  expect(parsed.items[0]!.configured).toBe(true);
  expect(parsed.items[0]!.available).toBe(false);
});
it("draft writes use keepalive and durable commands preserve exact retry identity", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
    calls.push(init);
    return Response.json(state());
  });
  const input = { revision: "2", trackKey: "a".repeat(64), requestId: uuid };
  await reviewCommand("done", input);
  await reviewCommand("done", input);
  await reviewCommand("draft", {
    revision: "2",
    trackKey: "a".repeat(64),
    destinationIds: [destination.id],
  });
  expect(calls[0]!.body).toBe(calls[1]!.body);
  expect(
    calls.every(
      (c) =>
        c.keepalive && c.credentials === "same-origin" && c.method === "POST",
    ),
  ).toBe(true);
});
it("preserves conflict codes for explicit multi-device recovery", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ error: "stale_revision" }, { status: 409 }),
  );
  await expect(
    reviewCommand("session", { revision: "2" }),
  ).rejects.toMatchObject({ code: "stale_revision", status: 409 });
});
it("requires an explicit boolean from the server before returning to review", () => {
  const operation = {
    id: uuid,
    trackKey: "a".repeat(64),
    kind: "done",
    status: "needs_attention",
    errorCode: "destination_unavailable",
    completedDestinations: 1,
    totalDestinations: 2,
    reversalIncomplete: false,
  };
  expect(review({ ...state(), operation }).operation!.canCancel).toBe(false);
  expect(
    review({ ...state(), operation: { ...operation, canCancel: true } })
      .operation!.canCancel,
  ).toBe(true);
  expect(() =>
    review({ ...state(), operation: { ...operation, canCancel: "true" } }),
  ).toThrow();
});
