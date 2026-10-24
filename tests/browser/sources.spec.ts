import { test, expect, type Page, type Route } from "@playwright/test";
import { appearance } from "./flows";
import { assertReadableSurface } from "./visual-assertions";
function source(n: number) {
  return {
    id: n === 0 ? "liked" : String(n).padStart(22, "a"),
    kind: n === 0 ? "liked" : "playlist",
    name:
      n === 0
        ? "Liked Songs"
        : n === 1
          ? "Synthetic Night Drive"
          : n === 2
            ? "Synthetic Generated Mix"
            : `Synthetic Collection ${n}`,
    artworkUrl: null,
    spotifyUrl:
      n === 0
        ? "https://open.spotify.com/collection/tracks"
        : `https://open.spotify.com/playlist/${String(n).padStart(22, "a")}`,
    enabled: n !== 2,
    available: n !== 3,
    managed: n === 2,
    trackCount: n === 1 ? 100 : 84 + n,
    uniqueCount: n === 0 ? 84 : n === 4 ? 30 : n === 6 ? 0 : 70,
    importedCount: n === 4 ? 36 : n === 6 ? 0 : n === 1 ? 100 : 84 + n,
    skippedCount: n === 1 ? 2 : 0,
    syncStatus:
      n === 4
        ? "syncing"
        : n === 6
          ? "pending"
          : n === 5
            ? "error"
            : n === 2
              ? "disabled"
              : "complete",
    lastSyncedAt: n === 6 ? null : "2026-10-21T12:00:00Z",
    errorCode: n === 5 ? "unavailable" : null,
  };
}
async function mock(
  page: Page,
  options: {
    total?: number;
    failSelection?: boolean;
    importing?: boolean;
    collaborativeConsentRequired?: boolean;
    intercept?: (route: Route, path: string) => Promise<boolean>;
  } = {},
) {
  const items = Array.from({ length: options.total ?? 7 }, (_, n) => source(n));
  const selections: { ids: string[]; enabled: boolean }[] = [];
  let revision = 1;
  const rev = () => ({ library: String(revision), annotations: "1" });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin !==
      (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173")
    )
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    if (options.intercept && (await options.intercept(route, path))) return;
    const body = route.request().postData()
      ? route.request().postDataJSON()
      : {};
    // General tagging fixtures model an owner without optional playback consent.
    // Listening tests override this route explicitly with their synthetic SDK.
    if (path === "/api/playback/token")
      return route.fulfill({
        status: 503,
        json: { error: "playback_required" },
      });
    let json: unknown;
    if (path === "/api/session")
      json = {
        authenticated: true,
        connection: "connected",
        authorizationDeadline: "2027-04-11T12:00:00Z",
        reconnectWarning: null,
      };
    else if (path === "/api/library/status" || path === "/api/library/sync")
      json = {
        revision: rev(),
        initialSyncComplete: !options.importing,
        syncPhase: options.importing ? "importing" : "idle",
        importedCount: 7,
        reportedTotal: 140,
        activeCount: 140,
        untaggedCount: 140,
        newCount: 0,
        lastCompletedAt: "2026-10-21T12:00:00Z",
        blockedBy: null,
      };
    else if (path === "/api/sources") {
      const matching = items.filter((s) =>
        s.name
          .toLowerCase()
          .includes((url.searchParams.get("search") ?? "").toLowerCase()),
      );
      const offset = Number(url.searchParams.get("offset") ?? 0);
      json = {
        items: matching.slice(offset, offset + 50),
        total: matching.length,
        enabledCount: items.filter((s) => s.enabled).length,
        uniqueTrackCount: 140,
        importing: options.importing ?? false,
        collaborativeConsentRequired:
          options.collaborativeConsentRequired ?? false,
        revision: rev(),
      };
    } else if (path === "/api/sources/selection") {
      selections.push(body);
      if (options.failSelection)
        return route.fulfill({ status: 503, json: { error: "unavailable" } });
      for (const s of items)
        if (body.ids.includes(s.id)) s.enabled = body.enabled;
      revision++;
      json = { changedCount: body.ids.length, revision: rev() };
    } else if (path === "/api/sources/sync")
      json = { queued: true, revision: rev() };
    else if (
      path === "/api/library/queue" ||
      path === "/api/library/queue-tracks"
    )
      json = { revision: rev(), trackKeys: [], entries: [] };
    else if (path === "/api/library/search")
      json = body.groupBy
        ? {
            groupBy: body.groupBy,
            groups: [],
            totalGroups: 0,
            totalTracks: 0,
            nextCursor: null,
            revision: rev(),
          }
        : {
            groupBy: null,
            tracks: [],
            totalTracks: 0,
            nextCursor: null,
            revision: rev(),
          };
    else if (path === "/api/tags" || path === "/api/tags/vocabulary")
      json = { tags: [], hasMore: false, nextCursor: null, revision: rev() };
    else if (path === "/api/library/facets")
      json = { items: [], nextCursor: null, revision: rev() };
    else json = { error: "unavailable" };
    return route.fulfill({ json });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sources", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Include Liked Songs", exact: true }),
  ).toBeVisible();
  return { selections };
}
test("bounded pages, search, all matching selection and explicit generated playlist opt-in", async ({
  page,
}) => {
  const { selections } = await mock(page, { total: 53 });
  await expect(
    page.getByText("1–50 of 53 sources", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Include Synthetic Generated Mix" }),
  ).not.toBeChecked();
  await page
    .getByRole("switch", { name: "Include Synthetic Generated Mix" })
    .click();
  await expect(
    page.getByRole("switch", { name: "Include Synthetic Generated Mix" }),
  ).toBeChecked();
  expect(selections[0]?.ids).toEqual([source(2).id]);
  await page.getByRole("button", { name: "Next →", exact: true }).click();
  await expect(
    page.getByText("51–53 of 53 sources", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Deselect all", exact: true }).click();
  await expect.poll(() => selections.length).toBe(2);
  expect(selections[1]?.ids).toHaveLength(52);
  expect(selections[1]?.ids).not.toContain(source(3).id);
  await page
    .getByRole("searchbox", { name: "Search sources" })
    .fill("Night Drive");
  await expect(
    page.getByText("1–1 of 1 sources", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select all matching", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "Include Synthetic Night Drive" }),
  ).toBeChecked();
  expect(selections.at(-1)?.ids).toEqual([source(1).id]);
});
test("failed selection is never shown as confirmed and a fresh read supports retry", async ({
  page,
}) => {
  await mock(page, { failSelection: true });
  await page
    .getByRole("switch", { name: "Include Liked Songs", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  await expect(
    page.getByRole("switch", { name: "Include Liked Songs", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Retry sources", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("late search responses cannot replace newer source results", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await mock(page, {
    intercept: async (route, path) => {
      if (
        path !== "/api/sources" ||
        new URL(route.request().url()).searchParams.get("search") !== "Night"
      )
        return false;
      started = true;
      await hold;
      await route.fulfill({
        json: {
          items: [source(1)],
          total: 1,
          enabledCount: 6,
          uniqueTrackCount: 140,
          importing: false,
          revision: { library: "1", annotations: "1" },
        },
      });
      return true;
    },
  });
  await page.getByRole("searchbox", { name: "Search sources" }).fill("Night");
  await expect.poll(() => started).toBe(true);
  await page
    .getByRole("searchbox", { name: "Search sources" })
    .fill("Generated");
  await expect(
    page.getByRole("switch", { name: "Include Synthetic Generated Mix" }),
  ).toBeVisible();
  release?.();
  await expect(
    page.getByRole("switch", { name: "Include Synthetic Night Drive" }),
  ).toHaveCount(0);
});
for (const theme of ["light", "dark"] as const)
  test(`sources ${theme} has readable unavailable/progress states and mobile navigation`, async ({
    page,
  }, testInfo) => {
    if (process.env.SOURCES_PROOF === "1")
      await page.setViewportSize(
        testInfo.project.name === "mobile"
          ? { width: 390, height: 844 }
          : { width: 1440, height: 900 },
      );
    await mock(page, { importing: true });
    await appearance(page, theme);
    await expect(page.getByText("140 unique songs enabled")).toBeVisible();
    const deduplicated = page.locator(".source-row").filter({
      has: page.getByRole("heading", {
        name: "Synthetic Night Drive",
        exact: true,
      }),
    });
    await expect(deduplicated).toContainText("Spotify playlist · 70 songs");
    await expect(deduplicated).not.toContainText("100 songs");
    const pending = page.locator(".source-row").filter({
      has: page.getByRole("heading", {
        name: "Synthetic Collection 6",
        exact: true,
      }),
    });
    await expect(pending).toContainText("90 items reported");
    await expect(pending).not.toContainText("90 songs");
    await expect(
      page.getByText("Unavailable in Spotify · last known count"),
    ).toBeVisible();
    await expect(page.getByText("36 imported · syncing")).toBeVisible();
    await expect(
      page.getByText("2 local or non-song items skipped"),
    ).toBeVisible();
    await expect(
      page.getByText(
        /playlist generation resumes after the import is verified/,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "Include Synthetic Generated Mix" }),
    ).not.toBeChecked();
    // Let the search debounce settle: initial results must not disappear.
    await page.waitForTimeout(250);
    await expect(page.locator(".source-row")).toHaveCount(7);
    await assertReadableSurface(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (process.env.SOURCES_PROOF === "1")
      await page.screenshot({
        path: `docs/design/sources-proof/after-${testInfo.project.name}-${theme}.png`,
        fullPage: true,
      });
  });

test("collaborative playlist access is an explicit optional consent action with safe failure", async ({
  page,
}) => {
  let consentCalls = 0;
  await mock(page, {
    collaborativeConsentRequired: true,
    intercept: async (route, path) => {
      if (path !== "/api/sources/enable") return false;
      consentCalls++;
      await route.fulfill({ json: { url: "https://example.com/authorize" } });
      return true;
    },
  });
  await expect(
    page.getByRole("button", {
      name: "Enable collaborative playlists",
      exact: true,
    }),
  ).toBeVisible();
  expect(consentCalls).toBe(0);
  await page
    .getByRole("button", {
      name: "Enable collaborative playlists",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  await expect(
    page.getByRole("switch", { name: "Include Liked Songs", exact: true }),
  ).toBeChecked();
  expect(consentCalls).toBe(1);
});

test("an unavailable source can be turned off and explicitly enabled again for verified recovery", async ({
  page,
  isMobile,
}) => {
  let enabled = true,
    retrying = false,
    verified = false,
    revision = 1;
  const writes: { ids: string[]; enabled: boolean }[] = [];
  const tagId = "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let tagWrites = 0;
  const rev = () => ({ library: String(revision), annotations: "1" });
  const poolCount = () => (enabled && (!retrying || verified) ? 2 : 1);
  const recoveredTrack = {
    trackKey: "2".padStart(64, "0"),
    tagIds: [tagId],
    sources: [
      { id: source(3).id, kind: "playlist", name: "Synthetic Collection 3" },
    ],
    metadata: {
      title: "Synthetic Retained Song",
      artists: [{ id: "a".repeat(22), name: "Synthetic Artist" }],
      album: "Synthetic Album",
      releaseDate: "2026",
      durationMs: 181000,
      explicit: false,
      artworkUrl: null,
      spotifyUrl: `https://open.spotify.com/track/${"a".repeat(22)}`,
      playableUri: `spotify:track:${"a".repeat(22)}`,
      likedAt: "2026-10-21T12:00:00Z",
      removedAt: null,
      acknowledgedAt: null,
    },
  };
  const likedTrack = {
    ...recoveredTrack,
    trackKey: "1".padStart(64, "0"),
    tagIds: [],
    sources: [{ id: "liked", kind: "liked", name: "Liked Songs" }],
    metadata: { ...recoveredTrack.metadata, title: "Synthetic Liked Song" },
  };
  await mock(page, {
    intercept: async (route, path) => {
      const body = route.request().postData()
        ? route.request().postDataJSON()
        : {};
      let json: unknown;
      if (path === "/api/sources")
        json = {
          items: [
            { ...source(0), trackCount: 1, uniqueCount: 1, importedCount: 1 },
            {
              ...source(3),
              enabled,
              available: verified,
              trackCount: 1,
              uniqueCount: 1,
              importedCount: 1,
              syncStatus: retrying && !verified ? "pending" : "complete",
            },
          ],
          total: 2,
          enabledCount: enabled ? 2 : 1,
          uniqueTrackCount: poolCount(),
          importing: retrying && !verified,
          revision: rev(),
        };
      else if (path === "/api/sources/selection") {
        writes.push(body);
        enabled = body.enabled;
        retrying = enabled;
        revision++;
        json = { changedCount: 1, revision: rev() };
      } else if (path === "/api/library/status" || path === "/api/library/sync")
        json = {
          revision: rev(),
          sourcesRevision: String(writes.length),
          initialSyncComplete: !retrying || verified,
          syncPhase: retrying && !verified ? "importing" : "idle",
          importedCount: poolCount(),
          reportedTotal: 2,
          activeCount: poolCount(),
          untaggedCount: 1,
          newCount: 0,
          lastCompletedAt: "2026-10-21T12:00:00Z",
          blockedBy: null,
        };
      else if (
        path === "/api/library/queue" ||
        path === "/api/library/queue-tracks"
      ) {
        const selected = (
          poolCount() === 2 ? [likedTrack, recoveredTrack] : [likedTrack]
        ).filter((t) =>
          path.endsWith("queue-tracks")
            ? body.trackKeys.includes(t.trackKey)
            : true,
        );
        json = {
          revision: rev(),
          trackKeys: selected.map((t) => t.trackKey),
          entries: selected.map((track) => ({ key: track.trackKey, track })),
        };
      } else if (path === "/api/library/search")
        json = body.groupBy
          ? {
              groupBy: body.groupBy,
              groups: [],
              totalGroups: 0,
              totalTracks: poolCount(),
              nextCursor: null,
              revision: rev(),
            }
          : {
              groupBy: null,
              tracks:
                poolCount() === 2 ? [likedTrack, recoveredTrack] : [likedTrack],
              totalTracks: poolCount(),
              nextCursor: null,
              revision: rev(),
            };
      else if (path === "/api/tags/lookup")
        json = {
          tags: body.tagIds.map(() => ({
            id: tagId,
            name: "Synthetic Kept Tag",
            activeTrackCount: 1,
            lastUsedAt: null,
          })),
          revision: rev(),
        };
      else if (path.startsWith("/api/tag-actions")) {
        tagWrites++;
        json = { error: "invalid_input" };
      } else return false;
      await route.fulfill({ json });
      return true;
    },
  });
  const toggle = page.getByRole("switch", {
    name: "Include Synthetic Collection 3",
    exact: true,
  });
  const row = page.locator(".source-row").filter({ has: toggle });
  await expect(toggle).toBeChecked();
  await expect(row).toContainText("Unavailable in Spotify");
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(
    page.getByText("1 unique songs enabled", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: /^Library/ })
    .click();
  if (!isMobile)
    await page
      .getByRole("navigation", { name: "Browse library" })
      .getByRole("button", { name: "Songs", exact: true })
      .click();
  await expect(
    page.getByText("Synthetic Retained Song", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(row).toContainText("Unavailable in Spotify");
  await expect(
    page.getByText(/playlist generation resumes after the import is verified/),
  ).toBeVisible();
  await page.clock.install();
  verified = true;
  revision++;
  await page.clock.fastForward(1500);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row).toContainText("Up to date");
  await expect(
    page.getByText("2 unique songs enabled", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: /^Library/ })
    .click();
  await page.clock.fastForward(200);
  await expect(
    page.getByText("Synthetic Retained Song", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove Synthetic Kept Tag from Synthetic Retained Song",
      exact: true,
    }),
  ).toBeVisible();
  expect(writes).toEqual([
    { ids: [source(3).id], enabled: false },
    { ids: [source(3).id], enabled: true },
  ]);
  expect(tagWrites).toBe(0);
});
