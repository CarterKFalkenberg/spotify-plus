import { test, expect, type Page } from "@playwright/test";
const connected = {
  authenticated: true,
  connection: "connected",
  authorizationDeadline: "2027-04-11T12:00:00Z",
  reconnectWarning: null,
};
async function session(page: Page, body: unknown, status = 200) {
  await page.route("**/api/session", (route) =>
    route.fulfill({ status, json: body }),
  );
}
test("private landing has an accessible connection path and responsive layout", async ({
  page,
}) => {
  await session(page, { authenticated: false, connection: "disconnected" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Start with your Spotify" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Connect Spotify" }),
  ).toHaveAttribute("href", "/auth/spotify/start");
  await expect(
    page.getByText("Your Liked Songs are never changed.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("SETUP PREVIEW", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Privacy", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Privacy, plainly." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Terms", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "A personal workspace." }),
  ).toBeVisible();
});
test("unknown callback errors cannot inject text and forbidden access remains honest", async ({
  page,
}) => {
  await session(page, { authenticated: false, connection: "disconnected" });
  await page.goto("/?auth_error=forbidden");
  await expect(page.getByRole("alert")).toContainText(
    "does not identify which check failed",
  );
  await page.goto("/?auth_error=UNTRUSTED_CALLBACK_MESSAGE");
  await expect(page.getByRole("alert")).toContainText(
    "Spotify connection did not finish",
  );
  await expect(page.locator("body")).not.toContainText(
    "UNTRUSTED_CALLBACK_MESSAGE",
  );
});
test("connection failure offers recovery without claiming disconnected", async ({
  page,
}) => {
  await session(page, { error: "temporarily_unavailable" }, 503);
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "couldn’t check your connection",
  );
  await expect(page.getByRole("link", { name: "Connect Spotify" })).toHaveCount(
    0,
  );
  await page.unroute("**/api/session");
  await session(page, connected);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Spotify is connected" }),
  ).toBeVisible();
});
test("renewal warning and expired connection keep an explicit reconnect action", async ({
  page,
}) => {
  await session(page, { ...connected, reconnectWarning: "seven_days" });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("Reconnect soon");
  await expect(
    page.getByRole("link", { name: "Reconnect Spotify" }),
  ).toBeVisible();
  await page.unroute("**/api/session");
  await session(page, {
    ...connected,
    connection: "reconnect",
    reconnectWarning: "required",
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Reconnect to continue" }),
  ).toBeVisible();
});
test("disconnect requires confirmation, sends exact contract, and waits for purge", async ({
  page,
}) => {
  let deleting = false,
    purged = false;
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: deleting
        ? {
            authenticated: false,
            connection: purged ? "disconnected" : "disconnecting",
          }
        : connected,
    }),
  );
  let calls = 0;
  await page.route("**/api/disconnect", async (route) => {
    calls++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      confirmation: "DELETE ALL APP DATA",
    });
    deleting = true;
    await route.fulfill({
      status: 202,
      json: {
        disconnected: true,
        purgeComplete: false,
        connection: "disconnecting",
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Disconnect & delete app data" })
    .click();
  await expect(
    page.getByRole("button", { name: "Keep my data" }),
  ).toBeFocused();
  await expect(page.getByRole("dialog")).toContainText(
    "Your existing Spotify playlists stay.",
  );
  await page.getByRole("button", { name: "Keep my data" }).click();
  expect(calls).toBe(0);
  await expect(
    page.getByRole("button", { name: "Disconnect & delete app data" }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Disconnect & delete app data" })
    .click();
  await page
    .getByRole("button", { name: "Delete all app data", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Finishing data deletion" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Connect Spotify", exact: true }),
  ).toHaveCount(0);
  expect(calls).toBe(1);
  purged = true;
  await expect(
    page.getByRole("heading", { name: "Start with your Spotify" }),
  ).toBeVisible({ timeout: 8000 });
});
test("failed disconnect does not claim deletion", async ({ page }) => {
  await session(page, connected);
  await page.route("**/api/disconnect", (route) =>
    route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Disconnect & delete app data" })
    .click();
  await page
    .getByRole("button", { name: "Delete all app data", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Deletion could not be confirmed",
  );
  await expect(
    page.getByRole("heading", { name: "Spotify is connected" }),
  ).toBeVisible();
});
for (const completed of [false, true]) {
  test(`lost disconnect response reconciles authoritative ${completed ? "disconnected" : "disconnecting"} state`, async ({
    page,
  }) => {
    let committed = false,
      purged = completed,
      calls = 0,
      rechecks = 0;
    await page.route("**/api/session", (route) => {
      if (committed) rechecks++;
      return route.fulfill({
        json: committed
          ? {
              authenticated: false,
              connection: purged ? "disconnected" : "disconnecting",
            }
          : connected,
      });
    });
    await page.route("**/api/disconnect", async (route) => {
      calls++;
      committed = true;
      await route.abort("failed");
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Disconnect & delete app data" })
      .click();
    await page
      .getByRole("button", { name: "Delete all app data", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(rechecks).toBeGreaterThan(0);
    expect(calls).toBe(1);
    if (!completed) {
      await expect(
        page.getByRole("heading", { name: "Finishing data deletion" }),
      ).toBeVisible();
      purged = true;
    }
    await expect(
      page.getByRole("heading", { name: "Start with your Spotify" }),
    ).toBeVisible({ timeout: 8000 });
    expect(calls).toBe(1);
  });
}
test("lost disconnect and unavailable session preserve unconfirmed error", async ({
  page,
}) => {
  let failed = false;
  await page.route("**/api/session", (route) =>
    route.fulfill(
      failed
        ? { status: 503, json: { error: "temporarily_unavailable" } }
        : { json: connected },
    ),
  );
  await page.route("**/api/disconnect", async (route) => {
    failed = true;
    await route.abort("failed");
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Disconnect & delete app data" })
    .click();
  await page
    .getByRole("button", { name: "Delete all app data", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Deletion could not be confirmed",
  );
  await expect(
    page.getByRole("heading", { name: "Finishing data deletion" }),
  ).toHaveCount(0);
});
