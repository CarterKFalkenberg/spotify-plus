import { appearance as chooseAppearance } from "./flows";
import { test, expect } from "@playwright/test";
import { assertReadableSurface } from "./visual-assertions";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: { authenticated: false, connection: "disconnected" },
    }),
  );
});

test("appearance follows the system until an explicit choice, persists and applies before render", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(
    page.getByRole("radio", {
      name: "System",
      exact: true,
      includeHidden: true,
    }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await assertReadableSurface(page);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await assertReadableSurface(page);
  await chooseAppearance(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "Dark", exact: true, includeHidden: true }),
  ).toBeChecked();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.getByRole("link", { name: "Privacy", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await assertReadableSurface(page);
  await chooseAppearance(page, "light");
  await assertReadableSurface(page);
  await chooseAppearance(page, "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("invalid or inaccessible storage still allows a working system preference and explicit choice", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("spotify-plus-theme", "invalid");
    Object.defineProperty(Storage.prototype, "setItem", {
      value() {
        throw new Error("storage unavailable");
      },
    });
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(
    page.getByRole("radio", {
      name: "System",
      exact: true,
      includeHidden: true,
    }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await chooseAppearance(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("saved appearance is applied even before the React entry can load", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("spotify-plus-theme", "dark"),
  );
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, (route) => route.abort());
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("#root")).toBeEmpty();
});

test("reading storage can fail without blocking connection or appearance controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, "getItem", {
      value() {
        throw new Error("storage unavailable");
      },
    });
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(
    page.getByRole("radio", {
      name: "System",
      exact: true,
      includeHidden: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("link", { name: "Connect Spotify" }),
  ).toBeVisible();
  await chooseAppearance(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
