import { createApi } from "../api/handler.ts";
import { createJobs } from "../jobs/handler.ts";
import { SecretBox } from "./crypto.ts";
import { SESSION_COOKIE } from "./http.ts";
import { assert, database, equal, TEST_KEY } from "./testing.ts";

const origin = "https://synthetic.example";
const config = {
  origin,
  sha: "a".repeat(40),
  clientId: "synthetic-client",
  expectedUserId: "synthetic-owner",
  proxySecret: "p".repeat(32),
  bootstrapSecret: "b".repeat(32),
  ownerBindingKey: TEST_KEY,
};
const health = {
  jobsSha: "b".repeat(40),
  lastSchedulerAt: "2026-10-11T00:00:00.000Z",
  lastJobAt: "2026-10-11T00:00:01.000Z",
};
for (const prefix of ["/api", "/functions/v1/api"]) {
  Deno.test(`API ${prefix} routes health and guest session without confusing proxy trust with owner login`, async () => {
    let calls = 0;
    const handler = createApi({
      config,
      box: new SecretBox(TEST_KEY),
      db: database((name) => {
        calls++;
        if (name === "app_health") return health;
        equal(name, "app_account_status");
        return { state: "disconnected" };
      }),
    });
    for (
      const [route, expected] of [
        ["/healthz", { apiSha: config.sha, ...health }],
        ["/api/session", { authenticated: false, connection: "disconnected" }],
      ] as const
    ) {
      for (const secret of [undefined, "wrong"]) {
        const before = calls;
        const response = await handler(
          new Request(origin + prefix + route, {
            headers: secret ? { "x-proxy-secret": secret } : {},
          }),
        );
        equal(response.status, 401);
        equal(calls, before);
      }
      const response = await handler(
        new Request(origin + prefix + route, {
          headers: { "x-proxy-secret": config.proxySecret },
        }),
      );
      equal(response.status, 200);
      equal(await response.json(), expected);
      equal(response.headers.get("Cache-Control"), "no-store");
    }
    equal(calls, 2);
  });
  Deno.test(`API ${prefix} reaches OAuth and independent bootstrap authorization before owner-session fallback`, async () => {
    let calls = 0;
    const handler = createApi({
      config,
      box: new SecretBox(TEST_KEY),
      db: database((name) => {
        calls++;
        if (name === "app_oauth_start") return null;
        equal(name, "app_account_status");
        return { bootstrapConsumed: false };
      }),
    });
    const start = await handler(
      new Request(origin + prefix + "/auth/spotify/start", {
        headers: { "x-proxy-secret": config.proxySecret },
      }),
    );
    equal(start.status, 303);
    equal(
      new URL(start.headers.get("Location")!).searchParams.get(
        "code_challenge_method",
      ),
      "S256",
    );
    equal(calls, 1);
    const denied = await handler(
      new Request(origin + prefix + "/internal/bootstrap", {
        headers: { "x-proxy-secret": config.proxySecret },
      }),
    );
    equal(denied.status, 401);
    equal(calls, 1);
    const allowed = await handler(
      new Request(origin + prefix + "/internal/bootstrap", {
        headers: {
          "x-proxy-secret": config.proxySecret,
          "x-bootstrap-secret": config.bootstrapSecret,
        },
      }),
    );
    equal(allowed.status, 200);
    equal(await allowed.json(), { consumed: false });
    equal(calls, 2);
  });
}
Deno.test("API wrong function, adjacent prefix and duplicate prefix cannot alias a product route", async () => {
  const handler = createApi({
    config,
    box: new SecretBox(TEST_KEY),
    db: database((name) => {
      equal(name, "app_session");
      return { epoch: 1, state: "connected" };
    }),
  });
  for (
    const path of [
      "/jobs/healthz",
      "/api-other/healthz",
      "/functions/v1/jobs/healthz",
      "/functions/v1/api-other/healthz",
      "/api/api/healthz",
      "/api/api/api/session",
      // A function-local /session is not a shorthand for product /api/session.
      "/api/session",
    ]
  ) {
    const response = await handler(
      new Request(origin + path, {
        headers: {
          "x-proxy-secret": config.proxySecret,
          Cookie: `${SESSION_COOKIE}=${"s".repeat(43)}`,
        },
      }),
    );
    equal(response.status, 404);
    equal(await response.json(), { error: "not_found" });
  }
});
for (const prefix of ["/jobs", "/functions/v1/jobs"]) {
  Deno.test(`jobs ${prefix} authenticates actual health and root POST routes`, async () => {
    const calls: string[] = [];
    const cronSecret = "c".repeat(32);
    const handler = createJobs({
      cronSecret,
      sha: config.sha,
      db: database((name, args) => {
        calls.push(name);
        if (name === "app_health") return health;
        if (name === "app_jobs_started") {
          equal(args.p_sha, config.sha);
          return null;
        }
        equal(name, "app_job_claim");
        return null;
      }),
      backups: { purge: () => Promise.resolve(true) },
    });
    for (
      const [suffix, method] of [["/healthz", "GET"], ["", "POST"], [
        "/",
        "POST",
      ]]
    ) {
      for (const secret of [undefined, "wrong"]) {
        const before = calls.length;
        const response = await handler(
          new Request(origin + prefix + suffix, {
            method,
            headers: secret ? { "x-cron-secret": secret } : {},
          }),
        );
        equal(response.status, 401);
        equal(calls.length, before);
      }
      const response = await handler(
        new Request(origin + prefix + suffix, {
          method,
          headers: { "x-cron-secret": cronSecret },
        }),
      );
      equal(response.status, 200);
      const body = await response.json();
      equal(body.jobsSha, config.sha);
      if (method === "GET") equal(body.lastSchedulerAt, health.lastSchedulerAt);
      else assert(body.completed === 0);
    }
    equal(calls, [
      "app_health",
      "app_jobs_started",
      "app_job_claim",
      "app_jobs_started",
      "app_job_claim",
    ]);
  });
}
Deno.test("jobs wrong function and adjacent or duplicate prefix never drain", async () => {
  const cronSecret = "c".repeat(32);
  const handler = createJobs({
    cronSecret,
    sha: config.sha,
    db: database(() => {
      throw new Error("unrecognized paths must not reach DB");
    }),
    backups: { purge: () => Promise.resolve(true) },
  });
  for (
    const path of [
      "/api",
      "/jobs-other",
      "/jobs/jobs",
      "/functions/v1/api",
      "/functions/v1/jobs-other",
    ]
  ) {
    const response = await handler(
      new Request(origin + path, {
        method: "POST",
        headers: { "x-cron-secret": cronSecret },
      }),
    );
    equal(response.status, 404);
    equal(await response.json(), { error: "not_found" });
  }
});
