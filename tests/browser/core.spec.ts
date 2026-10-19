import { assertReadableSurface, resolvedAppearance } from "./visual-assertions";
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
  if (
    label.startsWith("Add ") &&
    !(await page
      .locator(".preview-panel")
      .evaluate((el) => (el as HTMLDetailsElement).open))
  )
    await page
      .locator(".query-feedback")
      .getByRole("link", { name: "Review songs ↓" })
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
  await page.getByLabel("Group rows").selectOption("none");
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
  ).toEqual([1, 200]);
  expect(calls.filter((call) => call.path === "/api/playlists")).toHaveLength(
    0,
  );
});
test("mobile builder shows cached counts, exclusions, visible month default and explicit publication intent", async ({
  page,
}) => {
  const calls = await mock(page);
  await page.goto("/");
  await builder(page);
  await expect(
    page.getByLabel("Keep this playlist", { exact: true }),
  ).toHaveValue("month");
  await expect(
    page.getByText("Request hidden from profile & search", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Private by default", { exact: true }),
  ).toHaveCount(0);
  await choose(page);
  await expect(page.locator(".query-feedback strong")).toContainText("2 songs");
  await expect(
    page.getByText("0h 6m · from your cached library"),
  ).toBeVisible();
  await expect(page.getByText(/1 unavailable song is excluded/)).toBeVisible();
  await page.getByRole("button", { name: "Create playlist →" }).click();
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
    await page.getByRole("button", { name: "Create playlist →" }).click();
    await lists(page);
    await builder(page);
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
    await builder(page);
    await lists(page);
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
  await page.getByRole("button", { name: "Create playlist →" }).click();
  await expect(
    page.getByRole("button", { name: "Retry saved create request" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Remove Synthetic tag 1 from all" })
    .click();
  await expect(
    page.getByRole("button", { name: "Create playlist →" }),
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
    page.getByRole("button", { name: "Create playlist →" }),
  ).toBeDisabled();
  await expect(page.getByText(/2 of 3 imported/)).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();
  expect(
    calls
      .filter((call) => call.path === "/api/library/sync")
      .map((call) => call.body.reason),
  ).toContain("manual");
  await page.getByRole("button", { name: /^(2 new|New arrivals 2)$/ }).click();
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
    await page.setViewportSize({ width: 1280, height: 800 });
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
test("one deleted stored leaf preserves unrelated query chips and keeps regeneration fail-closed", async ({
  page,
}) => {
  const calls = await mock(page, async (route, path) => {
    if (path === "/api/playlists" && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          playlists: [
            {
              ...playlist(),
              query: {
                version: 1,
                root: {
                  op: "and",
                  children: [
                    { op: "tag", tagId: id(1) },
                    { op: "not", child: { op: "tag", tagId: id(2) } },
                  ],
                },
              },
            },
            {
              ...playlist(2),
              query: { version: 1, root: { op: "tag", tagId: id(2) } },
            },
          ],
          nextCursor: null,
          lastCleanupAt: new Date().toISOString(),
          cleanupBlockedBy: null,
        },
      });
      return true;
    }
    if (
      path === "/api/tags/lookup" &&
      route.request().postDataJSON().tagIds.includes(id(1))
    ) {
      await route.fulfill({ status: 409, json: { error: "unknown_tag" } });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await lists(page);
  const cards = page.locator(".playlist-card");
  await expect(cards.first().locator(".query-summary")).toHaveText(
    "(Deleted tag + NOT Synthetic tag 2)",
  );
  await expect(cards.last().locator(".query-summary .chip")).toHaveText(
    "Synthetic tag 2",
  );
  await expect(
    cards.first().getByRole("button", { name: "Regenerate" }),
  ).toBeDisabled();
  await expect(
    cards.last().getByRole("button", { name: "Regenerate" }),
  ).toBeEnabled();
  expect(calls.filter((call) => call.path.endsWith("/actions"))).toHaveLength(
    0,
  );
});
test("transient query-label failure remains retryable and does not disable a valid stored query", async ({
  page,
}) => {
  let offline = true;
  await mock(page, async (route, path) => {
    if (path !== "/api/tags/lookup" || !offline) return false;
    await route.fulfill({ status: 503, json: { error: "unavailable" } });
    return true;
  });
  await page.goto("/");
  await lists(page);
  await expect(page.locator(".query-summary")).toHaveText("Unavailable tag");
  await expect(
    page.getByRole("button", { name: "Regenerate", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("alert")).toContainText("Refresh playlists");
  offline = false;
  await page
    .getByRole("button", { name: "Refresh playlists", exact: true })
    .click();
  await expect(page.locator(".query-summary .chip")).toHaveText(
    "Synthetic tag 1",
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
    if (zero)
      await expect(
        page.getByText(
          "No songs have this combination of tags. Try removing a requirement.",
          { exact: true },
        ),
      ).toBeVisible();
    else
      await expect(page.locator(".query-feedback strong")).toContainText(
        "1 songs",
      );
    await expect(
      page.getByRole("button", { name: "Create playlist →" }),
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
    page.getByRole("button", { name: "Create playlist →" }),
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
    await expect(page.locator(".query-feedback strong")).toContainText(
      "2 songs",
    );
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
  await page.getByLabel("Group rows").selectOption("none");
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
                taggedCount: currentRevision.library === "2" ? 1 : 0,
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
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Select all 3 matching" }).click();
  const input = page.getByLabel("Add tag to selection", { exact: true });
  await input.fill("Frozen filter draft");
  const before = searches;
  currentRevision = { library: "2", annotations: "2" };
  await page.clock.runFor(61_000);
  await expect.poll(() => searches, { timeout: 10000 }).toBeGreaterThan(before);
  // A request starting is not proof its revision has rendered. Wait for the
  // refreshed result while retaining the old frozen selection and typed draft.
  await expect(page.locator(".artist-card").first()).toContainText(
    "3 songs · 1 tagged",
  );
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
      page.getByRole("button", { name: "Create playlist →" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Retry preview", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Create playlist →" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Create playlist →" }),
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

test("idle polling is bounded, hidden views stay quiet, and returning to the page refreshes immediately", async ({
  page,
}) => {
  const calls = await mock(page);
  await page.clock.install();
  await page.goto("/");
  await lists(page);
  await expect(page.locator(".query-summary")).toHaveText("Synthetic tag 1");
  await page.clock.runFor(1000);
  const count = (path: string) =>
    calls.filter((call) => call.path === path).length;
  const listReads = count("/api/playlists"),
    lookups = count("/api/tags/lookup");
  await page.clock.runFor(55_000);
  expect(count("/api/playlists")).toBe(listReads);
  await page.clock.runFor(10_000);
  // The timer runs in the page; request interception is delivered asynchronously
  // to the test process after the clock command returns.
  await expect.poll(() => count("/api/playlists")).toBe(listReads + 1);
  expect(count("/api/tags/lookup")).toBe(lookups);
  await builder(page);
  const hiddenLists = count("/api/playlists");
  await page.clock.runFor(120_000);
  expect(count("/api/playlists")).toBe(hiddenLists);
  await lists(page);
  await expect.poll(() => count("/api/playlists")).toBe(hiddenLists + 1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenCalls = calls.length;
  await page.clock.runFor(120_000);
  expect(calls).toHaveLength(hiddenCalls);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => count("/api/playlists")).toBe(hiddenLists + 2);
  await expect.poll(() => count("/api/tags/lookup")).toBeGreaterThan(lookups);
});

test("internal navigation preserves builder and playlist retention drafts and preview scroll", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/");
  await builder(page);
  await choose(page);
  await expect(page.locator(".query-feedback strong")).toContainText("2 songs");
  await page
    .getByLabel("Playlist name", { exact: true })
    .fill("My synthetic draft");
  await page
    .getByLabel("Keep this playlist", { exact: true })
    .selectOption("week");
  const scroll = await page.locator(".preview-tracks").evaluate((element) => {
    const html = element as HTMLElement;
    html.style.height = "30px";
    html.style.overflow = "auto";
    html.scrollTop = 10;
    return html.scrollTop;
  });
  expect(scroll).toBeGreaterThan(0);
  await lists(page);
  await page.locator(".retention-settings summary").click();
  await page
    .getByLabel("Extend / Unpin for", { exact: true })
    .selectOption("threeMonths");
  await builder(page);
  await expect(page.getByLabel("Playlist name", { exact: true })).toHaveValue(
    "My synthetic draft",
  );
  await expect(
    page.getByLabel("Keep this playlist", { exact: true }),
  ).toHaveValue("week");
  await expect(
    page.getByRole("button", { name: "Remove Synthetic tag 1 from all" }),
  ).toBeVisible();
  expect(
    await page
      .locator(".preview-tracks")
      .evaluate((element) => element.scrollTop),
  ).toBe(scroll);
  await lists(page);
  await expect(
    page.getByLabel("Extend / Unpin for", { exact: true }),
  ).toHaveValue("threeMonths");
});

test("vocabulary rename invalidates cached playlist labels with unchanged IDs", async ({
  page,
}) => {
  let name = "Synthetic tag 1";
  await mock(page, async (route, path) => {
    if (path === "/api/tags/lookup") {
      await route.fulfill({ json: { revision, tags: [{ ...tag(), name }] } });
      return true;
    }
    if (path === "/api/tags/manage-preview" || path === "/api/tags/manage") {
      if (path === "/api/tags/manage")
        name = route.request().postDataJSON().name;
      await route.fulfill({
        json: {
          revision,
          assignmentCount: 3,
          activeTrackCount: 3,
          unionCount: 3,
          collisionTag: null,
          ...(path === "/api/tags/manage"
            ? { actionId: id(400), changedCount: 3, tag: { ...tag(), name } }
            : {}),
        },
      });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await lists(page);
  await expect(page.locator(".query-summary .chip")).toHaveText(name);
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", { name: "Tags", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Manage Synthetic tag 1", exact: true })
    .click();
  await page
    .getByLabel("New tag name", { exact: true })
    .fill("Synthetic renamed tag");
  await page
    .getByRole("button", { name: "Preview rename", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm change", exact: true })
    .click();
  await lists(page);
  await expect(page.locator(".query-summary .chip")).toHaveText(
    "Synthetic renamed tag",
  );
});

test("playlist expiry countdown uses dates and preserves pinned and overdue states", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-14T16:00:00Z") });
  await mock(page, async (route, path) => {
    if (path !== "/api/playlists" || route.request().method() !== "GET")
      return false;
    await route.fulfill({
      json: {
        playlists: [
          { ...playlist(), expiresOn: "2026-10-15" },
          { ...playlist(2), expiresOn: "2026-10-14" },
          { ...playlist(3), expiresOn: "2026-10-13" },
          { ...playlist(4), expiresOn: null, retention: "pinned" },
        ],
        nextCursor: null,
        lastCleanupAt: new Date().toISOString(),
        cleanupBlockedBy: null,
      },
    });
    return true;
  });
  await page.goto("/");
  await lists(page);
  await expect(page.locator(".expiry")).toHaveText([
    "Expires in 1 day · Keep through Oct 15, 2026",
    "Expires today · Keep through Oct 14, 2026",
    "Expired — will be removed",
    "Pinned · never expires",
  ]);
});

test("foreground status revisions invalidate second-client rename and deletion without focus or local edits", async ({
  page,
}) => {
  let annotations = "1",
    name = "Synthetic tag 1",
    deleted = false;
  const calls = await mock(
    page,
    async (route, path) => {
      if (path === "/api/tags/lookup") {
        await route.fulfill(
          deleted
            ? { status: 409, json: { error: "unknown_tag" } }
            : {
                json: {
                  revision: { library: "1", annotations },
                  tags: [{ ...tag(), name }],
                },
              },
        );
        return true;
      }
      return false;
    },
    { revision: () => ({ library: "1", annotations }) },
  );
  await page.clock.install();
  await page.goto("/");
  await lists(page);
  await expect(page.locator(".query-summary .chip")).toHaveText(name);
  await page.clock.runFor(1000);
  const before = calls.filter(
    (call) => call.path === "/api/tags/lookup",
  ).length;
  name = "Synthetic second-client rename";
  annotations = "2";
  await page.clock.runFor(61_000);
  await expect(page.locator(".query-summary .chip")).toHaveText(name);
  expect(
    calls.filter((call) => call.path === "/api/tags/lookup").length,
  ).toBeGreaterThan(before);
  deleted = true;
  annotations = "3";
  await page.clock.runFor(61_000);
  await expect(page.locator(".query-summary .chip")).toHaveText("Deleted tag");
  await expect(
    page.getByRole("button", { name: "Regenerate", exact: true }),
  ).toBeDisabled();
});

test("identical progress responses do not abort and repeat an in-flight label lookup", async ({
  page,
}) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  await mock(page, async (route, path) => {
    if (path === "/api/playlists" && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          playlists: [{ ...playlist(), status: "pending" }],
          nextCursor: null,
          lastCleanupAt: new Date().toISOString(),
          cleanupBlockedBy: null,
        },
      });
      return true;
    }
    if (path === "/api/tags/lookup") {
      lookups++;
      await waiting;
      await route
        .fulfill({ json: { revision, tags: [tag()] } })
        .catch(() => {});
      return true;
    }
    return false;
  });
  await page.clock.install();
  await page.goto("/");
  await lists(page);
  await expect.poll(() => lookups).toBe(1);
  await page.clock.runFor(11_000);
  expect(lookups).toBe(1);
  release();
  await expect(page.locator(".query-summary .chip")).toHaveText(
    "Synthetic tag 1",
  );
});

test("a slow successful label retry survives progress polls after its initial failure", async ({
  page,
}) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0,
    playlistReads = 0;
  await mock(page, async (route, path) => {
    if (path === "/api/playlists" && route.request().method() === "GET") {
      playlistReads++;
      await route.fulfill({
        json: {
          playlists: [{ ...playlist(), status: "pending" }],
          nextCursor: null,
          lastCleanupAt: new Date().toISOString(),
          cleanupBlockedBy: null,
        },
      });
      return true;
    }
    if (path === "/api/tags/lookup") {
      lookups++;
      if (lookups === 1) {
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
      } else {
        await waiting;
        await route
          .fulfill({ json: { revision, tags: [tag()] } })
          .catch(() => {});
      }
      return true;
    }
    return false;
  });
  await page.clock.install();
  await page.goto("/");
  await lists(page);
  await expect(page.locator(".query-summary .chip")).toHaveText(
    "Unavailable tag",
  );
  await page.clock.runFor(6_000);
  await expect.poll(() => lookups).toBe(2);
  const before = playlistReads;
  await page.clock.runFor(11_000);
  await expect.poll(() => playlistReads).toBeGreaterThan(before);
  expect(lookups).toBe(2);
  release();
  await expect(page.locator(".query-summary .chip")).toHaveText(
    "Synthetic tag 1",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.clock.runFor(6_000);
  expect(lookups).toBe(2);
});

test("creation offers a direct confirmed-request progress path and feedback stays beside bucket editing", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/");
  await builder(page);
  await expect(
    page.getByRole("button", { name: "Tag your library →" }),
  ).toBeVisible();
  await choose(page);
  const feedback = page.locator(".query-feedback");
  await expect(feedback).toContainText("2 songs");
  await expect(feedback).toContainText("1 unavailable song excluded");
  await page.getByRole("button", { name: "Create playlist →" }).click();
  await page.getByRole("button", { name: "View playlist progress →" }).click();
  await expect(
    page.getByRole("heading", { name: "Your playlists", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("button", { name: "Your playlists" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("cleanup delay appears only after a loaded response and retention consequences stay beside actions", async ({
  page,
}) => {
  const pending = { release: null as (() => void) | null };
  await mock(page, async (route, path) => {
    if (path !== "/api/playlists") return false;
    await new Promise<void>((resolve) => {
      pending.release = resolve;
    });
    await route.fulfill({
      json: {
        playlists: [playlist()],
        nextCursor: null,
        lastCleanupAt: null,
        cleanupBlockedBy: null,
      },
    });
    return true;
  });
  await page.goto("/");
  await lists(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Loading playlists" }),
  ).toBeVisible();
  await expect(page.getByText(/Cleanup may be delayed/)).toHaveCount(0);
  pending.release?.();
  await expect(page.getByText(/Cleanup may be delayed/)).toBeVisible();
  await expect(page.locator(".retention-hint")).toContainText(
    "1 calendar month from today",
  );
  await page.locator(".retention-settings summary").click();
  await page
    .getByLabel("Extend / Unpin for", { exact: true })
    .selectOption("week");
  await expect(page.locator(".retention-hint")).toContainText(
    "1 week from today",
  );
});

for (const width of [320, 360, 390, 430, 768, 1280])
  test(`workspace reflows at ${width}px with long synthetic text and visible focus`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mock(page, async (route, path) => {
      if (path !== "/api/tags") return false;
      await route.fulfill({
        json: {
          tags: [
            {
              ...tag(),
              name: "mood:A very long synthetic tag for checking narrow layouts",
            },
          ],
          hasMore: false,
          revision,
        },
      });
      return true;
    });
    await page.goto("/");
    await builder(page);
    await page.getByLabel("Add All of tag", { exact: true }).fill("mood:");
    await page.getByRole("option", { name: /^mood:A very long/ }).click();
    await expect(page.locator(".query-feedback")).toContainText("2 songs");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByLabel("Playlist name", { exact: true }).focus();
    expect(
      await page
        .getByLabel("Playlist name", { exact: true })
        .evaluate((el) => getComputedStyle(el).outlineStyle),
    ).not.toBe("none");
    if (width === 320 && process.env.UX_CAPTURE) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: ".local/ux/mobile-320-long-tags.png",
        fullPage: true,
      });
    }
    await lists(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test("synthetic UX captures", async ({ page, isMobile }) => {
  test.skip(
    !process.env.UX_CAPTURE,
    "Opt-in local synthetic visual inspection",
  );
  await mock(page);
  await page.goto("/");
  if (!isMobile) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await library(page);
    await expect(page.locator(".artist-card")).toBeVisible();
    expect(
      await page
        .getByLabel("Tag all 3 songs by Synthetic Artist")
        .evaluate((el) => el.getBoundingClientRect().bottom + scrollY),
    ).toBeLessThan(800);
    await page.screenshot({
      path: ".local/ux/desktop-first-run.png",
      fullPage: true,
    });
    await page.getByLabel("Group rows").selectOption("none");
    await expect(page.locator(".track-row").first()).toBeVisible();
    await page.screenshot({
      path: ".local/ux/desktop-library.png",
      fullPage: true,
    });
  }
  await builder(page);
  await choose(page);
  await expect(page.locator(".query-feedback")).toContainText("2 songs");
  if (isMobile) await page.locator(".preview-panel > summary").click();
  await page.getByLabel("Playlist name", { exact: true }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `.local/ux/${isMobile ? "mobile" : "desktop"}-builder.png`,
    fullPage: true,
  });
  await page.screenshot({
    path: `.local/ux/${isMobile ? "mobile" : "desktop"}-builder-viewport.png`,
  });
  await lists(page);
  await expect(page.locator(".playlist-card")).toBeVisible();
  await page.screenshot({
    path: `.local/ux/${isMobile ? "mobile" : "desktop"}-playlists.png`,
    fullPage: true,
  });
});

for (const appearance of ["light", "dark"] as const)
  for (const width of [320, 390, 1280])
    test(`working surfaces retain readable text and identifying fields at ${width}px in ${appearance} mode`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mock(page);
      await page.goto("/");
      await page
        .getByLabel("Appearance", { exact: true })
        .selectOption(appearance);
      await page
        .getByRole("navigation", { name: "Workspace" })
        .getByRole("button", { name: /^Library/ })
        .click();
      if (width === 1280)
        await expect(page.locator(".artist-card")).toBeVisible();
      else await expect(page.getByLabel("Search your library")).toBeVisible();
      await assertReadableSurface(page);
      if (width === 1280) {
        await page.getByLabel("Group rows").selectOption("none");
        await page.getByLabel("Select Synthetic song 1").check();
        await expect(page.locator(".bulk-bar")).toBeVisible();
        await assertReadableSurface(page);
      }
      await builder(page);
      await expect(
        page.getByRole("heading", { name: "All of", exact: true }),
      ).toBeVisible();
      await assertReadableSurface(page);
      const information = await resolvedAppearance(
        page.getByText("Request hidden from profile & search", { exact: true }),
      );
      await page
        .getByLabel("Add All of tag", { exact: true })
        .fill("Synthetic");
      await expect(
        page.locator(".suggestions [role=option]").first(),
      ).toBeVisible();
      await assertReadableSurface(page);
      await page.locator(".suggestions [role=option]").first().click();
      await expect(page.locator(".query-feedback")).toContainText("2 songs");
      await assertReadableSurface(page);
      await lists(page);
      await expect(page.locator(".playlist-card")).toBeVisible();
      await expect(page.getByText("Resolving query tags…")).toHaveCount(0);
      await assertReadableSurface(page);
      expect(await resolvedAppearance(page.locator(".pill.ready"))).not.toEqual(
        information,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });

for (const width of [320, 390])
  test(`connected header separates home and account targets at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mock(page);
    await page.goto("/");
    await expect(
      page.getByRole("navigation", { name: "Workspace" }),
    ).toBeVisible();
    const home = await page
      .getByRole("link", { name: "Spotify Plus home" })
      .boundingBox();
    const account = page.locator(".account-details summary");
    const target = await account.boundingBox();
    expect(home).not.toBeNull();
    expect(target).not.toBeNull();
    expect(
      home!.x + home!.width <= target!.x ||
        target!.x + target!.width <= home!.x ||
        home!.y + home!.height <= target!.y ||
        target!.y + target!.height <= home!.y,
    ).toBe(true);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    expect(target!.x).toBeGreaterThanOrEqual(0);
    expect(target!.x + target!.width).toBeLessThanOrEqual(width);
    await account.click();
    await expect(page.locator(".account-details")).toHaveAttribute("open", "");
  });

for (const width of [320, 390])
  test(`phone task and first playlist action stay above navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mock(page);
    await page.goto("/");
    await lists(page);
    const heading = await page
      .getByRole("heading", { name: "Your playlists", exact: true })
      .boundingBox();
    expect(heading).not.toBeNull();
    expect(heading!.y).toBeLessThanOrEqual(150);
    const open = await page
      .locator(".playlist-card")
      .first()
      .getByRole("link", { name: "Open in Spotify ↗" })
      .boundingBox();
    const nav = await page
      .getByRole("navigation", { name: "Workspace" })
      .boundingBox();
    expect(open).not.toBeNull();
    expect(nav).not.toBeNull();
    expect(open!.y + open!.height).toBeLessThan(nav!.y);
    await expect(page.locator(".retention-settings summary")).toContainText(
      "1 calendar month",
    );
    await page.locator(".retention-settings summary").click();
    await page
      .getByLabel("Extend / Unpin for", { exact: true })
      .selectOption("week");
    await expect(page.locator(".retention-settings summary")).toContainText(
      "1 week",
    );
    await page.locator(".retention-settings summary").click();
    await expect(page.locator(".retention-hint").first()).toContainText(
      "1 week",
    );
  });
