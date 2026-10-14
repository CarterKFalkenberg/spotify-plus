import { afterEach, expect, it, vi } from "vitest";
import {
  expiryDays,
  resolvePlaylistLabels,
} from "../../app/src/playlist-labels";
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
afterEach(() => vi.unstubAllGlobals());
function lookup(missing: Set<string>) {
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    const ids: string[] = JSON.parse(String(init.body)).tagIds;
    return ids.some((id) => missing.has(id))
      ? Response.json({ error: "unknown_tag" }, { status: 409 })
      : Response.json({
          revision: { library: "1", annotations: "1" },
          tags: ids.map((id) => ({
            id,
            name: "Synthetic tag",
            activeTrackCount: 0,
            lastUsedAt: null,
          })),
        });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("isolates one deleted leaf without losing labels from its batch or unrelated queries", async () => {
  const fetch = lookup(new Set([id(3)]));
  const result = await resolvePlaylistLabels(
    Array.from({ length: 201 }, (_, n) => id(n + 1)),
    new AbortController().signal,
  );
  expect(result.tags).toHaveLength(200);
  expect(result.tags.some((tag) => tag.id === id(201))).toBe(true);
  expect(result.missing).toEqual([id(3)]);
  expect(result.unavailable).toEqual([]);
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(18);
});
it("caps isolation traffic for pathological missing queries and marks only unresolved leaves unavailable", async () => {
  const ids = Array.from({ length: 200 }, (_, n) => id(n + 1));
  const fetch = lookup(new Set(ids));
  const result = await resolvePlaylistLabels(ids, new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(33);
  expect(new Set([...result.missing, ...result.unavailable])).toEqual(
    new Set(ids),
  );
  expect(result.tags).toEqual([]);
  expect(result.unavailable.length).toBeGreaterThan(0);
});
it("does not misclassify network/auth failures as a deleted tag or fan them out", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ error: "unauthorized" }, { status: 401 }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(
    resolvePlaylistLabels([id(1), id(2)], new AbortController().signal),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("counts New York calendar dates across DST, month boundaries, expiry day and overdue dates", () => {
  expect(expiryDays("2026-03-09", new Date("2026-03-08T05:30:00Z"))).toBe(1);
  expect(expiryDays("2026-11-02", new Date("2026-11-01T04:30:00Z"))).toBe(1);
  expect(expiryDays("2026-11-01", new Date("2026-11-01T23:00:00Z"))).toBe(0);
  expect(expiryDays("2026-11-01", new Date("2026-11-02T05:00:00Z"))).toBe(-1);
  expect(expiryDays("2027-01-01", new Date("2026-12-31T05:00:00Z"))).toBe(1);
});
