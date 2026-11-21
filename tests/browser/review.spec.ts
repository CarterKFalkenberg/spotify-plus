import { test, expect, type Page } from "@playwright/test";
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trackKey = "a".repeat(64);
const destination = (n: number) => ({
  id: String(n).padStart(22, "a"),
  name: `Synthetic destination ${n}`,
  artworkUrl: null,
  spotifyUrl: `https://open.spotify.com/playlist/${String(n).padStart(22, "a")}`,
  configured: true,
  available: true,
  membership: n === 1 ? "present" : "absent",
  errorCode: null,
});
const song = {
  trackKey,
  tagIds: [],
  metadata: {
    title: "Synthetic oldest track",
    artists: [{ id: "a".repeat(22), name: "Synthetic Artist" }],
    album: "Synthetic album",
    releaseDate: "2004",
    durationMs: 180000,
    explicit: false,
    artworkUrl: null,
    spotifyUrl: `https://open.spotify.com/track/${"a".repeat(22)}`,
    playableUri: `spotify:track:${"a".repeat(22)}`,
    likedAt: "2025-01-01T00:00:00Z",
    removedAt: null,
    acknowledgedAt: null,
  },
};
function initial() {
  return {
    sessionId: uuid,
    revision: "1",
    remaining: 4,
    skipped: 0,
    current: song as typeof song | null,
    destinations: Array.from({ length: 16 }, (_, i) => destination(i + 1)),
    draft: null as {
      trackKey: string;
      revision: string;
      destinationIds: string[];
    } | null,
    operation: null as any,
    undo: null as any,
    syncStatus: "ready",
    discoveryStatus: "ready",
  };
}
async function fixture(
  page: Page,
  options: {
    empty?: boolean;
    ambiguous?: boolean;
    conflict?: boolean;
    incompleteUndo?: boolean;
  } = {},
) {
  let data = initial(),
    ambiguous = !!options.ambiguous;
  if (options.empty) data.destinations = [];
  const calls: { path: string; body: any }[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4173") return route.abort();
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const body = route.request().postData()
      ? route.request().postDataJSON()
      : null;
    calls.push({ path, body });
    let json: unknown;
    if (path === "/api/session")
      json = {
        authenticated: true,
        connection: "connected",
        authorizationDeadline: "2027-04-11T00:00:00Z",
        reconnectWarning: null,
      };
    else if (path === "/api/diagnostics") json = { accepted: true };
    else if (path === "/api/playback/token")
      return route.fulfill({
        status: 503,
        json: { error: "playback_required" },
      });
    else if (path === "/api/library/status" || path === "/api/library/sync")
      json = {
        revision: { library: "1", annotations: "1" },
        initialSyncComplete: true,
        syncPhase: "idle",
        importedCount: 4,
        reportedTotal: 4,
        activeCount: 4,
        untaggedCount: 4,
        newCount: 0,
        lastCompletedAt: null,
        blockedBy: null,
      };
    else if (path === "/api/review") json = data;
    else if (path === "/api/review/destinations" && !body)
      json = {
        revision: data.revision,
        items: Array.from({ length: 20 }, (_, i) => ({
          ...destination(i + 1),
          configured: data.destinations.some(
            (d) => d.id === destination(i + 1).id,
          ),
        })),
        discoveryStatus: "ready",
      };
    else if (path.startsWith("/api/review/")) {
      if (options.conflict && path.endsWith("/draft"))
        return route.fulfill({
          status: 409,
          json: { error: "stale_revision" },
        });
      if (path.endsWith("/draft"))
        data.draft = {
          trackKey,
          revision: data.revision,
          destinationIds: body.destinationIds,
        };
      if (path.endsWith("/destinations"))
        data.destinations = body.destinationIds.map((id: string) => ({
          ...destination(parseInt(id.replaceAll("a", ""))),
          configured: true,
        }));
      if (path.endsWith("/skip")) {
        data.current = null;
        data.skipped++;
      }
      if (path.endsWith("/session")) {
        data.current = song;
        data.skipped = 0;
      }
      if (path.endsWith("/done") || path.endsWith("/discard")) {
        data.undo = {
          id: uuid,
          trackKey,
          kind: path.endsWith("/done") ? "done" : "discard",
          status: "completed",
          errorCode: null,
          completedDestinations: 1,
          totalDestinations: 1,
          reversalIncomplete: false,
        };
        data.current = null;
        data.operation = data.undo;
        if (ambiguous) {
          ambiguous = false;
          return route.abort();
        }
      }
      if (path.endsWith("/undo")) {
        data.current = song;
        data.operation = {
          ...data.undo,
          status: "undone",
          reversalIncomplete: !!options.incompleteUndo,
        };
        data.undo = null;
      }
      if (path.endsWith("/cancel")) {
        data.operation = null;
        data.current = song;
        // A confirmed addition survives returning to the saved review draft.
        data.destinations[1]!.membership = "present";
      }
      data = { ...data, revision: String(Number(data.revision) + 1) };
      json = data;
    } else
      return route.fulfill({ status: 503, json: { error: "unavailable" } });
    return route.fulfill({ json });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Liked Songs review", exact: true }),
  ).toBeVisible();
  return { calls, data: () => data };
}
test("default review offers recognizable destinations and saves drafts before Done on phone and desktop", async ({
  page,
}, info) => {
  const { calls } = await fixture(page);
  await expect(
    page.getByRole("button", { name: "Review likes" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "Synthetic oldest track" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Synthetic oldest track" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Enable playback" }),
  ).toBeInViewport();
  await expect(
    page.locator(".review-destination").first().getByRole("checkbox"),
  ).toBeDisabled();
  await expect(page.locator(".review-destination").first()).toContainText(
    "Already added",
  );
  await page
    .locator(".review-destination")
    .nth(1)
    .getByRole("checkbox")
    .check();
  await expect(
    page.getByText("Choices saved. Spotify changes only after Done."),
  ).toBeVisible();
  expect(
    calls
      .filter((c) => c.path.startsWith("/api/review/") && c.body)
      .map((c) => c.path),
  ).toEqual(["/api/review/draft"]);
  await page.reload();
  await expect(
    page.locator(".review-destination").nth(1).getByRole("checkbox"),
  ).toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("synthetic-review.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Undo most recent" }),
  ).toBeVisible();
  expect(calls.find((c) => c.path.endsWith("/done"))!.body).toEqual({
    revision: "2",
    trackKey,
    requestId: expect.any(String),
  });
});
test("empty configuration starts explicit; selection does not change Sources or complete a track", async ({
  page,
}) => {
  const { calls } = await fixture(page, { empty: true });
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Set up destinations" }).click();
  await expect(page.locator(".review-configuration input:checked")).toHaveCount(
    0,
  );
  await page.getByLabel("Find a destination").fill("Synthetic destination 12");
  await page.locator(".review-configuration").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save destinations" }).click();
  await expect(page.locator(".review-choices")).toContainText(
    "Synthetic destination 12",
  );
  expect(
    calls.filter(
      (c) =>
        c.body &&
        (c.path.includes("/sources") ||
          c.path.endsWith("/done") ||
          c.path.endsWith("/discard")),
    ),
  ).toEqual([]);
});
test("Skip persists across reload, new session returns it, and Discard requires confirmation", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "All set for this session" }),
  ).toBeVisible();
  await page.locator(".review-session summary").click();
  await page.getByRole("button", { name: "Start new session" }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  expect(calls.some((c) => c.path.endsWith("/discard"))).toBe(false);
  await page.getByRole("button", { name: "Keep reviewing" }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.getByRole("button", { name: "Confirm Discard" }).click();
  await expect(
    page.getByRole("button", { name: "Undo most recent" }),
  ).toBeVisible();
  expect(
    calls.find((c) => c.path.endsWith("/discard"))!.body.confirmation,
  ).toBe(true);
});
test("ambiguous completion retries the identical persisted intent after reload", async ({
  page,
}) => {
  const { calls } = await fixture(page, { ambiguous: true });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry saved action" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Check saved action" }).click();
  await expect(
    page.getByRole("button", { name: "Check saved action" }),
  ).toHaveCount(0);
  const writes = calls.filter((c) => c.path.endsWith("/done"));
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toEqual(writes[1]!.body);
});
test("stale draft never overwrites local choices silently or sends Done; recovery is explicit", async ({
  page,
}) => {
  const { calls } = await fixture(page, { conflict: true });
  await page
    .locator(".review-destination")
    .nth(1)
    .getByRole("checkbox")
    .check();
  await expect(page.getByRole("alert")).toContainText("another device");
  await expect(
    page.locator(".review-destination").nth(1).getByRole("checkbox"),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  expect(calls.some((c) => c.path.endsWith("/done"))).toBe(false);
  await page.getByRole("button", { name: "Reload saved review" }).click();
  await expect(
    page.locator(".review-destination").nth(1).getByRole("checkbox"),
  ).not.toBeChecked();
});
test("incomplete Undo explains preserved changes and restores the exact track", async ({
  page,
}) => {
  await fixture(page, { incompleteUndo: true });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Undo most recent" }).click();
  await expect(
    page.getByText("Some playlist changes could not safely be reversed.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Synthetic oldest track" }),
  ).toBeVisible();
});

