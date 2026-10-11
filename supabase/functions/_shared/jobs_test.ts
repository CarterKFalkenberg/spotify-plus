import { drainJobs, type Job } from "./jobs.ts";
import { assert, database, equal } from "./testing.ts";
const sha = "a".repeat(40);
const purgeJob: Job = {
  id: "synthetic",
  kind: "purge_backups",
  epoch: null,
  payload: { epoch: 2 },
  attempts: 1,
  leaseToken: "lease",
};
Deno.test("disconnect remains pending when storage deletion fails or absence cannot be verified", async () => {
  for (const result of [false, "throw"]) {
    let finished = false;
    let retried = false;
    let claimed = false;
    const db = database((name, args) => {
      if (name === "app_job_claim") {
        if (claimed) return null;
        claimed = true;
        return purgeJob;
      }
      if (name === "app_account_status") {
        return { epoch: 2, state: "disconnecting" };
      }
      if (name === "app_disconnect_finish") finished = true;
      if (name === "app_job_finish") {
        equal(args.p_outcome, "queued");
        assert(Number(args.p_retry_ms) > 0);
        retried = true;
      }
      return true;
    });
    await drainJobs({
      db,
      sha,
      backups: {
        purge: () =>
          result === "throw"
            ? Promise.reject(new Error("private storage detail"))
            : Promise.resolve(false),
      },
    });
    assert(!finished);
    assert(retried);
  }
});
Deno.test("successful disconnect checks backup absence and lease before committing completion", async () => {
  const events: string[] = [];
  let claimed = false;
  const db = database((name) => {
    if (name === "app_job_claim") {
      if (claimed) return null;
      claimed = true;
      return purgeJob;
    }
    if (name === "app_account_status") {
      return { epoch: 2, state: "disconnecting" };
    }
    events.push(name);
    return true;
  });
  const result = await drainJobs({
    db,
    sha,
    backups: {
      purge: () => {
        events.push("storage_verified_absent");
        return Promise.resolve(true);
      },
    },
  });
  equal(result.completed, 1);
  assert(
    events.indexOf("storage_verified_absent") < events.indexOf("app_job_renew"),
  );
  assert(
    events.indexOf("app_job_renew") < events.indexOf("app_disconnect_finish"),
  );
});
Deno.test("lost lease after purge cannot claim disconnect completion", async () => {
  let claimed = false;
  let completed = false;
  const db = database((name) => {
    if (name === "app_job_claim") {
      if (claimed) return null;
      claimed = true;
      return purgeJob;
    }
    if (name === "app_account_status") {
      return { epoch: 2, state: "disconnecting" };
    }
    if (name === "app_job_renew") return false;
    if (name === "app_disconnect_finish") completed = true;
    return true;
  });
  await drainJobs({ db, sha, backups: { purge: () => Promise.resolve(true) } });
  assert(!completed);
});
Deno.test("retry after committed purge acknowledgement loss cannot delete a reconnected account backup", async () => {
  let claimed = false;
  let storageCalls = 0;
  const db = database((name) => {
    if (name === "app_job_claim") {
      if (claimed) return null;
      claimed = true;
      return purgeJob;
    }
    if (name === "app_account_status") return { epoch: 2, state: "connected" };
    return true;
  });
  await drainJobs({
    db,
    sha,
    backups: {
      purge: () => {
        storageCalls++;
        return Promise.resolve(true);
      },
    },
  });
  equal(storageCalls, 0);
});
Deno.test("unknown feature jobs park visibly rather than being marked successful", async () => {
  let claimed = false;
  let parked = false;
  const db = database((name, args) => {
    if (name === "app_job_claim") {
      if (claimed) return null;
      claimed = true;
      return { ...purgeJob, kind: "future-domain-job" };
    }
    if (name === "app_job_finish") {
      equal(args.p_outcome, "parked");
      equal(args.p_error, "unsupported_job");
      parked = true;
    }
    return true;
  });
  const result = await drainJobs({
    db,
    sha,
    backups: { purge: () => Promise.resolve(true) },
  });
  equal(result.completed, 0);
  assert(parked);
});
Deno.test("bounded drain stops claiming when time reserve is exhausted", async () => {
  let now = 0, claims = 0;
  const db = database((name) => {
    if (name === "app_job_claim") {
      claims++;
      now = 40000;
      return { ...purgeJob, kind: "scheduler_ping" };
    }
    return true;
  });
  await drainJobs({
    db,
    sha,
    now: () => now,
    backups: { purge: () => Promise.resolve(true) },
  });
  equal(claims, 1);
});
