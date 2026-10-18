import { expect, type Locator, type Page } from "@playwright/test";

// Measure resolved browser styles, including ancestor surfaces and text opacity.
// This asserts contrast outcomes without pinning token names or exact colours.
export async function assertReadableSurface(page: Page) {
  const failures = await page.evaluate(() => {
    type Colour = [number, number, number, number];
    const colour = (value: string): Colour => {
      const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const over = (top: Colour, bottom: Colour): Colour =>
      [
        ...top
          .slice(0, 3)
          .map((v, i) => v * top[3] + bottom[i]! * (1 - top[3])),
        1,
      ] as Colour;
    const surface = (el: Element | null): Colour => {
      if (!el) return [255, 255, 255, 1];
      return over(
        colour(getComputedStyle(el).backgroundColor),
        surface(el.parentElement),
      );
    };
    const luminance = (c: Colour) =>
      c.slice(0, 3).reduce((total, value, i) => {
        const s = value / 255;
        return (
          total +
          (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) *
            [0.2126, 0.7152, 0.0722][i]!
        );
      }, 0);
    const ratio = (a: Colour, b: Colour) => {
      const x = luminance(a),
        y = luminance(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const visible = (el: Element) =>
      el.getClientRects().length > 0 &&
      !el.closest('[hidden], :disabled, [aria-disabled="true"]');
    const failures: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const node = walker.currentNode,
        el = node.parentElement;
      if (!el || !node.textContent?.trim() || !visible(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (!range.getBoundingClientRect().width) continue;
      const style = getComputedStyle(el),
        size = parseFloat(style.fontSize);
      // Large decorative art and headings have separate WCAG thresholds.
      if ((size >= 18.66 && Number(style.fontWeight) >= 700) || size >= 24)
        continue;
      let opacity = 1;
      for (let p: Element | null = el; p; p = p.parentElement)
        opacity *= Number(getComputedStyle(p).opacity);
      const bg = surface(el),
        fg = colour(style.color);
      fg[3] *= opacity;
      const contrast = ratio(over(fg, bg), bg);
      if (contrast < 4.5)
        failures.push(
          `Text “${node.textContent.trim().slice(0, 60)}”: ${contrast}`,
        );
    }
    for (const el of document.querySelectorAll(
      'input:not([type="checkbox"]), select',
    )) {
      if (!visible(el)) continue;
      const style = getComputedStyle(el),
        border = colour(style.borderTopColor);
      for (const bg of [surface(el), surface(el.parentElement)]) {
        const contrast = ratio(over(border, bg), bg);
        if (contrast < 3)
          failures.push(
            `Field boundary ${el.getAttribute("aria-label") ?? el.tagName}: ${contrast}`,
          );
      }
      const bg = surface(el),
        text = ratio(over(colour(style.color), bg), bg);
      if (text < 4.5) failures.push(`Field text: ${text}`);
      if (el instanceof HTMLInputElement && el.placeholder) {
        const placeholder = getComputedStyle(el, "::placeholder"),
          fg = colour(placeholder.color);
        fg[3] *= Number(placeholder.opacity);
        const contrast = ratio(over(fg, bg), bg);
        if (contrast < 4.5) failures.push(`Placeholder: ${contrast}`);
      }
    }
    return failures;
  });
  expect(failures).toEqual([]);
}

export async function resolvedAppearance(locator: Locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      colour: s.color,
      weight: s.fontWeight,
    };
  });
}