test("unknown memberships and unavailable selected destinations never unlock Done", async ({
  page,
}) => {
  const f = await fixture(page);
  f.data().destinations.forEach((d) => (d.membership = "absent"));
  f.data().destinations[1]!.membership = "checking";
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".review-destination").nth(1)).toContainText(
    "Checking membership",
  );
  f.data().destinations[1]!.membership = "unavailable";
  f.data().destinations[1]!.available = false;
  f.data().draft = {
    trackKey,
    revision: "1",
    destinationIds: [destination(2).id],
  };
  await page.reload();
  await expect(page.locator(".review-destination").nth(1)).toContainText(
    "Unavailable",
  );
  await expect(
    page.locator(".review-destination").nth(1).getByRole("checkbox"),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  expect(f.calls.some((c) => c.path.endsWith("/done"))).toBe(false);
});

test("in-flight progress survives reload and incomplete work offers truthful recovery", async ({
  page,
}) => {
  const f = await fixture(page);
  f.data().operation = {
    id: uuid,
    trackKey,
    kind: "done",
    status: "adding",
    errorCode: null,
    completedDestinations: 1,
    totalDestinations: 2,
    reversalIncomplete: false,
  };
  await page.reload();
  await expect(
    page.getByText("Adding to playlists · 1 of 2 confirmed"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Done", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Skip for now" }),
  ).toBeDisabled();
  f.data().operation.status = "needs_attention";
  await page.reload();
  await expect(
    page.getByText("This action is incomplete.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry incomplete action" }),
  ).toBeEnabled();
  expect(
    f.calls.filter((c) => c.body && c.path.startsWith("/api/review/")),
  ).toHaveLength(0);
});

