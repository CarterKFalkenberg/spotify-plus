import { DatabaseError, ServiceDatabase } from "./database.ts";
import { assert, equal, mockResponse, rejects } from "./testing.ts";

const unavailable = (error: unknown) =>
  error instanceof DatabaseError && error.kind === "unavailable";

Deno.test("service RPC sends named JSON parameters and server credentials only to the fixed RPC path", async () => {
  const db = new ServiceDatabase(
    "https://synthetic.example",
    "synthetic-service-key",
    (url, init) => {
      equal(
        String(url),
        "https://synthetic.example/rest/v1/rpc/app_pacing_acquire",
      );
      equal(JSON.parse(String(init?.body)), { p_epoch: 7, p_interval_ms: 500 });
      const headers = new Headers(init?.headers);
      equal(headers.get("apikey"), "synthetic-service-key");
      equal(headers.get("Authorization"), "Bearer synthetic-service-key");
      equal(init?.method, "POST");
      equal(init?.redirect, "error");
      assert(init?.signal instanceof AbortSignal);
      return mockResponse('{"granted":true,"retryAfterMs":0}');
    },
  );
  equal(
    await db.rpc("app_pacing_acquire", { p_epoch: 7, p_interval_ms: 500 }),
    {
      granted: true,
      retryAfterMs: 0,
    },
  );
});

Deno.test("only the two SQL void contracts accept PostgREST 204", async () => {
  const db = new ServiceDatabase(
    "https://synthetic.example",
    "key",
    () => mockResponse(null, { status: 204 }),
  );
  equal(await db.rpc("app_jobs_started", { p_sha: "a".repeat(40) }), undefined);
  equal(
    await db.rpc("app_pacing_defer", {
      p_epoch: 1,
      p_retry_ms: 30000,
      p_kind: "rate_limit",
    }),
    undefined,
  );
  for (
    const name of [
      "app_health",
      "app_job_claim",
      "app_connect",
      "app_pacing_acquire",
    ]
  ) {
    await rejects(() => db.rpc(name), unavailable);
  }
});

Deno.test("empty or malformed JSON successes and failed void responses remain unavailable", async () => {
  for (
    const [body, status] of [["", 200], ["malformed", 200], ["null", 503], [
      "",
      400,
    ]] as const
  ) {
    const db = new ServiceDatabase(
      "https://synthetic.example",
      "key",
      () => mockResponse(body, { status }),
    );
    await rejects(() => db.rpc("app_jobs_started"), unavailable);
    await rejects(() => db.rpc("app_health"), unavailable);
  }
});

Deno.test("JSON scalar, null and object results retain their actual contract", async () => {
  for (const value of [null, true, false, 1, { epoch: 1 }]) {
    const db = new ServiceDatabase(
      "https://synthetic.example",
      "key",
      () => mockResponse(JSON.stringify(value)),
    );
    equal(await db.rpc("app_session"), value);
  }
});

Deno.test("service RPC errors expose only the fixed classification", async () => {
  for (
    const message of [
      "UPDATE requires a WHERE clause",
      "untrusted query text",
      "wrong_account",
    ]
  ) {
    const db = new ServiceDatabase(
      "https://synthetic.example",
      "key",
      () =>
        mockResponse(
          JSON.stringify({ message, details: "synthetic sensitive detail" }),
          { status: 400 },
        ),
    );
    await rejects(
      () => db.rpc("app_connect"),
      (error) =>
        error instanceof DatabaseError &&
        error.message === (message === "wrong_account"
            ? "database_wrong_account"
            : "database_unavailable"),
    );
  }
});

Deno.test("library and playlist fixed conflicts stay distinct without provider diagnostics", async () => {
  for (
    const kind of [
      "stale_revision",
      "unknown_tag",
      "unknown_track",
      "unknown_action",
      "inactive_epoch",
      "invalid_input",
      "request_conflict",
      "unknown_playlist",
      "playlist_busy",
      "invalid_action",
      "remote_changed",
      "initial_sync_incomplete",
      "no_playable_matches",
    ] as const
  ) {
    const db = new ServiceDatabase(
      "https://synthetic.example",
      "key",
      () =>
        mockResponse(
          JSON.stringify({ message: kind, details: "private diagnostic" }),
          { status: 400 },
        ),
    );
    await rejects(
      () => db.rpc("app_query_preview"),
      (error) =>
        error instanceof DatabaseError && error.kind === kind &&
        error.message === `database_${kind}`,
    );
  }
});
