import {
  ContractError,
  parseLibraryFacets,
  parseLibraryFilter,
  parseLibrarySearch,
  parseTagManage,
  parseTagSelection,
  parseTagVocabulary,
} from "./contracts.ts";
import { libraryApi } from "../api/library.ts";
function check(value: unknown): asserts value {
  if (!value) throw new Error("assertion");
}
function rejects(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    check(e instanceof ContractError);
    return;
  }
  throw new Error("accepted invalid");
}
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rev = { library: "0", annotations: "0" };
const filter = {
  membership: "active",
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
Deno.test("fast filters preserve unknown decade and bind seeded random without widening legacy requests", () => {
  check(
    parseLibraryFilter({
      ...filter,
      album: "  Synthetic   Album ",
      decade: "unknown",
      latestSyncOnly: true,
    }).album === "Synthetic Album",
  );
  for (
    const change of [
      { decade: 1991 },
      { decade: undefined },
      { latestSyncOnly: undefined },
      { latestSyncOnly: 1 },
      { album: 1 },
      { membership: "removed", latestSyncOnly: true },
    ]
  ) rejects(() => parseLibraryFilter({ ...filter, ...change }));
  check(
    parseLibrarySearch({
      filter,
      groupBy: "decade",
      cursor: null,
      limit: 10,
      sort: "random",
      seed: id,
    }).seed === id,
  );
  for (
    const change of [{ sort: "random" }, { sort: "newest", seed: id }, {
      sort: "random",
      seed: "untrusted",
    }]
  ) {
    rejects(() =>
      parseLibrarySearch({
        filter,
        groupBy: null,
        cursor: null,
        limit: 10,
        ...change,
      })
    );
  }
  check(
    parseLibraryFacets({ filter, facet: "album", cursor: null, limit: 10 })
      .facet === "album",
  );
});
Deno.test("vocabulary intents require normalized collision-safe IDs, exact delete impact and revisions", () => {
  const rename = parseTagManage({
    action: "rename",
    tagId: id,
    name: "  Café  🎷 / 2 ",
    expectedRevision: rev,
  });
  check(rename.action === "rename" && rename.name === "Café 🎷 / 2");
  parseTagManage({
    action: "merge",
    sourceIds: [other],
    targetId: id,
    expectedRevision: rev,
  }, true);
  rejects(() =>
    parseTagManage({
      action: "merge",
      sourceIds: [id],
      targetId: id,
      expectedRevision: rev,
    }, true)
  );
  rejects(() =>
    parseTagManage({ action: "delete", tagId: id, expectedRevision: rev }, true)
  );
  rejects(() =>
    parseTagManage({
      action: "delete",
      tagId: id,
      expectedRevision: rev,
      confirmedAssignmentCount: -1,
    }, true)
  );
  parseTagManage({
    action: "delete",
    tagId: id,
    expectedRevision: rev,
    confirmedAssignmentCount: 0,
  }, true);
  rejects(() =>
    parseTagManage({
      action: "rename",
      tagId: id,
      name: "Synthetic",
      expectedRevision: rev,
      previousName: "client snapshot",
    }, true)
  );
  parseTagVocabulary({ search: "", sort: "unused", cursor: null, limit: 100 });
  rejects(() =>
    parseTagVocabulary({ search: "", sort: "unused", cursor: null, limit: 101 })
  );
  parseTagSelection({
    selection: { kind: "tracks", trackKeys: ["1".repeat(64)] },
    tagIds: [id],
    expectedRevision: rev,
  });
  rejects(() =>
    parseTagSelection({
      selection: { kind: "tracks", trackKeys: ["1".repeat(64)] },
      tagIds: [id],
    })
  );
});
Deno.test("all fast routes send only parsed authenticated RPC inputs and never call Spotify", async () => {
  const requests: [string, unknown, string][] = [
    ["/api/library/facets", {
      filter,
      facet: "artist",
      cursor: null,
      limit: 20,
    }, "app_library_facets"],
    ["/api/tags/vocabulary", {
      search: "",
      sort: "mostUsed",
      cursor: null,
      limit: 9,
    }, "app_tags_vocabulary"],
    ["/api/tags/selection", {
      selection: { kind: "tracks", trackKeys: ["1".repeat(64)] },
      tagIds: [id],
      expectedRevision: rev,
    }, "app_tags_selection"],
    ["/api/tags/manage-preview", {
      action: "merge",
      sourceIds: [other],
      targetId: id,
      expectedRevision: rev,
    }, "app_tags_manage_preview"],
    ["/api/tags/manage", {
      action: "delete",
      tagId: id,
      expectedRevision: rev,
      confirmedAssignmentCount: 0,
    }, "app_tags_manage"],
  ];
  for (const [path, body, rpc] of requests) {
    let called = false;
    const db = {
      rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
        check(name === rpc && args?.p_epoch === 7);
        check(
          (path === "/api/tags/manage") ===
            (args?.p_session_hash === "synthetic-session"),
        );
        called = true;
        return Promise.resolve({ revision: rev } as T);
      },
    };
    const response = await libraryApi(
      new Request("https://synthetic.test" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      path,
      "synthetic-session",
      7,
      db,
    );
    check(called && response?.status === 200);
  }
});
