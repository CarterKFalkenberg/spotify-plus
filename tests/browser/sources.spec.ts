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
    trackCount: 84 + n,
    uniqueCount: 70,
    importedCount: n === 4 ? 36 : 84 + n,
    skippedCount: n === 1 ? 2 : 0,
    syncStatus:
      n === 4
        ? "syncing"
        : n === 5
          ? "error"
          : n === 2
            ? "disabled"
            : "complete",
    lastSyncedAt: "2026-10-21T12:00:00Z",
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
