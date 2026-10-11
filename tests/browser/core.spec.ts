import { test, expect, type Page, type Route } from "@playwright/test";
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const revision = { library: "1", annotations: "1" };
const tag = (n = 1) => ({
  id: id(n),
  name: `Synthetic tag ${n}`,
  activeTrackCount: 3,
  lastUsedAt: null,
});
const filter = {
  membership: "active",
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
const group = {
  artistId: "aaaaaaaaaaaaaaaaaaaaaa",
  name: "Synthetic Artist",
  trackCount: 3,
  taggedCount: 0,
  selection: {
    kind: "filter",
    filter: { ...filter, artistId: "aaaaaaaaaaaaaaaaaaaaaa" },
    expectedRevision: revision,
  },
};
const track = (n = 1, tagIds: string[] = [], playable = true) => ({
  trackKey: n.toString(16).padStart(64, "0"),
  tagIds,
  metadata: {
    title: `Synthetic song ${n}`,
    artists: [{ id: "aaaaaaaaaaaaaaaaaaaaaa", name: "Synthetic Artist" }],
    album: "Synthetic album",
    releaseDate: "2026",
    durationMs: 180000,
    explicit: false,
    artworkUrl: null,
    spotifyUrl: "https://open.spotify.com/track/aaaaaaaaaaaaaaaaaaaaaa",
    playableUri: playable ? "spotify:track:aaaaaaaaaaaaaaaaaaaaaa" : null,
    likedAt: "2026-10-11T12:00:00Z",
    removedAt: null,
    acknowledgedAt: null,
  },
});
const status = {
  revision,
  initialSyncComplete: true,
  syncPhase: "idle",
  importedCount: 3,
  reportedTotal: 3,
  activeCount: 3,
  untaggedCount: 3,
  newCount: 2,
  lastCompletedAt: "2026-10-11T12:00:00Z",
  blockedBy: null,
};
const playlist = (n = 1) => ({
  id: id(500 + n),
  revision: "1",
  name: `Synthetic playlist ${n}`,
  spotifyUrl: "https://open.spotify.com/playlist/aaaaaaaaaaaaaaaaaaaaaa",
  query: { version: 1, root: { op: "tag", tagId: id(1) } },
  retention: "month",
  createdAt: "2026-10-11T12:00:00Z",
  expiresOn: "2026-11-11",
  trackCount: 2,
  status: "ready",
  blockedBy: null,
});
type Override = (route: Route, path: string) => Promise<boolean>;
async function mock(
  page: Page,
  override?: Override,
  context: {
    revision?: () => typeof revision;
    tracks?: () => ReturnType<typeof track>[];
  } = {},
) {
  const calls: { path: string; body: any }[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4173") return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname;
    calls.push({
      path,
      body: route.request().postData() ? route.request().postDataJSON() : null,
    });
    if (override && (await override(route, path))) return;
    const responseRevision = context.revision?.() ?? revision;
    const responseTracks = context.tracks?.() ?? [track(1, [id(1)]), track(2)];
    let json: any;
    if (path === "/api/session")
      json = {
        authenticated: true,
        connection: "connected",
        authorizationDeadline: "2027-04-11T12:00:00Z",
        reconnectWarning: null,
      };
    else if (path === "/api/library/status" || path === "/api/library/sync")
      json = { ...status, revision: responseRevision };
    else if (path === "/api/library/search") {
      const body = route.request().postDataJSON();
      json = body.groupBy
        ? {
            groupBy: "artist",
            totalGroups: 1,
            groups: [
              {
                ...group,
                selection: {
                  ...group.selection,
                  expectedRevision: responseRevision,
                },
              },
            ],
            totalTracks: 3,
            revision: responseRevision,
            nextCursor: null,
          }
        : {
            groupBy: null,
            tracks: responseTracks,
            totalTracks: 2,
            revision: responseRevision,
            nextCursor: null,
          };
    } else if (path === "/api/library/facets")
      json = {
        facet: route.request().postDataJSON().facet,
        revision: responseRevision,
        options: [],
        totalOptions: 0,
        nextCursor: null,
      };
    else if (path === "/api/tags/selection") {
      const body = route.request().postDataJSON();
      if (
        JSON.stringify(body.expectedRevision) !==
          JSON.stringify(responseRevision) ||
        (body.selection.kind === "filter" &&
          JSON.stringify(body.selection.expectedRevision) !==
            JSON.stringify(responseRevision))
      ) {
        await route.fulfill({ status: 409, json: { error: "stale_revision" } });
        return;
      }
      const selectedTracks =
        body.selection.kind === "tracks"
          ? responseTracks.filter((t) =>
              body.selection.trackKeys.includes(t.trackKey),
            )
          : responseTracks;
      const selectedCount =
        body.selection.kind === "tracks" ? body.selection.trackKeys.length : 3;
      json = {
        revision: responseRevision,
        selectedCount,
        tags: body.tagIds.map((value: string) => {
          const assignedCount = selectedTracks.filter((t) =>
            t.tagIds.includes(value),
          ).length;
          return {
            tag: tag(parseInt(value.slice(0, 8), 16)),
            assignedCount,
            state:
              assignedCount === 0
                ? "none"
                : assignedCount === selectedCount
                  ? "all"
                  : "some",
          };
        }),
      };
    } else if (path === "/api/tags/vocabulary")
      json = {
        revision: responseRevision,
        tags: [tag()],
        hasMore: false,
        nextCursor: null,
      };
    else if (path === "/api/tags")
      json = { tags: [tag()], hasMore: false, revision: responseRevision };
    else if (path === "/api/tags/lookup")
      json = {
        tags: route
          .request()
          .postDataJSON()
          .tagIds.map((value: string) => tag(parseInt(value.slice(0, 8), 16))),
        revision: responseRevision,
      };
    else if (path === "/api/tag-actions") {
      const body = route.request().postDataJSON();
      if (
        body.selection.kind === "filter" &&
        JSON.stringify(body.selection.expectedRevision) !==
          JSON.stringify(responseRevision)
      ) {
        await route.fulfill({ status: 409, json: { error: "stale_revision" } });
        return;
      }
      json = {
        actionId: id(400),
        selectedCount: 3,
        changedCount: 2,
        revision: {
          ...responseRevision,
          annotations: String(BigInt(responseRevision.annotations) + 1n),
        },
        tag: {
          ...tag(),
          name: route.request().postDataJSON().tagName ?? tag().name,
        },
      };
    } else if (path.endsWith("/undo"))
      json = {
        actionId: id(400),
        restoredCount: 1,
        skippedCount: 1,
        revision: responseRevision,
      };
    else if (path === "/api/query/preview")
      json = {
        query: route.request().postDataJSON().query,
        revision: responseRevision,
        generationReady: true,
        matchedCount: 3,
        playableCount: 2,
        excludedCount: 1,
        durationMs: 360000,
        tracks: [track(1), track(2), track(3, [], false)],
        nextCursor: null,
      };
    else if (path === "/api/playlists" && route.request().method() === "GET")
      json = {
        playlists: [playlist()],
        nextCursor: null,
        lastCleanupAt: new Date().toISOString(),
        cleanupBlockedBy: null,
      };
    else if (path === "/api/playlists" || path.endsWith("/actions"))
      json = {
        requestId: route.request().postDataJSON().requestId,
        playlist: { ...playlist(), status: "pending" },
      };
    else throw new Error(`Unexpected synthetic route ${path}`);
    await route.fulfill({ json });
  });
  return calls;
}
async function choose(page: Page, label = "Add All of tag") {
  await page.getByLabel(label, { exact: true }).fill("Synthetic");
  await page
    .locator(".suggestions")
    .getByRole("option", { name: /^Synthetic tag 1 / })
    .click();
}
async function builder(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Make a playlist" })
    .click();
}
async function library(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: /^Library/ })
    .click();
}
async function lists(page: Page) {
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Your playlists" })
    .click();
}
test("focused autocomplete only; freeform artist and matching selection use one frozen atomic action", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Bulk is desktop only");
  const calls = await mock(page, async (route, path) => {
    if (path !== "/api/tags") return false;
    await route.fulfill({ json: { tags: [], hasMore: false, revision } });
    return true;
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Synthetic Artist", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  expect(calls.filter((call) => call.path === "/api/tags")).toHaveLength(0);
  await page
    .getByLabel("Tag all 3 songs by Synthetic Artist")
    .fill("Fresh freeform");
  await page.getByRole("button", { name: "Create “Fresh freeform”" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Added “Fresh freeform”" }),
  ).toBeVisible();
  const first = calls.find((call) => call.path === "/api/tag-actions")!;
  expect(first.body).toEqual({
    selection: group.selection,
    tagName: "Fresh freeform",
    action: "add",
  });
  expect(
    calls.filter((call) => call.path === "/api/tags" && call.body),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "Select all 3 matching" }).click();
  await page.getByLabel("Add tag to selection").fill("Fresh selection");
  await page.getByRole("button", { name: "Create “Fresh selection”" }).click();
  await expect
    .poll(() => calls.filter((call) => call.path === "/api/tag-actions").length)
    .toBe(2);
  expect(
    calls.filter((call) => call.path === "/api/tag-actions")[1]!.body.selection,
  ).toEqual({ kind: "filter", filter, expectedRevision: revision });
});
test("explicit remove and changed-only undo use server identities", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Bulk selection is desktop only");
  const calls = await mock(page);
  await page.goto("/");
  await page.getByLabel("Group by artist").uncheck();
  await page.getByLabel("Select Synthetic song 1").check();
  await expect(
    page
      .locator(".bulk-bar")
      .getByRole("button", { name: "Remove", exact: true }),
  ).toBeVisible();
  await choose(page, "Remove tag from selection");
  await expect(
    page.getByRole("status").filter({ hasText: "Removed" }),
  ).toContainText("2 songs");
  expect(calls.find((call) => call.path === "/api/tag-actions")!.body).toEqual({
    selection: { kind: "tracks", trackKeys: [track().trackKey] },
    tagId: id(1),
    action: "remove",
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "later edits were preserved" }),
  ).toContainText("1 later edits were preserved");
  expect(calls.find((call) => call.path.endsWith("/undo"))!.body).toEqual({});
});
test("assigned names beyond the first hundred resolve in bounded lookup batches", async ({
  page,
}) => {
  const ids = Array.from({ length: 201 }, (_, i) => id(i + 1));
  const calls = await mock(page, async (route, path) => {
    if (path !== "/api/library/search") return false;
    await route.fulfill({
      json: {
        groupBy: null,
        tracks: [track(1, ids)],
        totalTracks: 1,
        revision,
        nextCursor: null,
      },
    });
    return true;
  });
  await page.goto("/");
  await library(page);
  await expect(
    page.getByRole("button", {
      name: "Remove Synthetic tag 201 from Synthetic song 1",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    calls
      .filter((call) => call.path === "/api/tags/lookup")
      .map((call) => call.body.tagIds.length)
      .sort((a, b) => a - b),
  ).toEqual([1, 1, 200]);
});
test("mobile builder shows cached counts, exclusions, visible month default and explicit private intent", async ({
  page,
}) => {
  const calls = await mock(page);
  await page.goto("/");
  await builder(page);
  await expect(
    page.getByLabel("Keep this playlist", { exact: true }),
  ).toHaveValue("month");
  await choose(page);
  await expect(
    page.locator(".preview-heading").getByText("2 songs", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("0h 6m · from your cached library"),
  ).toBeVisible();
  await expect(page.getByText(/1 unavailable song is excluded/)).toBeVisible();
  await page.getByRole("button", { name: "Create private playlist →" }).click();
  await expect(page.getByText(/Playlist request accepted/)).toBeVisible();
  const body = calls.find(
    (call) => call.path === "/api/playlists" && call.body,
  )!.body;
  expect(body.retention).toBe("month");
  expect(body.previewRevision).toEqual(revision);
  await lists(page);
  await expect(
    page.getByRole("link", { name: "Open in Spotify ↗" }),
  ).toHaveAttribute("href", playlist().spotifyUrl);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
for (const rejection of [401, 403])
  test(`lost create then ${rejection} then reconnect replays exact durable intent`, async ({
    page,
  }) => {
    let count = 0;
    const calls = await mock(page, async (route, path) => {
      if (path !== "/api/playlists" || route.request().method() !== "POST")
        return false;
      count++;
      if (count < 3) {
        await route.fulfill({
          status: count === 1 ? 503 : rejection,
          json: { error: count === 1 ? "unavailable" : "unauthorized" },
        });
        return true;
      }
      return false;
    });
    await page.goto("/");
    await builder(page);
    await choose(page);
    await page
      .getByRole("button", { name: "Create private playlist →" })
      .click();
    await page
      .getByRole("button", { name: "Retry saved create request" })
      .click();
    await expect(page.getByRole("alert")).toContainText("Reconnect Spotify");
    await page.reload();
    await builder(page);
    await page
      .getByRole("button", { name: "Retry saved create request" })
      .click();
    await expect(page.getByText(/Playlist request accepted/)).toBeVisible();
    const bodies = calls
      .filter((call) => call.path === "/api/playlists" && call.body)
      .map((call) => call.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
for (const rejection of [401, 403])
  test(`lost lifecycle then ${rejection} retains exact action through reload`, async ({
    page,
  }) => {
    let count = 0;
    const calls = await mock(page, async (route, path) => {
      if (!path.endsWith("/actions")) return false;
      count++;
      if (count < 3) {
        await route.fulfill({
          status: count === 1 ? 503 : rejection,
          json: { error: "unauthorized" },
        });
        return true;
      }
      return false;
    });
    await page.goto("/");
    await lists(page);
    await page.getByRole("button", { name: "Extend", exact: true }).click();
    await page
      .getByRole("button", { name: "Retry unconfirmed action" })
      .click();
    await page.reload();
    await lists(page);
    await page
      .getByRole("button", { name: "Retry unconfirmed action" })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry unconfirmed action" }),
    ).toHaveCount(0);
    const bodies = calls
      .filter((call) => call.path.endsWith("/actions"))
      .map((call) => call.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
test("stale create unlocks editing and query changes invalidate the viewed preview", async ({
  page,
}) => {
  let previews = 0;
  await mock(page, async (route, path) => {
    if (path === "/api/playlists" && route.request().method() === "POST") {
      await route.fulfill({ status: 409, json: { error: "stale_revision" } });
      return true;
    }
    if (path === "/api/query/preview") {
      previews++;
      if (previews > 1)
        await new Promise((resolve) => setTimeout(resolve, 450));
    }
    return false;
  });
  await page.goto("/");
  await builder(page);
  await choose(page);
  await page.getByRole("button", { name: "Create private playlist →" }).click();
  await expect(
    page.getByRole("button", { name: "Retry saved create request" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Remove Synthetic tag 1 from all" })
    .click();
  await expect(
    page.getByRole("button", { name: "Create private playlist →" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Add at least one tag to see the songs that fit."),
  ).toBeVisible();
});
test("import browsing stays available while create is gated; manual sync and new badge preserve filters", async ({
  page,
  isMobile,
}) => {
  const calls = await mock(page, async (route, path) => {
    if (path !== "/api/library/status" && path !== "/api/library/sync")
      return false;
    await route.fulfill({
      json: {
        ...status,
        initialSyncComplete: false,
        syncPhase: "importing",
        importedCount: 2,
      },
    });
    return true;
  });
  await page.goto("/");
  await builder(page);
  await choose(page);
  await expect(
    page.getByRole("button", { name: "Create private playlist →" }),
  ).toBeDisabled();
  await expect(page.getByText(/2 of 3 imported/)).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();
  expect(
    calls
      .filter((call) => call.path === "/api/library/sync")
      .map((call) => call.body.reason),
  ).toContain("manual");
  await page.getByRole("button", { name: "2 new", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tagging queue", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        calls.filter((call) => call.path === "/api/library/search").at(-1)!.body
          .filter.newOnly,
    )
    .toBe(true);
  if (!isMobile) {
    await library(page);
    await page.getByLabel("Untagged", { exact: true }).check();
    await page.getByLabel("Search your library").fill("Synthetic");
  }
});
test("playlist deletion needs explicit confirmation and saved lifecycle statuses stay honest", async ({
  page,
}) => {
  const calls = await mock(page, async (route, path) => {
    if (path !== "/api/playlists" || route.request().method() !== "GET")
      return false;
    await route.fulfill({
      json: {
        playlists: [
          playlist(),
          { ...playlist(2), status: "incomplete", blockedBy: "quota" },
          { ...playlist(3), status: "removing" },
          { ...playlist(4), status: "pending" },
        ],
        nextCursor: null,
        lastCleanupAt: null,
        cleanupBlockedBy: "unavailable",
      },
    });
    return true;
  });
  await page.goto("/");
  await lists(page);
  await expect(
    page.getByText("Incomplete — retry", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Removal awaiting confirmation", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Queued / working", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete now", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Keep playlist", exact: true }),
  ).toBeFocused();
  expect(calls.filter((call) => call.path.endsWith("/actions"))).toHaveLength(
    0,
  );
  await page.getByRole("button", { name: "Confirm removal" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    calls.find((call) => call.path.endsWith("/actions"))!.body.action,
  ).toBe("delete");
});

test("stored query names beyond 100 are resolved by ID without placeholder names", async ({
  page,
}) => {
  const calls = await mock(page, async (route, path) => {
    if (path !== "/api/playlists" || route.request().method() !== "GET")
      return false;
    const rows = [0, 100, 200].map((start, index) => ({
      ...playlist(index + 1),
      query: {
        version: 1,
        root: {
          op: "or",
          children: Array.from(
            { length: index === 2 ? 1 : 100 },
            (_, offset) => ({ op: "tag", tagId: id(start + offset + 1) }),
          ),
        },
      },
    }));
    await route.fulfill({
      json: {
        playlists: rows,
        nextCursor: null,
        lastCleanupAt: new Date().toISOString(),
        cleanupBlockedBy: null,
      },
    });
    return true;
  });
  await page.goto("/");
  await lists(page);
  await expect(page.locator(".query-summary").last()).toHaveText(
    "(Synthetic tag 201)",
  );
  expect(
    calls
      .filter((call) => call.path === "/api/tags/lookup")
      .map((call) => call.body.tagIds.length),
  ).toEqual([200, 1]);
  await expect(page.locator(".query-summary")).not.toContainText([
    "Resolving query tags…",
  ]);
});
test("deleted stored tag rejects query name batch and offers explicit refresh feedback", async ({
  page,
}) => {
  await mock(page, async (route, path) => {
    if (path !== "/api/tags/lookup") return false;
    await route.fulfill({ status: 409, json: { error: "unknown_tag" } });
    return true;
  });
  await page.goto("/");
  await lists(page);
  await expect(page.getByRole("alert")).toContainText("no longer exists");
  await expect(page.locator(".query-summary")).toHaveText(
    "Resolving query tags…",
  );
});
for (const zero of [true, false])
  test(`zero playable or unstable preview (${zero}) disables creation`, async ({
    page,
  }) => {
    await mock(page, async (route, path) => {
      if (path !== "/api/query/preview") return false;
      await route.fulfill({
        json: {
          query: route.request().postDataJSON().query,
          revision,
          generationReady: zero,
          matchedCount: zero ? 0 : 1,
          playableCount: zero ? 0 : 1,
          excludedCount: 0,
          durationMs: zero ? 0 : 180000,
          tracks: zero ? [] : [track()],
          nextCursor: null,
        },
      });
      return true;
    });
    await page.goto("/");
    await builder(page);
    await choose(page);
    await expect(
      page.getByText(
        zero
          ? "No songs have this combination of tags. Try removing a requirement."
          : "1 songs",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create private playlist →" }),
    ).toBeDisabled();
  });
test("late preview from an earlier bucket cannot unlock creation for the new query", async ({
  page,
}) => {
  let captured: any = null,
    release: (() => void) | undefined;
  await mock(page, async (route, path) => {
    if (path !== "/api/query/preview") return false;
    const query = route.request().postDataJSON().query;
    if (!captured) {
      captured = query;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await route.fulfill({
          json: {
            query,
            revision,
            generationReady: true,
            matchedCount: 1,
            playableCount: 1,
            excludedCount: 0,
            durationMs: 180000,
            tracks: [track()],
            nextCursor: null,
          },
        });
      } catch {
        /* The UI aborts obsolete requests. */
      }
      return true;
    }
    await route.fulfill({
      json: {
        query,
        revision,
        generationReady: true,
        matchedCount: 0,
        playableCount: 0,
        excludedCount: 0,
        durationMs: 0,
        tracks: [],
        nextCursor: null,
      },
    });
    return true;
  });
  await page.goto("/");
  await builder(page);
  await choose(page);
  await expect.poll(() => !!release).toBe(true);
  await page
    .getByRole("button", { name: "Remove Synthetic tag 1 from all" })
    .click();
  await choose(page, "Add None of tag");
  release!();
  await expect(
    page.getByText(
      "No songs have this combination of tags. Try removing a requirement.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create private playlist →" }),
  ).toBeDisabled();
});
test("synthetic desktop/mobile visual acceptance", async ({
  page,
  isMobile,
}, testInfo) => {
  await mock(page);
  await page.goto("/");
  if (isMobile) {
    await choose(page);
    await expect(
      page.locator(".preview-heading").getByText("2 songs", { exact: true }),
    ).toBeVisible();
  } else
    await expect(
      page.getByRole("heading", { name: "Synthetic Artist", exact: true }),
    ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("core-ui.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("deleted assigned tags trigger one bounded library refresh without guessed names", async ({
  page,
}) => {
  let missing = false,
    searches = 0;
  await mock(page, async (route, path) => {
    if (path === "/api/playlists" && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          playlists: [],
          nextCursor: null,
          lastCleanupAt: null,
          cleanupBlockedBy: null,
        },
      });
      return true;
    }
    if (path === "/api/library/search") {
      searches++;
      await route.fulfill({
        json: {
          groupBy: null,
          tracks: [track(1, missing ? [] : [id(1)])],
          totalTracks: 1,
          revision,
          nextCursor: null,
        },
      });
      return true;
    }
    if (path === "/api/tags/lookup" && !missing) {
      missing = true;
      await route.fulfill({ status: 409, json: { error: "unknown_tag" } });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await library(page);
  await expect(page.getByRole("alert")).toContainText("no longer exists");
  await expect.poll(() => searches).toBe(2);
  await expect(
    page.getByRole("button", {
      name: "Remove Synthetic tag 1 from Synthetic song 1",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("empty import is an explicit empty-library state instead of zero-of-zero progress", async ({
  page,
}) => {
  await mock(page, async (route, path) => {
    if (path === "/api/library/status" || path === "/api/library/sync") {
      await route.fulfill({
        json: {
          ...status,
          initialSyncComplete: false,
          reportedTotal: 0,
          importedCount: 0,
          activeCount: 0,
          untaggedCount: 0,
          newCount: 0,
          syncPhase: "importing",
        },
      });
      return true;
    }
    if (path === "/api/library/search") {
      await route.fulfill({
        json: {
          groupBy: "artist",
          totalGroups: 0,
          groups: [],
          totalTracks: 0,
          revision,
          nextCursor: null,
        },
      });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await library(page);
  await expect(page.locator(".library-status")).toContainText(
    "Your Spotify library is empty",
  );
  await expect(
    page.getByRole("heading", { name: "Your library is waiting" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("0 of 0");
});

test("import revision refresh preserves typing draft, focus and frozen explicit keys", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Explicit bulk selection is desktop only");
  let currentRevision = revision;
  let searches = 0;
  const calls = await mock(
    page,
    async (route, path) => {
      if (path === "/api/library/status" || path === "/api/library/sync") {
        await route.fulfill({
          json: {
            ...status,
            revision: currentRevision,
            initialSyncComplete: false,
            syncPhase: "importing",
          },
        });
        return true;
      }
      if (path === "/api/library/search") {
        searches++;
        await route.fulfill({
          json: {
            groupBy: null,
            tracks: [track(1), track(2)],
            totalTracks: 2,
            revision: currentRevision,
            nextCursor: null,
          },
        });
        return true;
      }
      return false;
    },
    { revision: () => currentRevision, tracks: () => [track(1), track(2)] },
  );
  await page.goto("/");
  await page.getByLabel("Select Synthetic song 1").check();
  const input = page.getByLabel("Add tag to selection", { exact: true });
  await input.fill("Draft during import");
  const before = searches;
  currentRevision = { library: "2", annotations: "2" };
  // Workspace's unattended status poll observes the next import revision.
  await expect.poll(() => searches, { timeout: 10000 }).toBeGreaterThan(before);
  await expect(input).toHaveValue("Draft during import");
  await expect(input).toBeFocused();
  await expect(page.getByLabel("Select Synthetic song 1")).toBeChecked();
  await expect(page.locator(".bulk-bar")).toContainText("1 selected");
  await expect(
    page
      .getByRole("listbox", { name: "Add tag to selection tag suggestions" })
      .getByRole("option", {
        name: "Synthetic tag 1 none · 0 of 1 selected",
        exact: true,
      }),
  ).toBeEnabled();
  const latestInspection = calls
    .filter((call) => call.path === "/api/tags/selection")
    .at(-1)!;
  expect(latestInspection.body.expectedRevision).toEqual(currentRevision);
  expect(latestInspection.body.selection).toEqual({
    kind: "tracks",
    trackKeys: [track().trackKey],
  });
  await expect(input).toHaveValue("Draft during import");
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect
    .poll(() => calls.filter((call) => call.path === "/api/tag-actions").length)
    .toBe(1);
  expect(
    calls.find((call) => call.path === "/api/tag-actions")!.body.selection,
  ).toEqual({ kind: "tracks", trackKeys: [track().trackKey] });
});

test("successful freeform tag keeps input focus for the next tag and preserves explicit selection", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Explicit bulk selection is desktop only");
  const calls = await mock(page, async (route, path) => {
    if (path !== "/api/tags") return false;
    await route.fulfill({ json: { tags: [], hasMore: false, revision } });
    return true;
  });
  await page.goto("/");
  await page.getByLabel("Group by artist").uncheck();
  await page.getByLabel("Select Synthetic song 1").check();
  const input = page.getByLabel("Add tag to selection", { exact: true });
  await input.fill("First keyboard tag");
  await expect(
    page.getByRole("button", { name: "Create “First keyboard tag”" }),
  ).toBeEnabled();
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(page.getByLabel("Select Synthetic song 1")).toBeChecked();
  await input.pressSequentially("Second keyboard tag");
  await expect(
    page.getByRole("button", { name: "Create “Second keyboard tag”" }),
  ).toBeEnabled();
  await input.press("Enter");
  await expect
    .poll(() => calls.filter((call) => call.path === "/api/tag-actions").length)
    .toBe(2);
  await expect(input).toBeFocused();
  const actions = calls
    .filter((call) => call.path === "/api/tag-actions")
    .map((call) => call.body);
  expect(actions.map((action) => action.tagName)).toEqual([
    "First keyboard tag",
    "Second keyboard tag",
  ]);
  expect(actions[1].selection).toEqual(actions[0].selection);
});

test("background refresh never silently renews a frozen filter selection", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Filter bulk selection is desktop only");
  let currentRevision = revision,
    searches = 0;
  const calls = await mock(
    page,
    async (route, path) => {
      if (path === "/api/library/status" || path === "/api/library/sync") {
        await route.fulfill({ json: { ...status, revision: currentRevision } });
        return true;
      }
      if (path === "/api/library/search") {
        searches++;
        await route.fulfill({
          json: {
            groupBy: "artist",
            groups: [
              {
                ...group,
                selection: {
                  ...group.selection,
                  expectedRevision: currentRevision,
                },
              },
            ],
            totalGroups: 1,
            totalTracks: 3,
            revision: currentRevision,
            nextCursor: null,
          },
        });
        return true;
      }
      return false;
    },
    { revision: () => currentRevision },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Select all 3 matching" }).click();
  const input = page.getByLabel("Add tag to selection", { exact: true });
  await input.fill("Frozen filter draft");
  const before = searches;
  currentRevision = { library: "2", annotations: "2" };
  await expect.poll(() => searches, { timeout: 10000 }).toBeGreaterThan(before);
  await expect(input).toHaveValue("Frozen filter draft");
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "earlier library revision" }),
  ).toBeVisible();
  const picker = page.locator(".bulk-bar .tag-picker").filter({ has: input });
  await expect(picker.getByRole("alert")).toContainText("Your library changed");
  await expect(
    picker.getByRole("button", { name: "Add", exact: true }),
  ).toBeDisabled();
  await input.press("Enter");
  expect(calls.filter((call) => call.path === "/api/tag-actions")).toHaveLength(
    0,
  );
  const staleInspection = calls
    .filter((call) => call.path === "/api/tags/selection")
    .at(-1)!;
  expect(staleInspection.body.expectedRevision).toEqual(revision);
  expect(staleInspection.body.selection).toEqual({
    kind: "filter",
    filter,
    expectedRevision: revision,
  });
  await expect(input).toHaveValue("Frozen filter draft");
  await expect(input).toBeFocused();
  // Only the owner's explicit reselection adopts the current revision.
  await page.getByRole("button", { name: "Select all 3 matching" }).click();
  await input.focus();
  await expect(
    page.getByRole("status").filter({ hasText: "earlier library revision" }),
  ).toHaveCount(0);
  await expect(
    picker.getByRole("option", {
      name: "Synthetic tag 1 some · 1 of 3 selected",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(input).toHaveValue("Frozen filter draft");
  await input.press("Enter");
  await expect
    .poll(() => calls.filter((call) => call.path === "/api/tag-actions").length)
    .toBe(1);
  expect(
    calls.find((call) => call.path === "/api/tag-actions")!.body.selection,
  ).toEqual({ kind: "filter", filter, expectedRevision: currentRevision });
});

for (const paged of [false, true])
  test(`transient ${paged ? "pagination" : "initial"} preview failure can retry the unchanged query safely`, async ({
    page,
  }) => {
    let attempts = 0,
      recovered = false;
    const calls = await mock(page, async (route, path) => {
      if (path !== "/api/query/preview") return false;
      attempts++;
      const body = route.request().postDataJSON();
      if (attempts === (paged ? 2 : 1)) {
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
        return true;
      }
      if (attempts > (paged ? 2 : 1)) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        recovered = true;
      }
      await route.fulfill({
        json: {
          query: body.query,
          revision,
          generationReady: true,
          matchedCount: 1,
          playableCount: 1,
          excludedCount: 0,
          durationMs: 180000,
          tracks: [track()],
          nextCursor: paged && !recovered ? "abcdefghijklmnop" : null,
        },
      });
      return true;
    });
    await page.goto("/");
    await builder(page);
    await choose(page);
    if (paged)
      await page.getByRole("button", { name: "More preview songs" }).click();
    await expect(
      page.getByRole("button", { name: "Create private playlist →" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Retry preview", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Create private playlist →" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Create private playlist →" }),
    ).toBeEnabled();
    const requests = calls
      .filter((call) => call.path === "/api/query/preview")
      .map((call) => call.body);
    expect(requests.at(-1).query).toEqual(requests[0].query);
    expect(requests.at(-1).cursor).toBeNull();
    await expect(
      page.getByRole("button", { name: "Retry saved create request" }),
    ).toHaveCount(0);
  });
