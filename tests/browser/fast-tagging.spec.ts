import { test, expect, type Page, type Route } from "@playwright/test";
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const album = `album:${"a".repeat(64)}`;
const base = {
  membership: "active",
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
const makeTag = (n: number, name: string) => ({
  id: id(n),
  name,
  activeTrackCount: n === 1 ? 84 : 12,
  lastUsedAt: "2026-10-11T12:00:00Z",
});
const tags = [
  makeTag(1, "Chill"),
  makeTag(2, "chillout"),
  makeTag(3, "mood:soft"),
];
const makeTrack = (n: number) => ({
  trackKey: String(n).padStart(64, "0"),
  tagIds: [] as string[],
  metadata: {
    title: `Synthetic song ${n}`,
    artists: [{ id: "aaaaaaaaaaaaaaaaaaaaaa", name: "Synthetic Artist" }],
    album: "Synthetic album",
    releaseDate: "1994",
    durationMs: 181000,
    explicit: false,
    artworkUrl: null,
    spotifyUrl: "https://open.spotify.com/track/aaaaaaaaaaaaaaaaaaaaaa",
    playableUri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa",
    likedAt: "2026-10-11T12:00:00Z",
    removedAt: null,
    acknowledgedAt: null,
  },
});
async function mock(
  page: Page,
  options: {
    failAction?: boolean;
    stale?: boolean;
    intercept?: (route: Route, path: string, body: any) => Promise<boolean>;
  } = {},
) {
  const tracks = [makeTrack(1), makeTrack(2), makeTrack(3)],
    calls: { path: string; body: any }[] = [];
  let annotation = 1;
  const revision = () => ({
    library: options.stale ? "2" : "1",
    annotations: String(annotation),
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4173") return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname,
      body = route.request().postData() ? route.request().postDataJSON() : null;
    calls.push({ path, body });
    if (options.intercept && (await options.intercept(route, path, body)))
      return;
    let json: any;
    if (path === "/api/session")
      json = {
        authenticated: true,
        connection: "connected",
        authorizationDeadline: "2027-04-11T12:00:00Z",
        reconnectWarning: null,
      };
    else if (path === "/api/library/status" || path === "/api/library/sync")
      json = {
        revision: revision(),
        initialSyncComplete: true,
        syncPhase: "idle",
        importedCount: 3,
        reportedTotal: 3,
        activeCount: 3,
        untaggedCount: tracks.filter((t) => !t.tagIds.length).length,
        newCount: 2,
        lastCompletedAt: "2026-10-11T12:00:00Z",
        blockedBy: null,
      };
    else if (path === "/api/library/search")
      json = body.groupBy
        ? {
            revision: revision(),
            groupBy: body.groupBy,
            totalTracks: 3,
            totalGroups: 1,
            nextCursor: null,
            groups: [
              {
                artistId: "aaaaaaaaaaaaaaaaaaaaaa",
                value:
                  body.groupBy === "album"
                    ? album
                    : body.groupBy === "decade"
                      ? "1990"
                      : "aaaaaaaaaaaaaaaaaaaaaa",
                name:
                  body.groupBy === "album"
                    ? "Album unavailable"
                    : body.groupBy === "decade"
                      ? "1990s"
                      : "Synthetic Artist",
                trackCount: 3,
                taggedCount: 0,
                selection: {
                  kind: "filter",
                  filter: {
                    ...body.filter,
                    ...(body.groupBy === "album"
                      ? { album }
                      : body.groupBy === "decade"
                        ? { decade: 1990 }
                        : { artistId: "aaaaaaaaaaaaaaaaaaaaaa" }),
                  },
                  expectedRevision: revision(),
                },
              },
            ],
          }
        : {
            revision: revision(),
            groupBy: null,
            totalTracks: tracks.length,
            nextCursor: null,
            tracks: tracks.filter(
              (t) => !body.filter.untagged || !t.tagIds.length,
            ),
          };
    else if (path === "/api/library/facets")
      json = {
        revision: revision(),
        facet: body.facet,
        totalOptions: 1,
        nextCursor: null,
        options: [
          {
            value:
              body.facet === "album"
                ? album
                : body.facet === "decade"
                  ? "1990"
                  : "aaaaaaaaaaaaaaaaaaaaaa",
            name:
              body.facet === "album"
                ? "Album unavailable"
                : body.facet === "decade"
                  ? "1990s"
                  : "Synthetic Artist",
            trackCount: 3,
          },
        ],
      };
    else if (path === "/api/library/acknowledge")
      json = { revision: revision(), changedCount: body.trackKeys.length };
    else if (path === "/api/tags")
      json = {
        revision: revision(),
        hasMore: false,
        tags: url.searchParams.get("search") === "fresh" ? [] : tags,
      };
    else if (path === "/api/tags/vocabulary")
      json = {
        revision: revision(),
        hasMore: false,
        nextCursor: null,
        tags: body.sort === "unused" ? [] : tags,
      };
    else if (path === "/api/tags/lookup")
      json = {
        revision: revision(),
        tags: body.tagIds.map((x: string) => tags.find((t) => t.id === x)),
      };
    else if (path === "/api/tags/selection")
      json = {
        revision: revision(),
        selectedCount:
          body.selection.kind === "tracks"
            ? body.selection.trackKeys.length
            : 3,
        tags: body.tagIds.map((tagId: string) => {
          const t = tags.find((t) => t.id === tagId)!;
          const selectedCount =
            body.selection.kind === "tracks"
              ? body.selection.trackKeys.length
              : 3;
          return {
            tag: t,
            assignedCount: t.id === id(1) ? 1 : 0,
            state:
              t.id === id(1) ? (selectedCount === 1 ? "all" : "some") : "none",
          };
        }),
      };
    else if (path === "/api/tag-actions") {
      if (options.failAction)
        return route.fulfill({
          status: 409,
          json: { error: "stale_revision" },
        });
      const t =
        tags.find((t) => t.id === body.tagId) ?? makeTag(4, body.tagName);
      for (const row of tracks)
        if (
          body.selection.kind === "filter" ||
          body.selection.trackKeys.includes(row.trackKey)
        )
          row.tagIds =
            body.action === "add"
              ? [...new Set([...row.tagIds, t.id])]
              : row.tagIds.filter((x) => x !== t.id);
      annotation++;
      json = {
        actionId: id(50),
        selectedCount: 1,
        changedCount: 1,
        tag: t,
        revision: revision(),
      };
    } else if (path.endsWith("/undo")) {
      tracks[0]!.tagIds = [];
      annotation++;
      json = {
        actionId: id(50),
        restoredCount: 1,
        skippedCount: 1,
        revision: revision(),
      };
    } else if (path === "/api/tags/manage-preview")
      json = {
        revision: revision(),
        assignmentCount: 120,
        activeTrackCount: 70,
        unionCount: 99,
        collisionTag:
          body.action === "rename" && body.name.toLowerCase() === "chill"
            ? tags[0]
            : null,
      };
    else if (path === "/api/tags/manage") {
      annotation++;
      json = {
        revision: revision(),
        assignmentCount: 120,
        activeTrackCount: 70,
        unionCount: 99,
        collisionTag: null,
        actionId: id(51),
        changedCount: 4,
        tag: body.action === "delete" ? null : tags[0],
      };
    } else if (path === "/api/playlists")
      json = {
        playlists: [],
        nextCursor: null,
        lastCleanupAt: null,
        cleanupBlockedBy: null,
      };
    else throw Error(`Unexpected synthetic route ${path}`);
    await route.fulfill({ json });
  });
  return calls;
}
async function queue(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Tag queue", exact: true })
    .click();
  await expect(
    page.getByLabel("Tag current song", { exact: true }),
  ).toBeVisible();
}
async function browser(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: /^Library/ })
    .click();
}
async function vocabulary(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Tags", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tag vocabulary" }),
  ).toBeVisible();
}
test("queue input letters, number slots, navigation, skip and modified help are independent of saves", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop shortcuts");
  const calls = await mock(page);
  await page.goto("/");
  await queue(page);
  const input = page.getByLabel("Tag current song", { exact: true });
  await input.fill("sad");
  await input.press("ArrowRight");
  await expect(input).toHaveValue("sad");
  await expect(page.locator(".queue-card")).toContainText("Synthetic song 1");
  expect(calls.filter((c) => c.path === "/api/tag-actions")).toHaveLength(0);
  await input.fill("");
  await input.press("1");
  await expect(
    page
      .locator(".queue-card")
      .getByRole("button", { name: "Remove Chill from current song" }),
  ).toBeVisible();
  await expect(
    page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Tagging queue" }) }),
  ).toContainText("1 tagged this session");
  await input.press("ArrowRight");
  await expect(page.locator(".queue-card")).toContainText("Synthetic song 2");
  await input.press("Alt+s");
  await expect(page.locator(".queue-card")).toContainText("Synthetic song 3");
  await input.press("Alt+h");
  await expect(page.getByRole("dialog")).toContainText("Alt/Option");
  await page.getByRole("button", { name: "Close help" }).click();
  expect(calls.filter((c) => c.path === "/api/tag-actions")).toHaveLength(1);
});
test("IME and repeated keys do not submit or consume slots; existing near matches win Enter", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop keyboard");
  const calls = await mock(page);
  await page.goto("/");
  await queue(page);
  const input = page.getByLabel("Tag current song", { exact: true });
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", { key: "1", isComposing: true });
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await input.dispatchEvent("compositionend");
  await input.dispatchEvent("keydown", { key: "1", repeat: true });
  expect(calls.filter((c) => c.path === "/api/tag-actions")).toHaveLength(0);
  await input.fill("chil");
  await expect(
    page.getByRole("option", { name: "Chill 84 songs", exact: true }),
  ).toBeVisible();
  await input.press("Enter");
  await expect
    .poll(() => calls.filter((c) => c.path === "/api/tag-actions").length)
    .toBe(1);
  expect(calls.find((c) => c.path === "/api/tag-actions")!.body.tagId).toBe(
    id(1),
  );
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
});
test("pinning is session-scoped and queue order includes stable last-completed-sync and random seed", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop slots and ordering");
  const calls = await mock(page);
  await page.goto("/");
  await queue(page);
  await page
    .getByRole("button", { name: "Set or pin slot 1", exact: true })
    .click();
  const input = page.getByLabel("Choose tag for slot 1");
  await input.fill("soft");
  await page
    .locator(".suggestions")
    .getByRole("option", { name: "mood:soft 12 songs" })
    .click();
  await expect(
    page
      .locator(".quick-slots")
      .getByRole("button", { name: "1 mood:soft", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Queue order").selectOption("latest");
  await expect
    .poll(() =>
      calls.some(
        (c) => c.path === "/api/library/search" && c.body.filter.latestSyncOnly,
      ),
    )
    .toBe(true);
  await page.getByLabel("Queue order").selectOption("random");
  await expect
    .poll(() =>
      calls.some(
        (c) => c.path === "/api/library/search" && c.body.sort === "random",
      ),
    )
    .toBe(true);
  const r = calls.find(
    (c) => c.path === "/api/library/search" && c.body.sort === "random",
  )!;
  expect(r.body.seed).toMatch(/^[0-9a-f-]{36}$/);
});
test("browser ranges, tri-state fill/clear and opaque album facets use exact frozen targets", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop bulk");
  const calls = await mock(page);
  await page.goto("/");
  await browser(page);
  await page.getByLabel("Group by artist").uncheck();
  await page.getByLabel("Select Synthetic song 1").check();
  await page
    .getByLabel("Select Synthetic song 3")
    .click({ modifiers: ["Shift"] });
  await expect(page.locator(".bulk-bar")).toContainText("3 selected");
  await expect(
    page.getByRole("button", { name: "Add Chill: some (1 of 3)", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add Chill: some (1 of 3)", exact: true })
    .click();
  const action = calls.find((c) => c.path === "/api/tag-actions")!;
  expect(action.body.selection.trackKeys).toHaveLength(3);
  expect(action.body.action).toBe("add");
  await page
    .getByRole("button", { name: "Clear Chill from selection", exact: true })
    .click();
  expect(
    calls.filter((c) => c.path === "/api/tag-actions").at(-1)!.body.action,
  ).toBe("remove");
  await page.getByLabel("Album", { exact: true }).selectOption(album);
  await expect
    .poll(() =>
      calls.some(
        (c) =>
          c.path === "/api/library/search" && c.body.filter.album === album,
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Select all 3 matching", exact: true })
    .click();
  await page.getByLabel("Add tag to selection", { exact: true }).fill("fresh");
  await page
    .getByRole("button", { name: "Create “fresh”", exact: true })
    .click();
  expect(
    calls.filter((c) => c.path === "/api/tag-actions").at(-1)!.body.selection
      .filter.album,
  ).toBe(album);
});
test("stale bulk mutations retain the typed draft and original matching revision", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop bulk");
  const calls = await mock(page, { failAction: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Select all 3 matching" }).click();
  const input = page.getByLabel("Add tag to selection", { exact: true });
  await input.fill("fresh");
  await page
    .getByRole("button", { name: "Create “fresh”", exact: true })
    .click();
  await expect(input).toHaveValue("fresh");
  await expect(page.locator(".bulk-bar")).toBeVisible();
  expect(
    calls.find((c) => c.path === "/api/tag-actions")!.body.selection
      .expectedRevision,
  ).toEqual({ library: "1", annotations: "1" });
  await expect(page.getByRole("alert").first()).toContainText(
    "library changed",
  );
});
test("rename collision offers explicit union preview, commits destination identity and session undo", async ({
  page,
}) => {
  const calls = await mock(page);
  await page.goto("/");
  await vocabulary(page);
  await page
    .getByRole("button", { name: "Manage chillout", exact: true })
    .click();
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Manage “chillout”" }) });
  await dialog.getByLabel("New tag name").fill("chill");
  await dialog.getByRole("button", { name: "Preview rename" }).click();
  await page.getByRole("button", { name: "Preview collision merge" }).click();
  await expect(
    page.getByRole("dialog").filter({ hasText: "Confirm merge" }),
  ).toContainText("99 distinct songs");
  await page.getByRole("button", { name: "Confirm change" }).click();
  const action = calls.find((c) => c.path === "/api/tags/manage")!;
  expect(action.body.action).toBe("merge");
  expect(action.body.sourceIds).toEqual([id(2)]);
  expect(action.body.targetId).toBe(id(1));
  await page.getByRole("button", { name: "Undo vocabulary action" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "later changes were preserved",
  );
});
test("delete confirms retained assignment count, last-used and unused gardening remain explicit", async ({
  page,
}) => {
  const calls = await mock(page);
  await page.goto("/");
  await vocabulary(page);
  await page.getByLabel("Vocabulary order").selectOption("lastUsed");
  await expect
    .poll(() =>
      calls.some(
        (c) => c.path === "/api/tags/vocabulary" && c.body.sort === "lastUsed",
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Manage Chill", exact: true }).click();
  await page.getByRole("button", { name: "Preview delete" }).click();
  await expect(
    page.getByRole("dialog").filter({ hasText: "Delete this tag?" }),
  ).toContainText("120 assignments");
  await page
    .getByRole("button", { name: "Delete tag and 120 assignments" })
    .click();
  expect(
    calls.find((c) => c.path === "/api/tags/manage")!.body
      .confirmedAssignmentCount,
  ).toBe(120);
  await page.getByLabel("Vocabulary order").selectOption("unused");
  await expect(
    page.getByText(
      "Unused means no assignments, including retained tags on songs removed from Spotify.",
    ),
  ).toBeVisible();
});
test("mobile new badge opens cards and a touch sheet with swipe advance and no bulk/hotkey controls", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Mobile lite mode");
  await mock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "2 new", exact: true }).click();
  await expect(page.locator(".mobile-cards")).toBeVisible();
  await page.locator(".mobile-track").first().click();
  const sheet = page.locator(".queue-card.sheet-open");
  await expect(sheet).toContainText("Synthetic song 1");
  await expect(
    sheet.getByLabel("Tag current song", { exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Hotkey help" }),
  ).not.toBeVisible();
  await sheet.dispatchEvent("touchstart", {
    touches: [{ identifier: 1, clientX: 300, clientY: 200 }],
  });
  await sheet.dispatchEvent("touchend", {
    changedTouches: [{ identifier: 1, clientX: 100, clientY: 205 }],
  });
  await expect(sheet).toContainText("Synthetic song 2");
  await sheet.getByRole("button", { name: "2 chillout", exact: true }).click();
  await expect(
    sheet.getByRole("button", { name: "Remove chillout from current song" }),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Close song sheet" }).click();
  await expect(sheet).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("returning desktop enters queue and first-run guidance leads with largest groups", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop home policy");
  await mock(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Synthetic Artist", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Dismiss first-run guidance" })
    .click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Tagging queue", exact: true }),
  ).toBeVisible();
});

test("failed first queue traversal retries the same default order and pinning preserves highest remaining rank", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop queue");
  let recovered = false;
  const calls = await mock(page, {
    intercept: async (route, path, body) => {
      if (
        path === "/api/library/search" &&
        body.groupBy === null &&
        body.filter.untagged &&
        !recovered
      ) {
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
        return true;
      }
      return false;
    },
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Tag queue", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh queue", exact: true }),
  ).toBeVisible();
  recovered = true;
  await page
    .getByRole("button", { name: "Refresh queue", exact: true })
    .click();
  await expect(
    page.getByLabel("Tag current song", { exact: true }),
  ).toBeVisible();
  expect(
    calls
      .filter((c) => c.path === "/api/library/search" && c.body.filter.untagged)
      .at(-1)!.body.sort,
  ).toBe("newest");
  await page
    .getByRole("button", { name: "Set or pin slot 1", exact: true })
    .click();
  await page.getByLabel("Choose tag for slot 1").fill("Chill");
  await page
    .locator(".suggestions")
    .getByRole("option", { name: "Chill 84 songs", exact: true })
    .click();
  await expect(
    page
      .locator(".quick-slots")
      .getByRole("button", { name: "2 chillout", exact: true }),
  ).toBeVisible();
});
test("membership removals before the focused row keep that song current; delayed old refresh cannot truncate a replacement queue", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop sequence");
  let changed = false,
    delayed = false,
    syncCount = 0;
  const deferred = { release: null as (() => void) | null, replied: false };
  await mock(page, {
    intercept: async (route, path, body) => {
      if (path === "/api/library/sync" && body.reason === "manual") {
        changed = true;
        syncCount++;
        await route.fulfill({
          json: {
            revision: { library: String(syncCount + 1), annotations: "1" },
            initialSyncComplete: true,
            syncPhase: "idle",
            importedCount: 2,
            reportedTotal: 2,
            activeCount: 2,
            untaggedCount: 2,
            newCount: 0,
            lastCompletedAt: "2026-10-11T12:00:00Z",
            blockedBy: null,
          },
        });
        return true;
      }
      if (
        changed &&
        path === "/api/library/search" &&
        body.groupBy === null &&
        body.sort === undefined
      ) {
        if (delayed)
          await new Promise<void>((resolve) => {
            deferred.release = resolve;
          });
        try {
          await route.fulfill({
            json: {
              revision: { library: String(syncCount + 1), annotations: "1" },
              groupBy: null,
              totalTracks: 2,
              nextCursor: null,
              tracks: [makeTrack(2), makeTrack(3)],
            },
          });
        } catch {
          /* obsolete request was aborted */
        }
        deferred.replied = true;
        return true;
      }
      return false;
    },
  });
  await page.goto("/");
  await queue(page);
  await page
    .getByLabel("Tag current song", { exact: true })
    .press("ArrowRight");
  await expect(page.locator(".queue-card")).toContainText("Synthetic song 2");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator(".mobile-track")).toHaveCount(2);
  await expect(page.locator(".queue-card")).toContainText("Synthetic song 2");
  // Hold the next membership result while the user replaces the queue.
  delayed = true;
  deferred.replied = false;
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => !!deferred.release).toBe(true);
  await page.getByLabel("Queue order").selectOption("oldest");
  await expect(page.locator(".mobile-track")).toHaveCount(3);
  deferred.release?.();
  await expect.poll(() => deferred.replied).toBe(true);
  await expect(page.locator(".mobile-track")).toHaveCount(3);
  await page
    .getByLabel("Tag current song", { exact: true })
    .press("ArrowRight");
  await page
    .getByLabel("Tag current song", { exact: true })
    .press("ArrowRight");
  await expect(page.locator(".queue-card")).toContainText("Synthetic song 3");
});
test("vocabulary page-two mutation and undo reset the revision-bound cursor", async ({
  page,
}) => {
  const cursor = "abcdefghijklmnop";
  const calls = await mock(page, {
    intercept: async (route, path, body) => {
      if (path !== "/api/tags/vocabulary") return false;
      await route.fulfill({
        json: {
          revision: { library: "1", annotations: "1" },
          hasMore: !body.cursor,
          nextCursor: body.cursor ? null : cursor,
          tags: body.cursor ? [tags[1]] : [tags[0]],
        },
      });
      return true;
    },
  });
  await page.goto("/");
  await vocabulary(page);
  await page.getByRole("button", { name: "Next tags" }).click();
  await page
    .getByRole("button", { name: "Manage chillout", exact: true })
    .click();
  await page.getByLabel("New tag name").fill("Evening");
  await page.getByRole("button", { name: "Preview rename" }).click();
  await page.getByRole("button", { name: "Confirm change" }).click();
  await expect(
    page.getByRole("button", { name: "Manage Chill", exact: true }),
  ).toBeVisible();
  expect(
    calls.filter((c) => c.path === "/api/tags/vocabulary").at(-1)!.body.cursor,
  ).toBeNull();
  await page.getByRole("button", { name: "Next tags" }).click();
  await expect(
    page.getByRole("button", { name: "Manage chillout", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo vocabulary action" }).click();
  await expect(
    page.getByRole("button", { name: "Manage Chill", exact: true }),
  ).toBeVisible();
  expect(
    calls.filter((c) => c.path === "/api/tags/vocabulary").at(-1)!.body.cursor,
  ).toBeNull();
});

test("arrival review is an explicit owner mutation; navigation and typing never acknowledge it", async ({
  page,
  isMobile,
}) => {
  const calls = await mock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "2 new", exact: true }).click();
  if (isMobile) await page.locator(".mobile-track").first().click();
  else
    await expect(
      page.getByLabel("Tag current song", { exact: true }),
    ).toBeVisible();
  await page
    .locator(".queue-card")
    .getByRole("button", { name: "Next →", exact: true })
    .click();
  expect(
    calls.filter((c) => c.path === "/api/library/acknowledge"),
  ).toHaveLength(0);
  await page
    .getByRole("button", { name: "Mark arrival reviewed", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mark arrival reviewed", exact: true }),
  ).toHaveCount(0);
  expect(
    calls.find((c) => c.path === "/api/library/acknowledge")!.body.trackKeys,
  ).toEqual([makeTrack(2).trackKey]);
});

for (const action of ["tag", "acknowledge"])
  test(`a ${action} response cannot hide concurrent removal and another song's tag edit`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "Desktop revision interleaving");
    let changed = false;
    await mock(page, {
      intercept: async (route, path, body) => {
        if (
          path ===
          (action === "tag" ? "/api/tag-actions" : "/api/library/acknowledge")
        ) {
          changed = true;
          await route.fulfill({
            json:
              action === "tag"
                ? {
                    actionId: id(50),
                    selectedCount: 1,
                    changedCount: 1,
                    tag: tags[0],
                    revision: { library: "2", annotations: "3" },
                  }
                : {
                    changedCount: 1,
                    revision: { library: "2", annotations: "3" },
                  },
          });
          return true;
        }
        if (
          changed &&
          (path === "/api/library/sync" || path === "/api/library/status")
        ) {
          await route.fulfill({
            json: {
              revision: { library: "2", annotations: "3" },
              initialSyncComplete: true,
              syncPhase: "idle",
              importedCount: 2,
              reportedTotal: 2,
              activeCount: 2,
              untaggedCount: 0,
              newCount: 0,
              lastCompletedAt: "2026-10-11T12:00:00Z",
              blockedBy: null,
            },
          });
          return true;
        }
        if (
          changed &&
          path === "/api/library/search" &&
          body.groupBy === null
        ) {
          const a = makeTrack(1),
            b = makeTrack(3);
          a.tagIds = [id(1)];
          b.tagIds = [id(3)];
          await route.fulfill({
            json: {
              revision: { library: "2", annotations: "3" },
              groupBy: null,
              totalTracks: 2,
              nextCursor: null,
              tracks: [a, b],
            },
          });
          return true;
        }
        return false;
      },
    });
    await page.goto("/");
    await queue(page);
    if (action === "tag")
      await page.getByLabel("Tag current song", { exact: true }).press("1");
    else
      await page.getByRole("button", { name: "Mark arrival reviewed" }).click();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.locator(".mobile-track")).toHaveCount(2);
    await page
      .getByLabel("Tag current song", { exact: true })
      .press("ArrowRight");
    await expect(page.locator(".queue-card")).toContainText("Synthetic song 3");
    await expect(
      page.getByRole("button", { name: "Remove mood:soft from current song" }),
    ).toBeVisible();
  });

test("repeating an artist jump reapplies that artist after clearing its browser facet", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop artist shortcut");
  await mock(page);
  await page.goto("/");
  await queue(page);
  await page.getByLabel("Tag current song", { exact: true }).press("Alt+a");
  await expect(page.getByLabel("Artist", { exact: true })).toHaveValue(
    "aaaaaaaaaaaaaaaaaaaaaa",
  );
  await page.getByLabel("Artist", { exact: true }).selectOption("");
  await expect(page.getByLabel("Artist", { exact: true })).toHaveValue("");
  await queue(page);
  await page.getByLabel("Tag current song", { exact: true }).press("Alt+a");
  await expect(page.getByLabel("Artist", { exact: true })).toHaveValue(
    "aaaaaaaaaaaaaaaaaaaaaa",
  );
});
test("global rename updates a pinned quick slot without losing its identity", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop session pins");
  let renamed = false;
  const renamedTag = { ...tags[0]!, name: "Evening" };
  await mock(page, {
    intercept: async (route, path, body) => {
      if (path === "/api/tags/manage") {
        renamed = true;
        await route.fulfill({
          json: {
            revision: { library: "1", annotations: "2" },
            assignmentCount: 84,
            activeTrackCount: 84,
            unionCount: 84,
            collisionTag: null,
            actionId: id(51),
            changedCount: 1,
            tag: renamedTag,
          },
        });
        return true;
      }
      if (renamed && path === "/api/tags/lookup") {
        await route.fulfill({
          json: {
            revision: { library: "1", annotations: "2" },
            tags: body.tagIds.map((x: string) =>
              x === id(1) ? renamedTag : tags.find((t) => t.id === x),
            ),
          },
        });
        return true;
      }
      return false;
    },
  });
  await page.goto("/");
  await queue(page);
  await page
    .getByRole("button", { name: "Set or pin slot 1", exact: true })
    .click();
  await page.getByLabel("Choose tag for slot 1").fill("Chill");
  await page
    .locator(".suggestions")
    .getByRole("option", { name: "Chill 84 songs", exact: true })
    .click();
  await vocabulary(page);
  await page.getByRole("button", { name: "Manage Chill", exact: true }).click();
  await page.getByLabel("New tag name").fill("Evening");
  await page.getByRole("button", { name: "Preview rename" }).click();
  await page.getByRole("button", { name: "Confirm change" }).click();
  await queue(page);
  await expect(
    page
      .locator(".quick-slots")
      .getByRole("button", { name: "1 Evening", exact: true }),
  ).toBeVisible();
});
