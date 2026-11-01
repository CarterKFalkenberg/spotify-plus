import { afterEach, expect, it, vi } from "vitest";
import { parseDiagnostic } from "../../supabase/functions/_shared/diagnostics-contract";
const valid = {
  relatedRequest: null,
  event: "pause_failed",
  reason: "deadline",
  build: "a".repeat(40),
  document: "11111111-1111-4111-8111-111111111111",
  playback: "22222222-2222-4222-8222-222222222222",
  facts: { dispatches: 3, paused: false },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("rejects arbitrary metadata, identifiers, raw errors and unbounded facts", () => {
  expect(parseDiagnostic(valid)).toEqual(valid);
  for (const reason of ["startup_deadline", "teardown_rejected"])
    expect(parseDiagnostic({ ...valid, reason }).reason).toBe(reason);
  for (const body of [
    { ...valid, track: "private" },
    { ...valid, event: "private" },
    { ...valid, reason: "raw error" },
    { ...valid, facts: { uri: "private" } },
    { ...valid, facts: { paused: "private" } },
    { ...valid, facts: { elapsedMs: Infinity } },
    { ...valid, facts: { dispatches: -1 } },
    { ...valid, facts: { dispatches: 1.5 } },
    { ...valid, event: "api_failed" },
    { ...valid, document: "account-id" },
  ])
    expect(() => parseDiagnostic(body)).toThrow("invalid_input");
});
async function sender() {
  vi.resetModules();
  vi.stubGlobal("document", {
    querySelector: () => ({ getAttribute: () => "a".repeat(40) }),
  });
  return (await import("../../app/src/diagnostics")).playbackDiagnostics;
}
it("deduplicates per playback, correlates per document, bounds totals and has no retry", async () => {
  const create = await sender();
  const fetcher = vi.fn(async () => {
    throw new Error("private provider payload");
  });
  vi.stubGlobal("fetch", fetcher);
  for (let i = 0; i < 100; i++) {
    const report = create();
    report("pause_failed", "deadline", { dispatches: 3 });
    report("pause_failed", "deadline", { dispatches: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(fetcher).toHaveBeenCalledTimes(80);
  const bodies = fetcher.mock.calls.map((args) =>
    JSON.parse((args as unknown as [string, RequestInit])[1].body as string),
  );
  expect(new Set(bodies.map((body) => body.document)).size).toBe(1);
  expect(new Set(bodies.map((body) => body.playback)).size).toBe(80);
  expect(JSON.stringify(bodies)).not.toContain("private");
});
it("bounds pending requests and fails open for synchronous fetch failure", async () => {
  const create = await sender();
  const pending = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", pending);
  for (let i = 0; i < 8; i++) create()("pause_failed");
  await Promise.resolve();
  expect(pending).toHaveBeenCalledTimes(4);
  const fresh = await sender();
  vi.stubGlobal("fetch", () => {
    throw new Error("private");
  });
  expect(() => fresh()("pause_failed")).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
it("records successive operations in one warmed controller and validates related request IDs", async () => {
  const create = await sender();
  const fetcher = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  const report = create();
  report(
    "start_failed",
    "playback_unconfirmed",
    { operation: 1, apiStatus: 503 },
    valid.document,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  report(
    "start_failed",
    "playback_unconfirmed",
    { operation: 2, apiStatus: 503 },
    valid.document,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(() =>
    parseDiagnostic({ ...valid, relatedRequest: "private" }),
  ).toThrow();
  expect(() =>
    parseDiagnostic({ ...valid, facts: { apiStatus: 600 } }),
  ).toThrow();
});
