import {
  observeReviewCase,
  parseReviewRegistry,
  removeReviewItems,
  reviewProofFailure,
  runReviewExperiment,
  runReviewProof,
} from "./review-proof.ts";
import { equal } from "../../supabase/functions/_shared/testing.ts";
const uris = [
  "spotify:track:" + "a".repeat(22),
  "spotify:track:" + "b".repeat(22),
];
const removal = {
  playlistId: "p".repeat(22),
  uri: uris[0],
  snapshotId: "historical",
};
Deno.test("proof refuses a different service origin before opening files or sending credentials", async () => {
  for (
    const origin of [
      "http://aaaaaaaaaaaaaaaaaaaa.supabase.co",
      "https://other.example",
      "https://bbbbbbbbbbbbbbbbbbbb.supabase.co",
    ]
  ) {
    equal(
      await failure(() =>
        runReviewProof({
          origin,
          projectRef: "a".repeat(20),
          serviceKey: "synthetic",
          clientId: "synthetic",
          encryptionKey: "synthetic",
          bindingKey: "synthetic",
          ownerFingerprint: "a".repeat(64),
          epoch: 1,
          managementToken: "synthetic",
          registryPath: "must-not-open",
          authorized: true,
        })
      ),
      "review_input_invalid",
    );
  }
});
async function failure(action: () => unknown) {
  try {
    await action();
  } catch (error) {
    return reviewProofFailure(error).blocker;
  }
  throw new Error("Expected failure");
}
function transport() {
  const calls: { url: string; init: RequestInit }[] = [];
  const deferrals: unknown[] = [];
  let guards = 0;
  return {
    calls,
    deferrals,
    guardCount: () => guards,
    deps: {
      authorize: () => {
        guards++;
        return Promise.resolve(true);
      },
      tokens: {
        getAccessToken: () => Promise.resolve("synthetic-token"),
        refreshAccessToken: () => Promise.reject(new Error("No refresh")),
      },
      pacing: {
        acquire: () => Promise.resolve({ granted: true, retryAfterMs: 0 }),
        defer: (value: unknown) => {
          deferrals.push(value);
          return Promise.resolve();
        },
      },
      fetch: (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return Promise.resolve(Response.json({ snapshot_id: "after" }));
      },
    },
  };
}
Deno.test("operator DELETE sends only current URI/snapshot contract after two fixture guards", async () => {
  const t = transport();
  equal(await removeReviewItems(removal, t.deps), "after");
  equal(t.guardCount(), 2);
  equal(t.calls.length, 1);
  equal(
    t.calls[0].url,
    `https://api.spotify.com/v1/playlists/${removal.playlistId}/items`,
  );
  equal(t.calls[0].init.method, "DELETE");
  equal(t.calls[0].init.redirect, "manual");
  equal(JSON.parse(t.calls[0].init.body as string), {
    items: [{ uri: uris[0] }],
    snapshot_id: "historical",
  });
});
Deno.test("operator DELETE keeps its authorized target when caller input changes during pacing", async () => {
  const t = transport();
  const input = { ...removal };
  t.deps.pacing.acquire = () => {
    input.playlistId = "q".repeat(22);
    input.uri = uris[1];
    input.snapshotId = "changed";
    return Promise.resolve({ granted: true, retryAfterMs: 0 });
  };
  await removeReviewItems(input, t.deps);
  equal(
    t.calls[0].url,
    `https://api.spotify.com/v1/playlists/${removal.playlistId}/items`,
  );
  equal(JSON.parse(t.calls[0].init.body as string), {
    items: [{ uri: removal.uri }],
    snapshot_id: removal.snapshotId,
  });
});
Deno.test("operator DELETE rejects invalid boundaries and revoked fixture authorization without dispatch", async () => {
  for (
    const invalid of [{ ...removal, playlistId: "user-playlist" }, {
      ...removal,
      uri: "spotify:playlist:" + "a".repeat(22),
    }, { ...removal, snapshotId: "" }]
  ) {
    const t = transport();
    equal(
      await failure(() => removeReviewItems(invalid, t.deps)),
      "review_delete_input_invalid",
    );
    equal(t.calls.length, 0);
  }
  for (const revokeAfter of [0, 1]) {
    const t = transport();
    let checked = 0;
    t.deps.authorize = () => Promise.resolve(checked++ < revokeAfter);
    equal(
      await failure(() => removeReviewItems(removal, t.deps)),
      "review_fixture_guard",
    );
    equal(t.calls.length, 0);
  }
});
Deno.test("operator DELETE never replays dispatch on lost response, malformed success, 401 or server failure", async () => {
  for (const kind of ["network", "schema", "unauthorized", "server"]) {
    const t = transport();
    let attempts = 0;
    t.deps.fetch = () => {
      attempts++;
      return kind === "network"
        ? Promise.reject(new Error("synthetic-private"))
        : Promise.resolve(
          kind === "schema"
            ? Response.json({ private: "synthetic-private" })
            : new Response("synthetic-private", {
              status: kind === "unauthorized" ? 401 : 503,
            }),
        );
    };
    const code = await failure(() => removeReviewItems(removal, t.deps));
    equal(attempts, 1);
    equal(code.includes("synthetic"), false);
    equal(
      code,
      kind === "unauthorized"
        ? "review_delete_unauthorized"
        : kind === "server"
        ? "review_delete_unconfirmed"
        : "review_delete_ambiguous",
    );
  }
});
Deno.test("operator DELETE shares bounded pacing and stops on quota or rate limit without replay", async () => {
  const t = transport();
  let acquired = 0;
  const waits: number[] = [];
  t.deps.pacing.acquire = () =>
    Promise.resolve({
      granted: ++acquired === 3,
      retryAfterMs: acquired === 3 ? 0 : 500,
    });
  await removeReviewItems(removal, {
    ...t.deps,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  equal(waits, [500, 500]);
  equal(t.calls.length, 1);
  for (const quota of [false, true]) {
    const q = transport();
    let attempts = 0;
    q.deps.fetch = () => {
      attempts++;
      return Promise.resolve(
        Response.json({
          error: {
            reason: quota ? "QUOTA_EXCEEDED" : "OTHER",
            message: "synthetic-private",
          },
        }, { status: 429, headers: { "Retry-After": "120" } }),
      );
    };
    equal(
      await failure(() => removeReviewItems(removal, q.deps)),
      quota ? "review_delete_quota" : "review_delete_rate_limited",
    );
    equal(attempts, 1);
    equal(q.deferrals, [{
      retryAfterMs: quota ? 21600000 : 120000,
      kind: quota ? "quota" : "rate_limit",
    }]);
  }
  const denied = transport();
  denied.deps.pacing.acquire = () =>
    Promise.resolve({ granted: false, retryAfterMs: 3000 });
  equal(
    await failure(() => removeReviewItems(removal, denied.deps)),
    "review_pacing_blocked",
  );
  equal(denied.calls.length, 0);
});
Deno.test("experiment distinguishes historical-snapshot preservation from current-membership deletion", async () => {
  for (const historical of [true, false]) {
    let items: string[] = [], revision = 0;
    const versions = new Map<string, string[]>();
    const save = () => {
      const s = String(++revision);
      versions.set(s, [...items]);
      return s;
    };
    const removals: string[] = [];
    const observations = await runReviewExperiment({
      wait: () => Promise.resolve(),
      uris,
      replace: (target) => {
        items = [...target];
        return Promise.resolve(save());
      },
      append: (target) => {
        items.push(...target);
        return Promise.resolve(save());
      },
      read: () =>
        Promise.resolve({ items: [...items], snapshotId: String(revision) }),
      remove: (uri, baseline) => {
        removals.push(baseline);
        let left = historical
          ? versions.get(baseline)!.filter((item) => item === uri).length
          : Infinity;
        items = items.filter((item) => item !== uri || left-- <= 0);
        return Promise.resolve(save());
      },
    });
    equal(observations.length, 4);
    equal(removals.length, 4);
    equal(observations.map((o) => o.targetRemainingCount), [
      0,
      0,
      historical ? 1 : 0,
      0,
    ]);
    equal(observations.map((o) => o.expectedSequenceObserved), [
      true,
      true,
      historical,
      true,
    ]);
    equal(JSON.stringify(observations).includes(uris[0]), false);
  }
});
Deno.test("experiment refuses unacknowledged baseline and does not repeat ambiguous append/removal", async () => {
  for (const stop of ["baseline", "append", "remove"]) {
    let items: string[] = [], revision = 0, appends = 0, removals = 0;
    const code = await failure(() =>
      runReviewExperiment({
        wait: () => Promise.resolve(),
        uris,
        replace: (target) => {
          items = [...target];
          return Promise.resolve(String(++revision));
        },
        append: () => {
          appends++;
          throw new Error("synthetic-private");
        },
        read: () =>
          Promise.resolve({
            snapshotId: stop === "baseline" ? "wrong" : String(revision),
            items: [...items],
          }),
        remove: () => {
          removals++;
          if (stop === "remove") throw new Error("synthetic-private");
          items = items.filter((i) => i !== uris[0]);
          return Promise.resolve(String(++revision));
        },
      })
    );
    equal(code.includes("synthetic"), false);
    equal(appends, stop === "append" ? 1 : 0);
    equal(removals, stop === "baseline" ? 0 : stop === "remove" ? 1 : 2);
  }
});
Deno.test("registry validation refuses corrupt fixture scope and redaction drops arbitrary errors", async () => {
  const r = {
    version: 1,
    operation: crypto.randomUUID(),
    epoch: 2,
    ownerFingerprint: "a".repeat(64),
    playlistId: "p".repeat(22),
    state: "created",
    pending: null,
  };
  equal(parseReviewRegistry(r).epoch, 2);
  for (
    const invalid of [
      { ...r, epoch: -1 },
      { ...r, playlistId: null },
      { ...r, ownerFingerprint: "private" },
      { ...r, pending: "private metadata!" },
      { ...r, state: "unknown" },
    ]
  ) {
    equal(
      await failure(() => parseReviewRegistry(invalid)),
      "review_registry_invalid",
    );
  }
  equal(reviewProofFailure(new Error("synthetic-private")), {
    passed: false,
    blocker: "review_proof_failed",
  });
  equal(
    observeReviewCase("later_unrelated", [uris[1], null], uris)
      .unknownItemCount,
    1,
  );
});

Deno.test("acknowledged mutations converge through bounded reads without repeat writes", async () => {
  let items: string[] = [], revision = 0, readsSinceWrite = 0;
  const writes = { replace: 0, append: 0, remove: 0 };
  const waits: number[] = [];
  let stage = "baseline";
  const changed = () => {
    readsSinceWrite = 0;
    return String(++revision);
  };
  const observations = await runReviewExperiment({
    uris,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    replace: (target) => {
      writes.replace++;
      stage = "baseline";
      items = [...target];
      return Promise.resolve(changed());
    },
    append: (target) => {
      writes.append++;
      stage = "later_edit";
      items.push(...target);
      return Promise.resolve(changed());
    },
    remove: (uri) => {
      writes.remove++;
      stage = "removal";
      items = items.filter((item) => item !== uri);
      return Promise.resolve(changed());
    },
    read: () => {
      const attempt = ++readsSinceWrite;
      return Promise.resolve({
        snapshotId: attempt === 1 ? "stale" : String(revision),
        stable: attempt !== 2,
        items: attempt === 3 && stage !== "removal" ? [] : [...items],
      });
    },
  });
  equal(observations.length, 4);
  equal(writes, { replace: 4, append: 2, remove: 4 });
  equal(waits.length, 26);
  equal(waits.every((ms) => [500, 1000, 2000].includes(ms)), true);
});

Deno.test("persistent readback mismatches expose only fixed evidence and stop before another write", async () => {
  for (const stage of ["baseline", "later_edit", "removal"]) {
    for (const kind of ["snapshot", "sequence", "unstable"]) {
      // Removal's resulting sequence is an observation, not a promised contract.
      if (stage === "removal" && kind === "sequence") continue;
      let items: string[] = [], revision = 0, currentStage = "baseline";
      const writes = { replace: 0, append: 0, remove: 0 };
      const waits: number[] = [];
      let result;
      try {
        await runReviewExperiment({
          uris,
          wait: (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
          replace: (target) => {
            writes.replace++;
            currentStage = "baseline";
            items = [...target];
            return Promise.resolve(String(++revision));
          },
          append: (target) => {
            writes.append++;
            currentStage = "later_edit";
            items.push(...target);
            return Promise.resolve(String(++revision));
          },
          remove: (uri) => {
            writes.remove++;
            currentStage = "removal";
            items = items.filter((item) => item !== uri);
            return Promise.resolve(String(++revision));
          },
          read: () => {
            const fail = currentStage === stage;
            return Promise.resolve({
              snapshotId: fail && kind === "snapshot"
                ? "private-snapshot-value"
                : String(revision),
              stable: !(fail && kind === "unstable"),
              items: fail && kind === "sequence" ? [uris[1]] : [...items],
            });
          },
        });
        throw new Error("Expected mismatch");
      } catch (error) {
        result = reviewProofFailure(error);
      }
      equal(result.passed, false);
      equal(
        result.blocker,
        stage === "baseline"
          ? "review_baseline_unconfirmed"
          : stage === "later_edit"
          ? "review_later_edit_unconfirmed"
          : "review_removal_readback_unconfirmed",
      );
      equal(result.evidence?.stage, stage);
      equal(
        result.evidence?.case,
        stage === "later_edit" ? "later_same_uri" : "unique",
      );
      equal(result.evidence?.attempts, 4);
      equal(result.evidence?.stableReadback, kind !== "unstable");
      equal(result.evidence?.snapshotMatches, kind !== "snapshot");
      equal(
        result.evidence?.sequenceMatches,
        stage === "removal" ? null : kind !== "sequence",
      );
      equal(waits, [500, 1000, 2000]);
      equal(
        writes,
        stage === "baseline"
          ? { replace: 1, append: 0, remove: 0 }
          : stage === "later_edit"
          ? { replace: 3, append: 1, remove: 2 }
          : { replace: 1, append: 0, remove: 1 },
      );
      const output = JSON.stringify(result);
      equal(output.includes("private-snapshot-value"), false);
      equal(output.includes("spotify:"), false);
    }
  }
});

Deno.test("append acknowledgement must advance even when readback snapshot and sequence match", async () => {
  let items: string[] = [], revision = 0, appends = 0, removals = 0;
  let result;
  try {
    await runReviewExperiment({
      uris,
      wait: () => Promise.resolve(),
      replace: (target) => {
        items = [...target];
        return Promise.resolve(String(++revision));
      },
      append: (target) => {
        appends++;
        items.push(...target);
        return Promise.resolve(String(revision));
      },
      remove: (uri) => {
        removals++;
        items = items.filter((item) => item !== uri);
        return Promise.resolve(String(++revision));
      },
      read: () => Promise.resolve({ snapshotId: String(revision), items }),
    });
    throw new Error("Expected unchanged acknowledgement failure");
  } catch (error) {
    result = reviewProofFailure(error);
  }
  equal(result.blocker, "review_later_edit_unconfirmed");
  equal(result.evidence?.acknowledgementAdvanced, false);
  equal(result.evidence?.snapshotMatches, true);
  equal(result.evidence?.sequenceMatches, true);
  equal(result.evidence?.attempts, 4);
  equal(appends, 1);
  equal(removals, 2);
});
