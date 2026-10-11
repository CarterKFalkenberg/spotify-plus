import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectTagOptions, loadBulkTags } from "../../app/src/selection-tags";
const revision = { library: "1", annotations: "1" };
const filter = {
  membership: "active" as const,
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
const selection = {
  kind: "filter" as const,
  filter,
  expectedRevision: revision,
};
const tag = (n: number) => ({
  id: `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  name: `Synthetic tag ${n}`,
  activeTrackCount: 1000 - n,
  lastUsedAt: null,
});
afterEach(() => vi.unstubAllGlobals());
describe("bulk selection vocabulary inspection", () => {
  it("pages beyond the top100 and searches rare choices using exact selection counts and its frozen revision", async () => {
    const calls: { path: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ path, body });
        if (path === "/api/tags/vocabulary") {
          const third = body.cursor === "secondpagecursor",
            searched = body.search === "rare";
          const start = body.cursor ? 51 : 1;
          const tags =
            third || searched
              ? [tag(101)]
              : Array.from({ length: 50 }, (_, i) => tag(start + i));
          return Response.json({
            revision,
            tags,
            hasMore: !third && !searched,
            nextCursor:
              third || searched
                ? null
                : body.cursor
                  ? "secondpagecursor"
                  : "firstpagecursor1",
          });
        }
        return Response.json({
          revision,
          selectedCount: 3,
          tags: body.tagIds.map((id: string) => ({
            tag: tag(Number(id.slice(0, 8))),
            assignedCount: id === tag(101).id ? 1 : 0,
            state: id === tag(101).id ? "some" : "none",
          })),
        });
      }),
    );
    const signal = new AbortController().signal;
    const first = await loadBulkTags(
      "",
      null,
      selection,
      { library: "2", annotations: "2" },
      signal,
    );
    const second = await loadBulkTags(
      "",
      first.nextCursor,
      selection,
      { library: "2", annotations: "2" },
      signal,
    );
    const rare = await loadBulkTags(
      "",
      second.nextCursor,
      selection,
      { library: "2", annotations: "2" },
      signal,
    );
    expect(rare.tags).toEqual([
      { tag: tag(101), assignedCount: 1, state: "some" },
    ]);
    expect(rare.selectedCount).toBe(3);
    const searched = await loadBulkTags(
      "rare",
      null,
      selection,
      { library: "2", annotations: "2" },
      signal,
    );
    expect(searched.tags[0]?.state).toBe("some");
    const inspections = calls.filter((c) => c.path === "/api/tags/selection");
    expect(inspections.map((c) => c.body.tagIds.length)).toEqual([
      50, 50, 1, 1,
    ]);
    for (const call of inspections) {
      expect(call.body.selection).toEqual(selection);
      expect(call.body.expectedRevision).toEqual(revision);
    }
  });
  it("does not publish an obsolete inspection even when a transport mock ignores abort", async () => {
    const deferred = { resolve: null as ((r: Response) => void) | null };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            deferred.resolve = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const pending = inspectTagOptions(
      [tag(101)],
      selection,
      revision,
      controller.signal,
    );
    controller.abort();
    deferred.resolve?.(
      Response.json({
        revision,
        selectedCount: 2,
        tags: [{ tag: tag(101), assignedCount: 2, state: "all" }],
      }),
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects stale revisions and mismatched displayed tag identities instead of rendering misleading states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          revision: { library: "2", annotations: "1" },
          selectedCount: 2,
          tags: [{ tag: tag(101), assignedCount: 2, state: "all" }],
        }),
      ),
    );
    await expect(
      inspectTagOptions(
        [tag(101)],
        selection,
        revision,
        new AbortController().signal,
      ),
    ).rejects.toThrow("invalid_response");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          revision,
          selectedCount: 2,
          tags: [{ tag: tag(102), assignedCount: 2, state: "all" }],
        }),
      ),
    );
    await expect(
      inspectTagOptions(
        [tag(101)],
        selection,
        revision,
        new AbortController().signal,
      ),
    ).rejects.toThrow("invalid_response");
  });
});

it("allows a first-run empty vocabulary without sending the forbidden empty tag-ID inspection", async () => {
  const fetch = vi.fn(async (_path: string) =>
    Response.json({ revision, tags: [], hasMore: false, nextCursor: null }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await loadBulkTags(
    "",
    null,
    selection,
    revision,
    new AbortController().signal,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/tags/vocabulary");
  expect(result.tags).toEqual([]);
  expect(result.selectedCount).toBeNull();
});
