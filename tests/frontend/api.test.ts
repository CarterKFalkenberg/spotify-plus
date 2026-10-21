import { afterEach, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  lookupTags,
  rejectsIntent,
  tagAction,
} from "../../app/src/api";
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const tag = (id: string) => ({
  id,
  name: "Synthetic",
  activeTrackCount: 0,
  lastUsedAt: null,
});
afterEach(() => vi.unstubAllGlobals());
it("looks up every assigned ID in bounded ordered batches beyond 100", async () => {
  const ids = Array.from({ length: 401 }, (_, i) => id(i + 1));
  const calls: string[][] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const batch = JSON.parse(init.body as string).tagIds;
    calls.push(batch);
    return Response.json({
      tags: batch.map(tag),
      revision: { library: "1", annotations: "2" },
    });
  });
  expect((await lookupTags([...ids, ids[0]!])).map((tag) => tag.id)).toEqual(
    ids,
  );
  expect(calls.map((batch) => batch.length)).toEqual([200, 200, 1]);
});
it.each(["missing", "reordered", "duplicate", "invalid revision"])(
  "rejects %s lookup responses rather than guessing names",
  async (kind) => {
    const ids = [id(1), id(2)];
    vi.stubGlobal("fetch", async () =>
      Response.json({
        tags: (kind === "missing"
          ? [ids[0]!]
          : kind === "reordered"
            ? [...ids].reverse()
            : kind === "duplicate"
              ? [ids[0]!, ids[0]!]
              : ids
        ).map(tag),
        revision: {
          library: kind === "invalid revision" ? "-1" : "1",
          annotations: "2",
        },
      }),
    );
    await expect(lookupTags(ids)).rejects.toThrow();
  },
);
it("requires the atomic action's resolved tag projection", () => {
  const response = {
    actionId: id(1),
    selectedCount: 3,
    changedCount: 2,
    revision: { library: "1", annotations: "2" },
    tag: tag(id(2)),
  };
  expect(tagAction(response).tag.id).toBe(id(2));
  expect(() => tagAction({ ...response, tag: undefined })).toThrow();
});
it("auth and origin rejection never resolve an accepted-but-lost intent", () => {
  for (const status of [401, 403, 503])
    expect(rejectsIntent(new ApiError("unauthorized", status))).toBe(false);
  expect(rejectsIntent(new ApiError("invalid_input", 400))).toBe(false);
  expect(rejectsIntent(new ApiError("stale_revision", 409))).toBe(true);
  expect(rejectsIntent(new ApiError("request_conflict", 409))).toBe(false);
});

it.each([
  "playback_target_unavailable",
  "playback_unconfirmed",
  "playback_service_error",
  "playback_control_unavailable",
])("API preserves only the fixed playback recovery code %s", async (code) => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      { error: code, detail: "synthetic-sensitive-provider-detail" },
      { status: 503 },
    ),
  );
  await expect(api("/playback/start", () => null, {})).rejects.toMatchObject({
    code,
    status: 503,
  });
});