for (const canCancel of [false, true])
  test(`return to review requires settled server permission (${canCancel}) and preserves confirmed additions`, async ({
    page,
  }) => {
    const f = await fixture(page);
    f.data().operation = {
      id: uuid,
      trackKey,
      kind: "done",
      status: "needs_attention",
      errorCode: "destination_unavailable",
      completedDestinations: 1,
      totalDestinations: 2,
      reversalIncomplete: false,
      canCancel,
    };
    f.data().draft = {
      trackKey,
      revision: "1",
      destinationIds: [destination(2).id],
    };
    await page.reload();
    const back = page.getByRole("button", {
      name: "Return to review",
      exact: true,
    });
    if (!canCancel) {
      await expect(back).toBeDisabled();
      await expect(
        page.getByText("Return to review is unavailable", { exact: false }),
      ).toBeVisible();
      expect(
        f.calls.filter((c) => c.body && c.path.startsWith("/api/review/")),
      ).toEqual([]);
      return;
    }
    await expect(back).toBeEnabled();
    await expect(
      page.getByText("This action has not sent an unlike.", { exact: false }),
    ).toBeVisible();
    await back.click();
    await expect(
      page.getByRole("heading", { name: "Synthetic oldest track" }),
    ).toBeVisible();
    await expect(page.locator(".review-destination").nth(1)).toContainText(
      "Already added",
    );
    await expect(
      page.locator(".review-destination").nth(1).getByRole("checkbox"),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Skip for now" }),
    ).toBeEnabled();
    expect(
      f.calls.filter((c) => c.body && c.path.startsWith("/api/review/")),
    ).toEqual([
      {
        path: "/api/review/cancel",
        body: { revision: "1", operationId: uuid },
      },
    ]);
  });

for (const width of [320, 390])
  test(`review choices and persistent actions reflow at ${width}px with 200% text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 740 });
    await fixture(page);
    await page.evaluate(() => {
      const entries = [...document.querySelectorAll("*")]
        .filter((e): e is HTMLElement => e instanceof HTMLElement)
        .map((e) => ({ e, size: parseFloat(getComputedStyle(e).fontSize) }));
      for (const { e, size } of entries)
        if (Number.isFinite(size) && size > 0)
          e.style.fontSize = `${size * 2}px`;
    });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    const done = page.getByRole("button", { name: "Done", exact: true });
    await done.scrollIntoViewIfNeeded();
    await expect(done).toBeInViewport();
    await expect
      .poll(async () => {
        const action = await done.boundingBox(),
          nav = await page.locator(".workspace-tabs").boundingBox();
        return (
          !!action &&
          !!nav &&
          action.y >= 0 &&
          action.y + action.height <= nav.y
        );
      })
      .toBe(true);
  });

for (const { width, height } of [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
])
  test(`phone opening controls and first destination are unobstructed at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await fixture(page);
    const playback = page.getByRole("button", { name: "Enable playback" });
    await expect(playback).toBeVisible();
    const firstDestination = page.locator(".review-destination").first();
    await page.screenshot({
      path: info.outputPath(`synthetic-review-viewport-${width}.png`),
    });
    for (const [target, boundary] of [
      [playback, page.locator(".review-actions")],
      [firstDestination, page.locator(".review-actions")],
      ...["Skip for now", "Discard", "Done"].map((name) => [
        page.getByRole("button", { name, exact: true }),
        page.locator(".workspace-tabs"),
      ]),
    ]) {
      await expect
        .poll(async () => {
          const box = await target!.boundingBox();
          const actions = await boundary!.boundingBox();
          if (!box || !actions || box.y < 0 || box.y + box.height > actions.y)
            return false;
          return target!.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return [0.1, 0.5, 0.9].every((fraction) => {
              const hit = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height * fraction,
              );
              return !!hit && (hit === element || element.contains(hit));
            });
          });
        })
        .toBe(true);
    }
  });
