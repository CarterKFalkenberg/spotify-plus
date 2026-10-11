import {
  compileQueryBuilder,
  CONTRACT_LIMITS,
  ContractError,
  DEFAULT_RETENTION,
  type LibraryFilter,
  type LibraryRevision,
  parseAcknowledge,
  parseCreatePlaylist,
  parseCreateTag,
  parseId,
  parseLibraryFilter,
  parseLibraryRevision,
  parseLibrarySearch,
  parseLibrarySync,
  parsePageRequest,
  parsePlaylistAction,
  parseQuery,
  parseQueryPreview,
  parseRetention,
  parseRevision,
  parseSelection,
  parseTagAction,
  parseTagLookup,
  parseTagSearch,
  parseTrackKey,
  parseUndoTagAction,
  queryMatchesTags,
  type QueryNode,
  type TrackAnnotationDTO,
  type TrackDTO,
} from "./contracts.ts";
import { assert, equal } from "./testing.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const F = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const key = "a".repeat(64);
const revision: LibraryRevision = { library: "12", annotations: "34" };
const filter: LibraryFilter = {
  membership: "active",
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
const tag = (tagId: string): QueryNode => ({ op: "tag", tagId });
const query = { version: 1 as const, root: tag(A) };
const selection = { kind: "tracks", trackKeys: [key] };
const search = { filter, cursor: null, limit: 50, groupBy: null };
const create = {
  requestId: A,
  query,
  previewRevision: revision,
  name: "Synthetic playlist",
  retention: "month",
};
const action = { requestId: A, expectedRevision: "12", action: "pin" };

function invalid(
  parse: (value: unknown) => unknown,
  value: unknown,
): ContractError {
  try {
    parse(value);
  } catch (error) {
    assert(
      error instanceof ContractError,
      "expected a bounded contract rejection",
    );
    return error;
  }
  throw new Error("expected invalid input");
}
function combinations(ids: string[]): Set<string>[] {
  return Array.from(
    { length: 2 ** ids.length },
    (_, mask) => new Set(ids.filter((_, bit) => (mask & (1 << bit)) !== 0)),
  );
}

Deno.test("All/Any/None compiles the six-tag truth table, including union negation", () => {
  const compiled = compileQueryBuilder({
    all: [A, B],
    any: [C, D],
    none: [E, F],
  });
  for (const tags of combinations([A, B, C, D, E, F])) {
    const expected = tags.has(A) && tags.has(B) &&
      (tags.has(C) || tags.has(D)) && !tags.has(E) && !tags.has(F);
    equal(queryMatchesTags(compiled, tags), expected);
  }
});
Deno.test("individual empty buckets are omitted; None alone matches the complement", () => {
  for (const tags of combinations([A, B])) {
    equal(
      queryMatchesTags(
        compileQueryBuilder({ all: [A], any: [], none: [] }),
        tags,
      ),
      tags.has(A),
    );
    equal(
      queryMatchesTags(
        compileQueryBuilder({ all: [], any: [A, B], none: [] }),
        tags,
      ),
      tags.has(A) || tags.has(B),
    );
    equal(
      queryMatchesTags(
        compileQueryBuilder({ all: [], any: [], none: [A, B] }),
        tags,
      ),
      !tags.has(A) && !tags.has(B),
    );
  }
  invalid(compileQueryBuilder, { all: [], any: [], none: [] });
});
Deno.test("recursive stored queries preserve nested negation and both De Morgan laws", () => {
  const nested = parseQuery({
    version: 1,
    root: {
      op: "not",
      child: {
        op: "or",
        children: [
          { op: "and", children: [tag(A), { op: "not", child: tag(B) }] },
          { op: "not", child: { op: "not", child: tag(C) } },
        ],
      },
    },
  });
  for (const tags of combinations([A, B, C])) {
    equal(
      queryMatchesTags(nested, tags),
      !((tags.has(A) && !tags.has(B)) || tags.has(C)),
    );
    for (const op of ["and", "or"] as const) {
      const left = parseQuery({
        version: 1,
        root: { op: "not", child: { op, children: [tag(A), tag(B)] } },
      });
      const right = parseQuery({
        version: 1,
        root: {
          op: op === "and" ? "or" : "and",
          children: [{ op: "not", child: tag(A) }, {
            op: "not",
            child: tag(B),
          }],
        },
      });
      equal(queryMatchesTags(left, tags), queryMatchesTags(right, tags));
    }
  }
});
Deno.test("builder duplicate tags are canonicalized without changing contradictions", () => {
  const compiled = compileQueryBuilder({
    all: [A, A.toUpperCase()],
    any: [],
    none: [A],
  });
  assert(compiled.root.op === "and");
  equal(compiled.root.children.length, 2);
  equal(queryMatchesTags(compiled, new Set([A])), false);
  equal(queryMatchesTags(compiled, new Set()), false);
});
Deno.test("query version, operators, arity and fields fail closed", () => {
  for (
    const value of [
      {},
      { root: tag(A) },
      { ...query, version: "1" },
      { ...query, version: 2 },
      { ...query, owner: A },
      ...[
        {},
        { op: "xor", children: [tag(A)] },
        { op: "tag", tagId: A, name: "Synthetic" },
        { op: "tag" },
        { op: "and", children: [] },
        { op: "or", children: [] },
        { op: "and", children: [null] },
        { op: "not", children: [tag(A)] },
        { op: "not", child: tag(A), children: [tag(B)] },
        { op: "and", children: [tag(A)], child: tag(B) },
      ].map((root) => ({ version: 1, root })),
    ]
  ) invalid(parseQuery, value);
});
Deno.test("queries accept exactly the bounded nesting and reject cycles without stack overflow", () => {
  let root: QueryNode = tag(A);
  for (let i = 1; i < CONTRACT_LIMITS.queryDepth; i++) {
    root = { op: "not", child: root };
  }
  parseQuery({ version: 1, root });
  invalid(parseQuery, { version: 1, root: { op: "not", child: root } });
  const cycle: Record<string, unknown> = { op: "not" };
  cycle.child = cycle;
  invalid(parseQuery, { version: 1, root: cycle });
});
Deno.test("query node and builder entry budgets are global, even for duplicate identities", () => {
  const children = Array.from(
    { length: CONTRACT_LIMITS.queryNodes - 1 },
    () => tag(A),
  );
  parseQuery({ version: 1, root: { op: "or", children } });
  invalid(parseQuery, {
    version: 1,
    root: { op: "or", children: [...children, tag(A)] },
  });
  invalid(parseQuery, {
    version: 1,
    root: {
      op: "and",
      children: [
        { op: "or", children: children.slice(0, 64) },
        { op: "or", children: children.slice(0, 64) },
      ],
    },
  });
  compileQueryBuilder({ all: Array(64).fill(A), any: [], none: [] });
  invalid(compileQueryBuilder, {
    all: Array(32).fill(A),
    any: Array(32).fill(B),
    none: [C],
  });
  invalid(compileQueryBuilder, { all: Array(65).fill(A), any: [], none: [] });
});
Deno.test("builder requires all three typed buckets and rejects unknown fields", () => {
  for (
    const value of [
      { all: [A] },
      { all: A, any: [], none: [] },
      { all: [null], any: [], none: [] },
      { all: [A], any: [], none: [], query: query },
    ]
  ) invalid(compileQueryBuilder, value);
});
Deno.test("identities accept canonical UUIDs and reject malformed, nil or nonstandard variants", () => {
  equal(parseId(A.toUpperCase()), A);
  for (
    const value of [
      null,
      1,
      "",
      "tag-name",
      "00000000-0000-0000-0000-000000000000",
      A.replace("4aaa", "0aaa"),
      A.replace("8aaa", "7aaa"),
      A + " ",
      A.slice(1),
    ]
  ) {
    invalid(parseId, value);
    invalid(parseQuery, { version: 1, root: tag(value as string) });
  }
});
Deno.test("query parsing owns a copy and does not authorize a syntactically valid tag", () => {
  const input = {
    version: 1,
    root: { op: "and", children: [{ op: "tag", tagId: A }] },
  };
  const parsed = parseQuery(input);
  input.root.children[0].tagId = B;
  equal(queryMatchesTags(parsed, new Set([A])), true);
  // There is intentionally no registry lookup here. Persistence must reject deleted A.
  equal(queryMatchesTags(parsed, new Set()), false);
});

Deno.test("all body parsers reject nonobjects, class instances, inherited fields and accessors", () => {
  const parsers = [
    parseQuery,
    compileQueryBuilder,
    parseLibraryFilter,
    parseLibraryRevision,
    parseSelection,
    parsePageRequest,
    parseLibrarySearch,
    parseLibrarySync,
    parseAcknowledge,
    parseTagSearch,
    parseTagLookup,
    parseCreateTag,
    parseTagAction,
    parseTagLookup,
    parseUndoTagAction,
    parseQueryPreview,
    parseCreatePlaylist,
    parsePlaylistAction,
  ];
  let reads = 0;
  const accessor = Object.defineProperty({}, "anything", {
    enumerable: true,
    get: () => {
      reads++;
      return A;
    },
  });
  const hidden = Object.defineProperty({}, "anything", { value: A });
  for (const parser of parsers) {
    for (
      const value of [
        null,
        undefined,
        [],
        true,
        1,
        "{}",
        new Date(),
        new Map(),
        new (class {})(),
        Object.create({ version: 1 }),
        accessor,
        hidden,
        { [Symbol("hidden")]: A },
      ]
    ) invalid(parser, value);
  }
  equal(reads, 0);
  equal(parseTagSearch(Object.create(null)), { search: "", limit: 20 });
});
Deno.test("dense ordinary arrays are required, without hidden fields or executable accessors", () => {
  let reads = 0;
  const accessor = Object.defineProperty([A], "0", {
    enumerable: true,
    get: () => {
      reads++;
      return A;
    },
  });
  const subclass = new (class extends Array<string> {})();
  subclass.push(A);
  for (
    const all of [
      Array(1),
      Object.assign([A], { extra: true }),
      Object.assign([A], { [Symbol("hidden")]: 1 }),
      subclass,
      accessor,
    ]
  ) {
    invalid(compileQueryBuilder, { all, any: [], none: [] });
  }
  equal(reads, 0);
});
Deno.test("track keys are opaque identities, independent of expirable metadata", () => {
  equal(parseTrackKey(key), key);
  for (
    const value of [
      null,
      A,
      "spotify:track:" + "a".repeat(22),
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
    ]
  ) invalid(parseTrackKey, value);
  const annotation: TrackAnnotationDTO = { trackKey: key, tagIds: [A] };
  // Type contract: retained annotations need no title, Spotify ID, URL or dates.
  const purged: TrackDTO = { ...annotation, metadata: null };
  equal(
    parseSelection({ kind: "tracks", trackKeys: [purged.trackKey] }),
    selection,
  );
  equal(purged.tagIds, [A]);
  // This demonstrates the wire shape; actual purge/re-like transactions belong to SQL tests.
});
Deno.test("revisions preserve bigint precision and reject coercions, overflow or unknown fields", () => {
  equal(parseRevision("9007199254740993"), "9007199254740993");
  equal(parseRevision("9223372036854775807"), "9223372036854775807");
  equal(parseLibraryRevision(revision), revision);
  for (
    const value of [
      0,
      -1,
      NaN,
      null,
      "",
      "01",
      "-1",
      "1.0",
      "1e3",
      "9223372036854775808",
      "10000000000000000000",
    ]
  ) invalid(parseRevision, value);
  for (
    const value of [{ library: "1" }, { ...revision, ownerEpoch: 1 }, {
      ...revision,
      annotations: 2,
    }]
  ) invalid(parseLibraryRevision, value);
});
Deno.test("explicit selection is nonempty, unique and bounded; filter selections require a revision", () => {
  equal(parseSelection(selection), selection);
  const keys = Array.from(
    { length: 200 },
    (_, index) => index.toString(16).padStart(64, "0"),
  );
  parseSelection({ kind: "tracks", trackKeys: keys });
  const filtered = { kind: "filter", filter, expectedRevision: revision };
  equal(parseSelection(filtered), filtered);
  for (
    const value of [
      { kind: "tracks", trackKeys: [] },
      { kind: "tracks", trackKeys: [key, key] },
      { kind: "tracks", trackKeys: [...keys, key] },
      { kind: "tracks", trackKeys: ["not-a-key"] },
      { ...selection, filter },
      { kind: "filter", filter },
      { ...filtered, trackKeys: [key] },
      { kind: "all" },
      { kind: "filter", filter, expectedRevision: "1" },
    ]
  ) invalid(parseSelection, value);
});
Deno.test("library filters keep membership explicit and reject malformed flags, artists and extra fields", () => {
  equal(
    parseLibraryFilter({ ...filter, search: "  Synthetic\n artist  " }).search,
    "Synthetic artist",
  );
  parseLibraryFilter({ ...filter, artistId: "a".repeat(22), untagged: true });
  parseLibraryFilter({ ...filter, membership: "removed" });
  for (
    const value of [
      {},
      { ...filter, membership: "all" },
      { ...filter, untagged: 1 },
      { ...filter, newOnly: "false" },
      { ...filter, membership: "removed", newOnly: true },
      { ...filter, artistId: "Synthetic artist" },
      { ...filter, artistId: "a".repeat(21) },
      { ...filter, search: "a".repeat(201) },
      { ...filter, album: 42 },
      { ...filter, search: undefined },
    ]
  ) invalid(parseLibraryFilter, value);
});
Deno.test("pagination accepts bounded opaque cursors and integer limits without coercion", () => {
  equal(parsePageRequest({ cursor: "a".repeat(16), limit: 1 }), {
    cursor: "a".repeat(16),
    limit: 1,
  });
  parsePageRequest({ cursor: "_-a1".repeat(128), limit: 100 });
  for (const value of [0, -1, 101, 1.5, "50", NaN, Infinity, null]) {
    invalid(parsePageRequest, { cursor: null, limit: value });
  }
  for (
    const value of [
      "",
      "a".repeat(15),
      "a".repeat(513),
      "https://example.test",
      "a".repeat(16) + ".",
      0,
      {},
      undefined,
    ]
  ) invalid(parsePageRequest, { cursor: value, limit: 50 });
  invalid(parsePageRequest, { cursor: null, limit: 50, offset: 0 });
});
Deno.test("library search, preview and playlist list paging share the same bounded page semantics", () => {
  equal(parseLibrarySearch(search), search);
  parseLibrarySearch({ ...search, groupBy: "artist" });
  equal(parseQueryPreview({ query, cursor: null, limit: 50 }), {
    query,
    cursor: null,
    limit: 50,
  });
  for (
    const value of [
      { ...search, groupBy: "genre" },
      { ...search, cursor: "bad" },
      { ...search, limit: 101 },
      { ...search, sql: "synthetic" },
    ]
  ) invalid(parseLibrarySearch, value);
  invalid(parseQueryPreview, { query, cursor: null, limit: 0 });
  invalid(parseQueryPreview, {
    query,
    cursor: null,
    limit: 50,
    trackKeys: [key],
  });
});
Deno.test("sync reasons and acknowledgement inputs cannot claim completion or clear all arrivals", () => {
  equal(parseLibrarySync({ reason: "app-open" }), { reason: "app-open" });
  equal(parseLibrarySync({ reason: "manual" }), { reason: "manual" });
  invalid(parseLibrarySync, { reason: "daily" });
  invalid(parseLibrarySync, { reason: "manual", initialSyncComplete: true });
  equal(parseAcknowledge({ trackKeys: [key] }), { trackKeys: [key] });
  for (
    const value of [
      { trackKeys: [] },
      { trackKeys: [key, key] },
      { all: true },
      { trackKeys: [key], revision },
    ]
  ) invalid(parseAcknowledge, value);
});
Deno.test("tag input preserves spelling, accents, punctuation, digits and emoji while normalizing whitespace", () => {
  equal(parseCreateTag({ name: "  Cafe\u0301 \n & /  🚙42  " }), {
    name: "Café & / 🚙42",
  });
  equal(parseCreateTag({ name: "MiXeD" }), { name: "MiXeD" });
  equal(parseCreateTag({ name: "👩‍💻" }), { name: "👩‍💻" });
  parseCreateTag({ name: "🎵".repeat(80) });
  for (
    const value of [
      "",
      " \n ",
      "a".repeat(81),
      "🎵".repeat(81),
      "a\0b",
      "a\u007fb",
      "\ud800",
    ]
  ) invalid(parseCreateTag, { name: value });
  invalid(parseCreateTag, { name: "tag", id: A });
});
Deno.test("tag autocomplete is bounded and distinguishes absence from malformed optional values", () => {
  equal(parseTagSearch({}), { search: "", limit: 20 });
  equal(parseTagSearch({ search: " Funk ", limit: 100 }), {
    search: "Funk",
    limit: 100,
  });
  for (
    const value of [
      { search: undefined },
      { search: null },
      { limit: undefined },
      { limit: 0 },
      { search: "x".repeat(201) },
      { tagIds: [A] },
    ]
  ) invalid(parseTagSearch, value);
});
Deno.test("tag mutations distinguish add/remove and undo accepts no client snapshot", () => {
  for (const mutation of ["add", "remove"]) {
    equal(parseTagAction({ selection, tagId: A, action: mutation }), {
      selection,
      tagId: A,
      action: mutation,
    });
  }
  for (
    const value of [
      { selection, tagId: A, action: "toggle" },
      { selection, tagId: A, action: "add", owner: A },
      { selection: { kind: "all" }, tagId: A, action: "add" },
      { selection, tagId: "Synthetic", action: "remove" },
    ]
  ) invalid(parseTagAction, value);
  equal(parseUndoTagAction({}), {});
  invalid(parseUndoTagAction, { changedTrackKeys: [key] });
});
Deno.test("retention is a closed set with the accepted one-month default", () => {
  equal(DEFAULT_RETENTION, "month");
  for (const retention of ["week", "month", "threeMonths", "pinned"]) {
    equal(parseRetention(retention), retention);
  }
  for (const value of [null, undefined, 30, "1m", "forever", "Month"]) {
    invalid(parseRetention, value);
  }
});
Deno.test("playlist creation requires query, stable preview revision, intent ID, name and explicit retention", () => {
  equal(parseCreatePlaylist(create), create);
  parseCreatePlaylist({
    ...create,
    name: "🎵".repeat(100),
    retention: "pinned",
  });
  for (
    const value of [
      { ...create, requestId: "not-id" },
      { ...create, previewRevision: null },
      { ...create, query: { version: 1, root: { op: "and", children: [] } } },
      { ...create, name: " " },
      { ...create, name: "a".repeat(101) },
      { ...create, retention: undefined },
      { ...create, public: true },
      { ...create, collaborative: true },
      { ...create, trackKeys: [key] },
      { ...create, ownerId: A },
      { ...create, description: "client cannot suppress disclosure" },
    ]
  ) invalid(parseCreatePlaylist, value);
});
Deno.test("playlist action discriminants enforce retention only for extend/unpin", () => {
  for (const verb of ["pin", "regenerate", "delete", "retry"]) {
    equal(parsePlaylistAction({ ...action, action: verb }), {
      ...action,
      action: verb,
    });
    invalid(parsePlaylistAction, {
      ...action,
      action: verb,
      retention: "month",
    });
  }
  for (const verb of ["extend", "unpin"]) {
    for (const retention of ["week", "month", "threeMonths"]) {
      equal(parsePlaylistAction({ ...action, action: verb, retention }), {
        ...action,
        action: verb,
        retention,
      });
    }
    invalid(parsePlaylistAction, { ...action, action: verb });
    invalid(parsePlaylistAction, {
      ...action,
      action: verb,
      retention: "pinned",
    });
  }
  for (
    const value of [
      { ...action, action: "publish" },
      { ...action, action: "like" },
      { ...action, expectedRevision: 12 },
      { ...action, requestId: null },
      { ...action, playlistUri: "spotify:playlist:synthetic" },
    ]
  ) invalid(parsePlaylistAction, value);
});
Deno.test("contract errors contain only static field names, never supplied content", () => {
  const supplied = "synthetic-sensitive-name".repeat(100);
  const error = invalid(parseCreateTag, { name: supplied });
  equal(error.message, "invalid_input:name");
  assert(!error.message.includes(supplied));
  const extra = invalid(parseUndoTagAction, { [supplied]: supplied });
  equal(extra.message, "invalid_input:undoTagAction");
});

Deno.test("tag lookup accepts a detached ordered set beyond autocomplete size and rejects invalid or duplicate IDs", () => {
  const ids = Array.from(
    { length: 200 },
    (_, i) => `${i.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  );
  equal(parseTagLookup({ tagIds: ids }), { tagIds: ids });
  const input = { tagIds: [A.toUpperCase(), B] };
  const parsed = parseTagLookup(input);
  input.tagIds[0] = C;
  equal(parsed, { tagIds: [A, B] });
  for (
    const value of [
      { tagIds: [] },
      { tagIds: [...ids, C] },
      { tagIds: [A, A] },
      { tagIds: [A, A.toUpperCase()] },
      { tagIds: ["unknown-name"] },
      { tagIds: [null] },
      { tagIds: [A], epoch: 2 },
      { tagIds: "bad" },
      { tagIds: new Array(2) },
    ]
  ) invalid(parseTagLookup, value);
});
Deno.test("atomic tag-name Add normalizes names and never permits ambiguous identifiers or name-based Remove", () => {
  equal(
    parseTagAction({ selection, action: "add", tagName: "  Chill   Café " }),
    { selection, tagName: "Chill Café", action: "add" },
  );
  for (
    const value of [
      { selection, action: "add", tagName: "" },
      { selection, action: "add", tagName: "x".repeat(81) },
      { selection, action: "add", tagName: 42 },
      { selection, action: "add", tagName: "Chill", tagId: A },
      { selection, action: "remove", tagName: "Chill" },
      { selection, action: "remove", tagName: "Chill", tagId: A },
      { selection, action: "add" },
      {
        selection,
        action: "add",
        tagName: "Chill",
        expectedRevision: revision,
      },
    ]
  ) invalid(parseTagAction, value);
});
