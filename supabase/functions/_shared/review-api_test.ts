import {
  deepStrictEqual,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import type { Database } from "./database.ts";
import { reviewApi, reviewInput } from "./review-api.ts";
Deno.test("review command parser requires explicit confirmed Discard and exact field shapes", () => {
  const base = {
    revision: "1",
    trackKey: "a".repeat(64),
    requestId: "11111111-1111-4111-8111-111111111111",
  };
  throws(() => reviewInput("discard", base));
  throws(() => reviewInput("discard", { ...base, confirmation: false }));
  throws(() => reviewInput("done", { ...base, confirmation: true }));
  throws(() =>
    reviewInput("done", {
      ...base,
      trackKey: "spotify:track:" + "a".repeat(22),
    })
  );
  throws(() => reviewInput("done", { ...base, revision: 1 }));
  deepStrictEqual(reviewInput("discard", { ...base, confirmation: true }), {
    ...base,
    confirmation: true,
  });
});
Deno.test("review destination drafts validate unique IDs and copy mutable client inputs", () => {
  const input = {
    revision: "0",
    trackKey: "a".repeat(64),
    destinationIds: ["p".repeat(22)],
  };
  const parsed = reviewInput("draft", input);
  input.destinationIds.push("q".repeat(22));
  strictEqual(parsed.destinationIds!.length, 1);
  throws(() =>
    reviewInput("draft", {
      ...input,
      destinationIds: ["p".repeat(22), "p".repeat(22)],
    })
  );
});
Deno.test("review routes send only validated commands to owner epoch RPCs", async () => {
  const calls: unknown[] = [];
  const db = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args });
      return Promise.resolve({ revision: "2" });
    },
  } as Database;
  const input = {
    revision: "1",
    trackKey: "a".repeat(64),
    requestId: "11111111-1111-4111-8111-111111111111",
  };
  const req = new Request("https://app.invalid/api/review/done", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  strictEqual((await reviewApi(req, "/api/review/done", 7, db))!.status, 202);
  deepStrictEqual(calls, [{
    name: "app_review_command",
    args: { p_epoch: 7, p_command: "done", p_input: input },
  }]);
  await rejects(() =>
    reviewApi(
      new Request("https://app.invalid/api/review?epoch=2"),
      "/api/review",
      7,
      db,
    )
  );
  strictEqual(calls.length, 1);
});
