import { expect, type Page } from "@playwright/test";
export async function appearance(
  page: Page,
  theme: "system" | "light" | "dark",
) {
  const control = page.locator(".theme-control");
  if (!(await control.evaluate((el) => (el as HTMLDetailsElement).open)))
    await control.locator("summary").click();
  await page
    .getByRole("radio", {
      name: theme.slice(0, 1).toUpperCase() + theme.slice(1),
      exact: true,
    })
    .check();
  await control.locator("summary").click();
}
export async function details(page: Page) {
  if (await page.locator('[data-step="choose"]').isVisible())
    await page
      .getByRole("button", { name: "Review songs →", exact: true })
      .click();
  if (await page.locator('[data-step="review"]').isVisible())
    await page
      .getByRole("button", { name: "Playlist details →", exact: true })
      .click();
  await expect(page.locator('[data-step="details"]')).toBeVisible();
}
export async function chooseStep(page: Page) {
  const back = page.getByRole("button", { name: "← Back", exact: true });
  while ((await back.isVisible()) && (await back.isEnabled()))
    await back.click();
  await expect(page.locator('[data-step="choose"]')).toBeVisible();
}
export async function managePlaylist(page: Page) {
  const manage = page.locator(".playlist-manage").first();
  if (!(await manage.evaluate((el) => (el as HTMLDetailsElement).open)))
    await manage.locator("summary").click();
}
export async function syncControls(page: Page) {
  const disclosure = page.locator(".workspace-sync");
  if (!(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open)))
    await disclosure.locator("summary").click();
}
export async function songActions(page: Page) {
  const disclosure = page.locator(".queue-tool-disclosure");
  if (!(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open)))
    await disclosure.locator("summary").click();
}

/** Existing tagging regressions explicitly choose their former entry surface. */
export async function openTaggingWorkspace(page: Page) {
  await page.route("**/api/review", (route) =>
    route.fulfill({
      json: {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revision: "1",
        remaining: 0,
        skipped: 0,
        current: null,
        destinations: [],
        draft: null,
        operation: null,
        undo: null,
        syncStatus: "ready",
        discoveryStatus: "ready",
      },
    }),
  );
  await page.goto("/");
  const mobile = await page.evaluate(
    () => matchMedia("(max-width:640px)").matches,
  );
  const returning = await page.evaluate(
    () => localStorage.getItem("tagger-guidance-dismissed") === "yes",
  );
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("button", {
      name: mobile ? "Make a playlist" : returning ? "Tag queue" : /^Library/,
    })
    .click();
}
