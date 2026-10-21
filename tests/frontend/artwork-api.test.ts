import { expect, it } from "vitest";
import { librarySearch } from "../../app/src/api";
import { search } from "../../app/src/fast-api";
const page = {
  revision: { library: "1", annotations: "2" },
  totalTracks: 0,
  nextCursor: null,
  groupBy: "artist",
  groups: [],
  totalGroups: 0,
};
it.each([librarySearch, search])(
  "parses hydration state independently from semantic revisions",
  (parse) => {
    expect(parse(page).artworkPending).toBe(false);
    expect(parse({ ...page, artworkPending: true }).artworkPending).toBe(true);
    expect(parse({ ...page, artworkPending: false }).revision).toEqual(
      page.revision,
    );
    for (const artworkPending of [null, "true", 1, {}]) {
      expect(() => parse({ ...page, artworkPending })).toThrow();
    }
  },
);
