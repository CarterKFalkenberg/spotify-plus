import {
  annotationKey,
  createLibraryRunner,
  libraryPage,
  newAnnotationKey,
} from "./library.ts";
import { SecretBox } from "./crypto.ts";
import type { Job } from "./jobs.ts";
import { drainJobs } from "./jobs.ts";
import {
  SpotifyError,
  type SpotifyPage,
  type SpotifySavedTrack,
  type SpotifyTrack,
} from "./spotify.ts";
import { assert, database, equal, rejects, TEST_KEY } from "./testing.ts";
const id = "a".repeat(22);
const track: SpotifyTrack = {
  id,
  uri: `spotify:track:${id}`,
  name: "Synthetic track",
  artists: [{ id: "b".repeat(22), name: "Synthetic artist" }],
  album: {
    id: "c".repeat(22),
    name: "Synthetic album",
    releaseDate: "2026",
    images: [{
      url: "https://images.test/synthetic.png",
      width: 300,
      height: 300,
    }],
  },
  durationMs: 1234,
  explicit: false,
  isLocal: false,
  isPlayable: true,
};
const page: SpotifyPage<SpotifySavedTrack> = {
  items: [{ addedAt: "2026-01-01T00:00:00Z", track }],
  total: 1,
  offset: 0,
  limit: 50,
  nextOffset: null,
};
const job: Job = {
  id: "synthetic-job",
  epoch: 2,
  kind: "library_sync",
  leaseToken: "synthetic-lease",
  attempts: 1,
  payload: {},
};
Deno.test("annotation identity is deterministic per purgeable key and contains no raw ID", async () => {
  const key = newAnnotationKey();
  const a = await annotationKey(key, id);
  equal(await annotationKey(key, id), a);
  assert(/^[0-9a-f]{64}$/.test(a));
  assert(await annotationKey(newAnnotationKey(), id) !== a);
  await rejects(() => annotationKey(key, "invalid"));
  await rejects(() => annotationKey(btoa("short"), id));
});
Deno.test("saved page projection preserves unavailable identified tracks and refuses false coverage for null identity", async () => {
  const projected = await libraryPage({
    ...page,
    total: 4,
    items: [
      ...page.items,
      {
        addedAt: page.items[0].addedAt,
        track: { ...track, isPlayable: false },
      },
      { addedAt: page.items[0].addedAt, track: null },
      {
        addedAt: page.items[0].addedAt,
        track: { ...track, id: null, isLocal: true },
      },
    ],
  }, TEST_KEY);
  equal(projected.rows.length, 2);
  equal(projected.unresolved, 1);
  equal(projected.skipped, 1);
  equal(projected.rows[1].playableUri, null);
  equal(projected.rows[0].spotifyUrl, `https://open.spotify.com/track/${id}`);
  assert(!("raw" in projected.rows[0]));
  const local = await libraryPage({
    ...page,
    items: [{ ...page.items[0], track: { ...track, isLocal: true } }],
  }, TEST_KEY);
  equal(local.rows.length, 0);
  equal(local.skipped, 1);
  equal(local.unresolved, 0);
});
Deno.test("worker checks checkpoint and lease before Spotify, commits page with exact offset, then reloads verification", async () => {
  const box = new SecretBox(TEST_KEY);
  const encrypted = await box.encrypt(TEST_KEY, "annotation-key:2");
  const events: string[] = [];
  let stateCalls = 0;
  let commits = 0;
  const db = database((name, args) => {
    events.push(name);
    if (name === "app_library_job_state") {
      stateCalls++;
      return {
        encryptedKey: encrypted,
        offset: stateCalls === 1 ? 50 : 0,
        pass: stateCalls === 1 ? 1 : 2,
        runId: "run",
      };
    }
    if (name === "app_job_renew") return true;
    if (name === "app_library_page_commit") {
      commits++;
      equal(args.p_offset, commits === 1 ? 50 : 0);
      equal(args.p_pass, commits);
      equal(args.p_received, 1);
      equal(args.p_unresolved, 0);
      assert(Array.isArray(args.p_rows) && args.p_rows.length === 1);
      return { done: commits === 2, retryMs: 0 };
    }
    throw new Error("unexpected RPC");
  });
  const runner = createLibraryRunner({
    db,
    annotationBox: box,
    now: () => 0,
    wait: () => Promise.resolve(),
    spotify: () => ({
      getSavedTracksPage: (
        { offset }: { offset?: number; limit?: number } = {},
      ) => {
        events.push("spotify");
        return Promise.resolve({ ...page, offset: offset ?? 0 });
      },
    }),
  });
  equal(await runner(job, 80000), { done: true, retryMs: 0 });
  equal(commits, 2);
  assert(events.indexOf("app_library_job_state") < events.indexOf("spotify"));
  assert(events.indexOf("app_job_renew") < events.indexOf("spotify"));
});
Deno.test("cancelled lease and lost page acknowledgement never infer durable progress", async () => {
  const box = new SecretBox(TEST_KEY);
  const encrypted = await box.encrypt(TEST_KEY, "annotation-key:2");
  for (const stop of ["checkpoint", "renew", "commit"]) {
    let requests = 0;
    const db = database((name) => {
      if (name === "app_library_job_state") {
        return stop === "checkpoint"
          ? null
          : { encryptedKey: encrypted, offset: 0, pass: 1, runId: "run" };
      }
      if (name === "app_job_renew") return stop !== "renew";
      if (name === "app_library_page_commit") return null;
      throw new Error("unexpected RPC");
    });
    const runner = createLibraryRunner({
      db,
      annotationBox: box,
      now: () => 0,
      spotify: () => ({
        getSavedTracksPage: () => {
          requests++;
          return Promise.resolve(page);
        },
      }),
    });
    equal(await runner(job, 80000), null);
    equal(requests, stop === "commit" ? 1 : 0);
  }
});
Deno.test("probe reads one first page and cannot assert full library completeness", async () => {
  const box = new SecretBox(TEST_KEY),
    encrypted = await box.encrypt(TEST_KEY, "annotation-key:2");
  let probes = 0;
  const db = database((name, args) => {
    if (name === "app_library_job_state") {
      return { encryptedKey: encrypted, offset: 0, pass: 0, runId: null };
    }
    if (name === "app_job_renew") return true;
    if (name === "app_library_probe_commit") {
      probes++;
      equal(args.p_complete, false);
      return true;
    }
    throw new Error("unexpected RPC");
  });
  const runner = createLibraryRunner({
    db,
    annotationBox: box,
    now: () => 0,
    spotify: () => ({
      getSavedTracksPage: () =>
        Promise.resolve({
          ...page,
          items: [{ addedAt: page.items[0].addedAt, track: null }],
        }),
    }),
  });
  equal(await runner({ ...job, kind: "library_probe" }, 80000), { done: true });
  equal(probes, 1);
});
Deno.test("worker batch limit and time reserve bound drains while preserving resumable intent", async () => {
  const box = new SecretBox(TEST_KEY),
    encrypted = await box.encrypt(TEST_KEY, "annotation-key:2");
  for (const deadline of [19000, 80000]) {
    let requests = 0;
    const db = database((name) => {
      if (name === "app_library_job_state") {
        return { encryptedKey: encrypted, offset: 0, pass: 1, runId: "run" };
      }
      if (name === "app_job_renew") return true;
      if (name === "app_library_page_commit") {
        return { done: false, retryMs: 0 };
      }
      throw new Error("unexpected RPC");
    });
    const runner = createLibraryRunner({
      db,
      annotationBox: box,
      now: () => 0,
      wait: () => Promise.resolve(),
      spotify: () => ({
        getSavedTracksPage: () => {
          requests++;
          return Promise.resolve(page);
        },
      }),
    });
    equal(await runner(job, deadline), { done: false, retryMs: 1000 });
    equal(requests, deadline === 19000 ? 0 : 10);
  }
});
Deno.test("job dispatcher persists library reconnect/cooldown/quota/transient retries", async () => {
  for (
    const kind of ["authentication", "cooldown", "quota", "network"] as const
  ) {
    let claimed = false, finished = false;
    const db = database((name, args) => {
      if (name === "app_job_claim") {
        if (claimed) return null;
        claimed = true;
        return job;
      }
      if (name === "app_job_finish") {
        equal(args.p_outcome, kind === "authentication" ? "parked" : "queued");
        if (kind !== "authentication") assert(Number(args.p_retry_ms) >= 60000);
        finished = true;
      }
      return true;
    });
    await drainJobs({
      db,
      sha: "a".repeat(40),
      backups: { purge: () => Promise.resolve(true) },
      library: () => Promise.reject(new SpotifyError(kind, null, 60000)),
    });
    assert(finished);
  }
});

Deno.test("reclaimed completed run finishes its durable job after lost final-page acknowledgement without Spotify", async () => {
  let claimed = false;
  let finishes = 0;
  const db = database((name, args) => {
    if (name === "app_job_claim") {
      if (claimed) return null;
      claimed = true;
      return job;
    }
    if (name === "app_library_job_state") return { completed: true };
    if (name === "app_job_finish") {
      equal(args.p_outcome, "done");
      finishes++;
    }
    return true;
  });
  const library = createLibraryRunner({
    db,
    annotationBox: new SecretBox(TEST_KEY),
    spotify: () => {
      throw new Error("completed runs must not call Spotify");
    },
  });
  const result = await drainJobs({
    db,
    sha: "a".repeat(40),
    backups: { purge: () => Promise.resolve(true) },
    library,
  });
  equal(result.completed, 1);
  equal(finishes, 1);
});
