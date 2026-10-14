import { describe, it, expect } from "vitest";
import {
  queueShortcut,
  rangeSelection,
  skipToTail,
} from "../../app/src/tagging";
import {
  facetFilter,
  managePreview,
  search,
  tagSelection,
} from "../../app/src/fast-api";
const key = (key: string, overrides: Record<string, boolean> = {}) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...overrides,
});
describe("queue input rules", () => {
  it("never consumes letters while typing, even in empty input", () => {
    for (const c of ["s", "z", "r", "o", "a", "h"])
      expect(queueShortcut(key(c), true, "")).toBeNull();
    expect(queueShortcut(key("s", { altKey: true }), true, "sad")).toBe("skip");
  });
  it("reserves slots and navigation only for empty non-composing input", () => {
    expect(queueShortcut(key("2"), true, "")).toBe("slot:2");
    expect(queueShortcut(key("2"), true, "23")).toBeNull();
    expect(queueShortcut(key("ArrowRight"), true, "")).toBe("next");
    expect(queueShortcut(key("ArrowRight"), true, "text")).toBeNull();
    for (const flag of ["isComposing", "repeat", "ctrlKey", "metaKey"])
      expect(queueShortcut(key("2", { [flag]: true }), true, "")).toBeNull();
  });
  it("supports reversed shift ranges without discarding selections on other pages", () => {
    expect(
      rangeSelection(["a", "b", "c", "d"], ["off-page"], "d", "b", true, true),
    ).toEqual(["off-page", "b", "c", "d"]);
    expect(
      rangeSelection(["a", "b", "c"], ["a", "b", "c"], "c", "a", true, false),
    ).toEqual([]);
  });
  it("skipping keeps every track and moves only the current song to the tail", () =>
    expect(skipToTail(["a", "b", "c"], 1)).toEqual(["a", "c", "b"]));
});
describe("fast-tagging boundaries", () => {
  it("passes opaque unavailable album identity verbatim and unknown decade explicitly", () => {
    const base = {
        membership: "active" as const,
        search: "",
        untagged: false,
        newOnly: false,
        artistId: null,
      },
      value = `album:${"a".repeat(64)}`;
    expect(facetFilter(base, "album", value).album).toBe(value);
    expect(facetFilter(base, "album", null).album).toBeNull();
    expect(facetFilter(base, "decade", "unknown").decade).toBe("unknown");
    expect(facetFilter(base, "decade", "1990").decade).toBe(1990);
  });
  it("uses exact backend union, rather than summed assignment counts", () => {
    expect(
      managePreview({
        revision: { library: "1", annotations: "2" },
        assignmentCount: 120,
        activeTrackCount: 70,
        unionCount: 99,
        collisionTag: null,
      }).unionCount,
    ).toBe(99);
  });
  it("rejects malformed group cursors and invalid tri-state data", () => {
    expect(() =>
      search({
        groupBy: null,
        revision: { library: "1", annotations: "1" },
        totalTracks: 0,
        nextCursor: "bad",
        tracks: [],
      }),
    ).toThrow();
    expect(() =>
      tagSelection({
        revision: { library: "1", annotations: "1" },
        selectedCount: 1,
        tags: [{ state: "some-ish" }],
      }),
    ).toThrow();
  });
});

it("pin positions consume only the remaining ranked tags; membership refresh preserves the current identity", async () => {
  const { quickSlots, preserveCurrent } = await import("../../app/src/tagging");
  const a = { id: "a" },
    b = { id: "b" },
    c = { id: "c" };
  expect(quickSlots([a, b, c], { 0: a }, 3)).toEqual([a, b, c]);
  expect(quickSlots([a, b, c], { 2: a }, 3)).toEqual([b, c, a]);
  const rows = [{ trackKey: "a" }, { trackKey: "b" }, { trackKey: "c" }];
  expect(
    preserveCurrent(
      rows,
      1,
      new Map([
        ["b", rows[1]!],
        ["c", rows[2]!],
      ]),
    ),
  ).toEqual({ rows: [rows[1], rows[2]], index: 0 });
  expect(
    preserveCurrent(
      rows,
      1,
      new Map([
        ["a", rows[0]!],
        ["c", rows[2]!],
      ]),
    ),
  ).toEqual({ rows: [rows[0], rows[2]], index: 1 });
});

