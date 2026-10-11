import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadFacetOptions } from "../../app/src/Facets";
import { ManagementNotice } from "../../app/src/ManagementNotice";
const filter = {
  membership: "active" as const,
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
afterEach(() => vi.unstubAllGlobals());
it("a library refresh discards a previous facet cursor and reads newly introduced artists/counts", async () => {
  const calls: any[] = [];
  let changed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({
        revision: { library: changed ? "2" : "1", annotations: "1" },
        facet: "artist",
        options: [
          {
            value: changed ? "newartist" : "oldartist",
            name: changed
              ? "Synthetic new artist"
              : "Synthetic original artist",
            trackCount: changed ? 5 : 1,
          },
        ],
        totalOptions: 1,
        nextCursor: changed ? null : "abcdefghijklmnop",
      });
    }),
  );
  const first = await loadFacetOptions(
    filter,
    "artist",
    null,
    0,
    0,
    new AbortController().signal,
  );
  changed = true;
  const second = await loadFacetOptions(
    filter,
    "artist",
    { context: JSON.stringify([filter, 0, 0]), cursor: first.nextCursor! },
    1,
    0,
    new AbortController().signal,
  );
  expect(calls[1].cursor).toBeNull();
  expect(second.options).toEqual([
    { value: "newartist", name: "Synthetic new artist", trackCount: 5 },
  ]);
});
it("the active management notice exposes failed-preview and same-target errors with draft-preserving recovery", () => {
  for (const error of [
    "This request could not be confirmed. Check your connection and try again.",
    "Choose a different destination tag.",
  ]) {
    const html = renderToStaticMarkup(
      createElement(ManagementNotice, {
        error,
        busy: false,
        onRefresh: () => {},
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(error);
    expect(html).toContain("Your draft is kept. Retry the preview");
    expect(html).toContain("Refresh tag data");
  }
  expect(
    renderToStaticMarkup(
      createElement(ManagementNotice, {
        error: "",
        busy: false,
        onRefresh: () => {},
      }),
    ),
  ).toBe("");
});
