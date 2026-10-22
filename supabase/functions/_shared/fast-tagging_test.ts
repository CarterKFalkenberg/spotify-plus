import {
  ContractError,
  parseLibraryFacets,
  parseLibraryFilter,
  parseLibrarySearch,
  parseQueueSnapshot,
  parseQueueTracks,
  parseTagAction,
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
      album: "album:" + "a".repeat(64),
      decade: "unknown",
      latestSyncOnly: true,
    }).album === "album:" + "a".repeat(64),
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
Deno.test("album response identities round-trip into filter actions without broadening unavailable albums", () => {
  const unavailable = "album:" +
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const groups = [
    { value: unavailable, name: "Album unavailable" },
    { value: "album:" + "a".repeat(64), name: "🎷".repeat(250) },
  ];
  for (const group of groups) {
    const selection = {
      kind: "filter",
      filter: { ...filter, album: group.value },
      expectedRevision: rev,
    };
    const action = parseTagAction({ selection, action: "add", tagId: id });
    check(action.selection.kind === "filter");
    check(action.selection.filter.album === group.value);
    check(parseLibraryFilter({ ...filter, album: group.value }).album !== null);
  }
  check(parseLibraryFilter({ ...filter, album: null }).album === null);
  check(!Object.hasOwn(parseLibraryFilter(filter), "album"));
  for (
    const album of [
      undefined,
      "",
      " \t ",
      "Synthetic Album",
      "🎷".repeat(250),
      "album:" + "a".repeat(63),
      "album:" + "A".repeat(64),
      "album:" + "a".repeat(65),
    ]
  ) rejects(() => parseLibraryFilter({ ...filter, album }));
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

Deno.test("queue capture validates ordering/selection and hydration is a bounded key request", () => {
  const filter = {
    membership: "active",
    search: "",
    untagged: true,
    newOnly: false,
    artistId: null,
  };
  const request = {
    filter,
    sort: "random",
    seed: id,
    selection: {
      kind: "filter",
      filter,
      expectedRevision: { library: "1", annotations: "2" },
    },
  };
  check(parseQueueSnapshot(request).selection?.kind === "filter");
  rejects(() => parseQueueSnapshot({ ...request, seed: null }));
  rejects(() => parseQueueSnapshot({ ...request, cursor: "x" }));
  rejects(() =>
    parseQueueSnapshot({ ...request, selection: { kind: "filter", filter } })
  );
  const keys = Array.from(
    { length: 100 },
    (_, n) => n.toString(16).padStart(64, "0"),
  );
  check(parseQueueTracks({ trackKeys: keys }).trackKeys.length === 100);
  for (
    const trackKeys of [[], [...keys, "f".repeat(64)], [keys[0], keys[0]], [
      "invalid",
    ]]
  ) {
    rejects(() => parseQueueTracks({ trackKeys }));
  }
});
