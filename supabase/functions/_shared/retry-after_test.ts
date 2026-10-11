import { retryAfter } from "./retry-after.ts";
import { equal } from "./testing.ts";
Deno.test("shared Retry-After parser returns only safe millisecond delays", () => {
  const now = Date.UTC(2026, 9, 11, 0, 0, 0);
  equal(retryAfter("60", now), 60000);
  equal(retryAfter("0.001", now), 1);
  equal(retryAfter("Sun, 11 Oct 2026 00:01:00 GMT", now), 60000);
  equal(retryAfter("Sun, 11 Oct 2026 00:01:00 GMT", NaN), null);
  for (
    const header of [
      null,
      "1e308",
      "9999999999999999999999999",
      "-1",
      "NaN",
      "Infinity",
      "",
    ]
  ) {
    equal(retryAfter(header, now), null);
  }
});
