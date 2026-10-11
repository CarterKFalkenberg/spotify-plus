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
