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
    await page.getByRole("button", { name: "Continue →", exact: true }).click();
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
