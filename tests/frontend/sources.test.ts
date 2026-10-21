import { afterEach, expect, it, vi } from "vitest";
import { matchingSourceIds, sourcesPage } from "../../app/src/sources-api";
import { trackSources } from "../../app/src/api";
const source = (n: number) => ({
  id: n === 0 ? "liked" : String(n).padStart(22, "a"),
  kind: n === 0 ? "liked" : "playlist",
  name: `Synthetic source ${n}`,
  artworkUrl: null,
  spotifyUrl: null,
  enabled: true,
  available: true,
  managed: false,
  trackCount: 12,
  uniqueCount: 10,
  importedCount: 12,
  skippedCount: 0,
  syncStatus: "complete",
  lastSyncedAt: null,
  errorCode: null,
});
const page = (items: unknown[], total = items.length, library = "1") => ({
  items,
  total,
  enabledCount: total,
  uniqueTrackCount: 14,
  importing: false,
  revision: { library, annotations: "1" },
});
afterEach(() => vi.unstubAllGlobals());
it("keeps deduplicated pool totals distinct from overlapping source counts", () => {
  const parsed = sourcesPage(page([source(0), source(1)]));
  expect(parsed.uniqueTrackCount).toBe(14);
  expect(parsed.items.reduce((sum, s) => sum + s.trackCount, 0)).toBe(24);
});
it.each([
  page([source(1), source(1)]),
  page([{ ...source(0), artworkUrl: "javascript:alert(1)" }]),
  page([{ ...source(0), spotifyUrl: "https://example.com/playlist" }]),
  page([{ ...source(0), importedCount: -1 }]),
  page([{ ...source(0), syncStatus: "invented" }]),
  page(Array.from({ length: 101 }, (_, n) => source(n))),
])("rejects malformed source pages", (raw) =>
  expect(() => sourcesPage(raw)).toThrow(),
);
it("all matching sources enumerates bounded pages and excludes unavailable sources", async () => {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", async (path: string) => {
    const url = new URL(path, "https://synthetic.test");
    calls.push(url);
    const offset = Number(url.searchParams.get("offset"));
    const items = Array.from({ length: offset === 0 ? 50 : 3 }, (_, i) =>
      source(offset + i),
    );
    if (offset === 50) items[1]!.available = false;
    return Response.json(page(items, 53));
  });
  const ids = await matchingSourceIds(
    "synthetic & mix",
    new AbortController().signal,
  );
  expect(ids).toHaveLength(52);
  expect(calls.map((c) => c.searchParams.get("offset"))).toEqual(["0", "50"]);
  expect(
    calls.every(
      (c) =>
        c.searchParams.get("limit") === "50" &&
        c.searchParams.get("search") === "synthetic & mix",
    ),
  ).toBe(true);
});
it("never applies a mixed-revision all-source selection", async () => {
  let n = 0;
  vi.stubGlobal("fetch", async () =>
    Response.json(
      page(
        Array.from({ length: n++ === 0 ? 50 : 3 }, (_, i) => source(i)),
        53,
        String(n),
      ),
    ),
  );
  await expect(
    matchingSourceIds("", new AbortController().signal),
  ).rejects.toMatchObject({ code: "stale_revision" });
});
it("keeps source provenance bounded and handles an older server response", () => {
  expect(trackSources(undefined)).toEqual([]);
  expect(
    trackSources([{ id: "liked", kind: "liked", name: "Liked Songs" }]),
  ).toHaveLength(1);
  expect(() =>
    trackSources([{ id: "bad", kind: "playlist", name: "Synthetic" }]),
  ).toThrow();
});

it("permits only the Spotify consent endpoint for optional collaborative access", async () => {
  const { sourceConsent } = await import("../../app/src/sources-api");
  expect(
    sourceConsent({
      url: "https://accounts.spotify.com/authorize?scope=playlist-read-collaborative",
    }),
  ).toContain("https://accounts.spotify.com/authorize?");
  for (const url of [
    "https://example.com/authorize",
    "javascript:alert(1)",
    "https://accounts.spotify.com/other",
    "https://user:pass@accounts.spotify.com/authorize",
  ])
    expect(() => sourceConsent({ url })).toThrow();
});

it("library status separates explicit source-selection revisions from arrivals", async () => {
  const { libraryStatus } = await import("../../app/src/api");
  const status = {
    revision: { library: "12", annotations: "1" },
    sourcesRevision: "3",
    initialSyncComplete: true,
    syncPhase: "idle",
    importedCount: 3,
    reportedTotal: 3,
    activeCount: 3,
    untaggedCount: 3,
    newCount: 0,
    lastCompletedAt: null,
    blockedBy: null,
  };
  expect(libraryStatus(status).sourcesRevision).toBe("3");
  expect(
    libraryStatus({ ...status, revision: { library: "13", annotations: "1" } })
      .sourcesRevision,
  ).toBe("3");
  expect(() => libraryStatus({ ...status, sourcesRevision: "-1" })).toThrow();
});