it("a local patch advances only its owned revision and never hides unrelated membership or annotation edits", async () => {
  const { ownedPatchRevision } = await import("../../app/src/tagging");
  const before = { library: "1", annotations: "1" };
  expect(
    ownedPatchRevision(before, { library: "1", annotations: "2" }, true),
  ).toEqual({ library: "1", annotations: "2" });
  expect(
    ownedPatchRevision(before, { library: "2", annotations: "2" }, true),
  ).toBe(before);
  expect(
    ownedPatchRevision(before, { library: "1", annotations: "3" }, true),
  ).toBe(before);
  expect(
    ownedPatchRevision(before, { library: "1", annotations: "2" }, false),
  ).toBe(before);
});

it("rejects JSON arrays masquerading as valid response enums and preserves valid scalar states", () => {
  const revision = { library: "1", annotations: "1" };
  for (const groupBy of ["artist", "album", "decade"]) {
    const response = {
      revision,
      totalTracks: 0,
      nextCursor: null,
      totalGroups: 0,
      groups: [],
      groupBy,
    };
    expect(search(response).groupBy).toBe(groupBy);
    expect(() => search({ ...response, groupBy: [groupBy] })).toThrow(
      "invalid_response",
    );
  }
  const tag = {
    id: "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Synthetic tag",
    activeTrackCount: 1,
    lastUsedAt: null,
  };
  for (const state of ["all", "some", "none"]) {
    const response = {
      revision,
      selectedCount: 1,
      tags: [{ tag, assignedCount: state === "none" ? 0 : 1, state }],
    };
    expect(tagSelection(response).tags[0]?.state).toBe(state);
    expect(() =>
      tagSelection({
        ...response,
        tags: [{ ...response.tags[0], state: [state] }],
      }),
    ).toThrow("invalid_response");
  }
});

it("uses physical modified-letter codes for real macOS Option characters while preserving composition and text", () => {
  const shortcuts = [
    ["ß", "KeyS", "skip"],
    ["Ω", "KeyZ", "undo"],
    ["®", "KeyR", "remove"],
    ["ø", "KeyO", "open"],
    ["å", "KeyA", "artist"],
    ["˙", "KeyH", "help"],
  ];
  for (const [character, code, action] of shortcuts) {
    const event = { ...key(character!, { altKey: true }), code: code! };
    expect(queueShortcut(event, true, "draft")).toBe(action);
    expect(
      queueShortcut({ ...event, isComposing: true }, true, "draft"),
    ).toBeNull();
    expect(queueShortcut({ ...event, repeat: true }, true, "")).toBeNull();
    expect(queueShortcut({ ...event, altKey: false }, true, "")).toBeNull();
  }
  expect(
    queueShortcut({ ...key("Dead", { altKey: true }), code: "KeyE" }, true, ""),
  ).toBeNull();
});

it("queue undo restores only its changed edge and preserves unrelated later tags", async () => {
  const { restoredQueueTags } = await import("../../app/src/tagging");
  const add = { tagId: "a", kind: "add" as const, changed: true };
  const restored = { restoredCount: 1, skippedCount: 0 };
  expect(restoredQueueTags(["a", "b"], add, restored)).toEqual(["b"]);
  expect(restoredQueueTags(["a"], add, restored)).toEqual([]);
  expect(
    restoredQueueTags(["b"], { ...add, kind: "remove" }, restored),
  ).toEqual(["b", "a"]);
  const current = ["a", "b"];
  expect(
    restoredQueueTags(current, add, { restoredCount: 0, skippedCount: 1 }),
  ).toBe(current);
  expect(
    restoredQueueTags(current, add, { restoredCount: 0, skippedCount: 0 }),
  ).toBe(current);
  expect(restoredQueueTags(current, { ...add, changed: false }, restored)).toBe(
    current,
  );
});

it("autocomplete groups normalized prefixes stably without changing relevance inside a group", async () => {
  const { groupedTagOptions } = await import("../../app/src/tagging");
  const ranked = [
    { id: "a", name: "Mood:chill" },
    { id: "b", name: "sit:drive" },
    { id: "c", name: "mood:calm" },
    { id: "d", name: "SIT:walk" },
    { id: "e", name: "plain" },
    { id: "f", name: "single:tag" },
  ];
  const grouped = groupedTagOptions(ranked);
  expect(grouped.map((item) => item.tag.id)).toEqual([
    "a",
    "c",
    "b",
    "d",
    "e",
    "f",
  ]);
  expect(grouped.map((item) => item.heading)).toEqual([
    "Mood:",
    null,
    "sit:",
    null,
    null,
    null,
  ]);
  expect(ranked.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
});
