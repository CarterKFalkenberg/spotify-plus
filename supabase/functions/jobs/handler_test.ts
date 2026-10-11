import { createJobs } from "./handler.ts";
import { assert, database, equal } from "../_shared/testing.ts";
const cronSecret = "c".repeat(32), sha = "b".repeat(40);
Deno.test("jobs reject missing cron secret, proxy secret, and bearer token before DB work", async () => {
  const handler = createJobs({
    cronSecret,
    sha,
    db: database(() => {
      throw new Error("must not run");
    }),
    backups: { purge: () => Promise.resolve(true) },
  });
  for (
    const headers of [{}, { "x-proxy-secret": cronSecret }, {
      Authorization: `Bearer ${cronSecret}`,
    }, { "x-cron-secret": "wrong" }] as Record<string, string>[]
  ) {
    equal(
      (await handler(
        new Request("https://synthetic.example/functions/v1/jobs", {
          method: "POST",
          headers,
        }),
      )).status,
      401,
    );
  }
});
Deno.test("jobs authenticate health independently from API revision", async () => {
  const handler = createJobs({
    cronSecret,
    sha,
    db: database(() => ({
      jobsSha: "a".repeat(40),
      lastSchedulerAt: null,
      lastJobAt: null,
    })),
    backups: { purge: () => Promise.resolve(true) },
  });
  const response = await handler(
    new Request("https://synthetic.example/functions/v1/jobs/healthz", {
      headers: { "x-cron-secret": cronSecret },
    }),
  );
  const data = await response.json();
  equal(response.status, 200);
  equal(data.jobsSha, "b".repeat(40));
});
Deno.test("only cron-authenticated POST drains due jobs and records actual jobs revision", async () => {
  let calls = 0;
  const handler = createJobs({
    cronSecret,
    sha,
    db: database((name, args) => {
      calls++;
      if (name === "app_jobs_started") {
        equal(args.p_sha, sha);
        return null;
      }
      equal(name, "app_job_claim");
      return null;
    }),
    backups: { purge: () => Promise.resolve(true) },
  });
  const response = await handler(
    new Request("https://synthetic.example/functions/v1/jobs", {
      method: "POST",
      headers: { "x-cron-secret": cronSecret },
    }),
  );
  equal(response.status, 200);
  equal(calls, 2);
  assert((await response.json()).completed === 0);
});
