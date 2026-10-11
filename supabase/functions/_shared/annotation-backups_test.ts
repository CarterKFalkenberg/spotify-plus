import {
  AnnotationBackupCodec,
  annotationBackupJob,
  type AnnotationObjectStorage,
  type AnnotationSnapshot,
  backupPath,
  restoreAnnotations,
  validateSnapshot,
} from "./annotation-backups.ts";
import { SecretBox, sha256 } from "./crypto.ts";
import { assert, database, equal, mockResponse, rejects } from "./testing.ts";
import { PrivateBackups } from "./backups.ts";
const key = btoa("k".repeat(32));
const codec = new AnnotationBackupCodec(new SecretBox(key));
const id = "00000000-0000-4000-8000-000000000001";
const tag = "00000000-0000-4000-8000-000000000002";
const encryptedKey = "synthetic-key-ciphertext";
async function fixture(): Promise<AnnotationSnapshot> {
  return {
    version: 1,
    keyVersion: 1,
    id,
    day: "2026-10-11",
    owner: "a".repeat(64),
    epoch: 1,
    revision: "5",
    keyLink: await sha256(encryptedKey),
    tags: [{ id: tag, name: "Chill", normalizedName: "chill" }],
    assignments: [{ trackKey: "b".repeat(64), tagId: tag }],
  };
}
function storage(): AnnotationObjectStorage & {
  objects: Map<string, string>;
  uploads: number;
  retired: string[];
} {
  return {
    objects: new Map(),
    uploads: 0,
    retired: [],
    ensure: () => Promise.resolve(true),
    retire(path) {
      this.retired.push(path);
      this.objects.delete(path);
      return Promise.resolve(true);
    },
    read(path) {
      return Promise.resolve(this.objects.get(path) ?? null);
    },
    upload(path, value) {
      this.uploads++;
      this.objects.set(path, value);
      return Promise.resolve();
    },
    async remove(paths) {
      for (const path of paths) await this.retire(path);
    },
  };
}
Deno.test("encrypted snapshot is strict, authenticated and excludes all other product state", async () => {
  const value = await fixture();
  const a = await codec.encode(value), b = await codec.encode(value);
  assert(a !== b);
  assert(!a.includes("Chill"));
  equal(await codec.decode(a, value), value);
  for (
    const changed of [
      { ...value, owner: "c".repeat(64) },
      { ...value, epoch: 2 },
      { ...value, id: tag },
      { ...value, keyLink: "d".repeat(64) },
    ]
  ) {
    await rejects(() => codec.decode(a, changed));
  }
  await rejects(() =>
    new AnnotationBackupCodec(new SecretBox(btoa("x".repeat(32)))).decode(
      a,
      value,
    )
  );
  await rejects(() => codec.decode(a.slice(0, -3) + "xxx", value));
  for (
    const invalid of [
      { ...value, keyVersion: 2 },
      { ...value, version: 2 },
      { ...value, encryptedKey: "forbidden" },
      { ...value, rawIds: [] },
      { ...value, tags: [value.tags[0], value.tags[0]] },
      {
        ...value,
        assignments: [{ trackKey: "spotify:track:raw", tagId: tag }],
      },
      { ...value, assignments: [{ trackKey: "b".repeat(64), tagId: id }] },
      { ...value, assignments: [...value.assignments, ...value.assignments] },
    ]
  ) {
    await rejects(() => Promise.resolve(validateSnapshot(invalid)));
  }
});
Deno.test("lost upload acknowledgement is reconciled without duplicate upload or overwritten daily copy", async () => {
  const value = await fixture(), objects = storage();
  let state = "new", fail = true, commits = 0;
  const db = database((name) => {
    if (name === "app_backup_retention") return [];
    if (name === "app_backup_prepare") {
      const { keyLink: _, ...snapshot } = value;
      return { snapshot, encryptedKey, state };
    }
    if (name === "app_backup_bucket_start") {
      state = "creating";
      return true;
    }
    if (name === "app_backup_upload_allowed") {
      state = "uploading";
      return true;
    }
    if (name === "app_backup_commit") {
      state = "retained";
      commits++;
      return true;
    }
    if (name === "app_backup_retention") return [];
    return true;
  });
  objects.upload = (path, ciphertext) => {
    objects.uploads++;
    objects.objects.set(path, ciphertext);
    if (fail) {
      fail = false;
      return Promise.reject(new Error("acknowledgement_lost"));
    }
    return Promise.resolve();
  };
  const run = annotationBackupJob(db, objects, codec),
    job = {
      id,
      epoch: 1,
      kind: "annotation_backup",
      attempts: 1,
      leaseToken: tag,
      payload: {},
    };
  await rejects(() => run(job, Infinity));
  equal(await run(job, Infinity), { done: true, retryMs: 1000 });
  equal(objects.uploads, 1);
  equal(commits, 1);
});
Deno.test("retention failures retry without discarding the successful new copy", async () => {
  const value = await fixture(), objects = storage();
  const old = backupPath({ ...value, id: tag });
  objects.objects.set(old, "old");
  let fail = true, confirmed = 0;
  const db = database((name, args) => {
    if (name === "app_backup_prepare") {
      const { keyLink: _, ...snapshot } = value;
      return { snapshot, encryptedKey, state: "retained" };
    }
    if (name === "app_backup_retention") {
      return objects.objects.has(old) ? [old] : [];
    }
    if (
      name === "app_backup_retention_finish" && Array.isArray(args.p_paths) &&
      args.p_paths.length
    ) {
      confirmed++;
    }
    return true;
  });
  objects.remove = async (paths) => {
    if (fail) {
      fail = false;
      throw new Error("delete_failed");
    }
    for (const path of paths) await objects.retire(path);
  };
  const run = annotationBackupJob(db, objects, codec),
    job = {
      id,
      epoch: 1,
      kind: "annotation_backup",
      attempts: 1,
      leaseToken: tag,
      payload: {},
    };
  await rejects(() => run(job, Infinity));
  equal(confirmed, 0);
  equal(await run(job, Infinity), { done: false, retryMs: 1000 });
  equal(await run(job, Infinity), { done: true, retryMs: 1000 });
  equal(objects.uploads, 0);
  equal(confirmed, 1);
});
Deno.test("disconnected creation cannot upload, and a lost lease cannot delete a newer worker copy", async () => {
  for (const retired of [true, false]) {
    const value = await fixture(), objects = storage();
    const db = database((name) => {
      if (name === "app_backup_retention") return [];
      if (name === "app_backup_prepare") {
        const { keyLink: _, ...snapshot } = value;
        return { snapshot, encryptedKey, state: "creating" };
      }
      if (name === "app_backup_upload_allowed") return false;
      if (name === "app_backup_retire_allowed") return retired;
      return true;
    });
    equal(
      await annotationBackupJob(db, objects, codec)({
        id,
        epoch: 1,
        kind: "annotation_backup",
        attempts: 1,
        leaseToken: tag,
        payload: {},
      }, Infinity),
      null,
    );
    equal(objects.uploads, 0);
    equal(objects.retired.length, Number(retired));
  }
});
Deno.test("ambiguous missing bucket is abandoned rather than recreated", async () => {
  const value = await fixture(), objects = storage();
  let abandoned = false;
  objects.ensure = (_path, create) => {
    equal(create, false);
    return Promise.resolve(false);
  };
  const db = database((name) => {
    if (name === "app_backup_prepare") {
      const { keyLink: _, ...snapshot } = value;
      return { snapshot, encryptedKey, state: "creating" };
    }
    if (name === "app_backup_abandon") abandoned = true;
    return true;
  });
  equal(
    await annotationBackupJob(db, objects, codec)({
      id,
      epoch: 1,
      kind: "annotation_backup",
      attempts: 1,
      leaseToken: tag,
      payload: {},
    }, Infinity),
    { done: false, retryMs: 60000 },
  );
  assert(abandoned);
  equal(objects.uploads, 0);
});
Deno.test("operator restore authenticates ciphertext before transaction and carries expected revision twice", async () => {
  const value = await fixture(), objects = storage();
  objects.objects.set(backupPath(value), await codec.encode(value));
  let restored = false;
  const db = database((name, args) => {
    equal(args.p_expected_revision, "8");
    if (name === "app_backup_restore_context") {
      return { keyLink: value.keyLink };
    }
    if (name === "app_backup_restore") {
      restored = true;
      equal(args.p_snapshot, value);
      return { restoredTags: 1, restoredAssignments: 1 };
    }
    throw new Error("unexpected_rpc");
  });
  equal(
    await restoreAnnotations(db, objects, codec, {
      snapshotId: id,
      epoch: 1,
      owner: value.owner,
      expectedRevision: "8",
    }),
    { restoredTags: 1, restoredAssignments: 1 },
  );
  assert(restored);
  restored = false;
  objects.objects.set(backupPath(value), "wrong ciphertext");
  await rejects(() =>
    restoreAnnotations(db, objects, codec, {
      snapshotId: id,
      epoch: 1,
      owner: value.owner,
      expectedRevision: "8",
    })
  );
  assert(!restored);
});

Deno.test("realistic 3000 assignments and near-size-limit snapshots round trip without argument-limit failure", async () => {
  for (const count of [3000, 29000]) {
    const value = await fixture();
    value.assignments = Array.from(
      { length: count },
      (_, i) => ({ trackKey: i.toString(16).padStart(64, "0"), tagId: tag }),
    );
    const ciphertext = await codec.encode(value);
    equal(await codec.decode(ciphertext, value), value);
  }
  const oversized = await fixture();
  oversized.assignments = Array.from(
    { length: 40000 },
    (_, i) => ({ trackKey: i.toString(16).padStart(64, "0"), tagId: tag }),
  );
  await rejects(() => codec.encode(oversized));
});
Deno.test("backup deadline yields before any SQL or Storage work when checkpoint reserve is all that remains", async () => {
  let calls = 0;
  const db = database(() => {
    calls++;
    throw new Error("unexpected_work");
  });
  const result = await annotationBackupJob(db, storage(), codec, {
    now: () => 70001,
  })({
    id,
    epoch: 1,
    kind: "annotation_backup",
    attempts: 1,
    leaseToken: tag,
    payload: {},
  }, 80000);
  equal(result, { done: false, retryMs: 1000 });
  equal(calls, 0);
});
Deno.test("retired cleanup checkpoints one target per invocation and resumes only the unconfirmed target", async () => {
  const value = await fixture(),
    objects = storage(),
    pending = [backupPath({ ...value, id }), backupPath({ ...value, id: tag })];
  let clock = 0, checkpoints = 0, prepares = 0;
  objects.remove = (paths, work) => {
    equal(paths.length, 1);
    equal(work?.deadline, clock + 70000);
    objects.objects.delete(paths[0]);
    clock += 60000;
    return Promise.resolve();
  };
  const db = database((name, args) => {
    if (name === "app_backup_retention") return [...pending];
    if (name === "app_backup_retention_finish") {
      equal(args.p_paths, [pending[0]]);
      pending.shift();
      checkpoints++;
      return true;
    }
    if (name === "app_backup_prepare") {
      prepares++;
      throw new Error("allocation_before_cleanup");
    }
    return true;
  });
  const run = annotationBackupJob(db, objects, codec, { now: () => clock }),
    job = {
      id,
      epoch: 1,
      kind: "annotation_backup",
      attempts: 1,
      leaseToken: tag,
      payload: {},
    };
  equal(await run(job, clock + 80000), { done: false, retryMs: 1000 });
  equal(checkpoints, 1);
  equal(prepares, 0);
  equal(await run(job, clock + 80000), { done: false, retryMs: 1000 });
  equal(checkpoints, 2);
  equal(pending.length, 0);
  equal(prepares, 0);
});
Deno.test("slow bucket creation yields with its durable intent and cannot start upload past the deadline", async () => {
  const value = await fixture(), objects = storage();
  let clock = 0, uploadsAllowed = 0;
  objects.ensure = (_path, _create, work) => {
    equal(work?.deadline, 70000);
    clock = 70001;
    return Promise.resolve(true);
  };
  const db = database((name) => {
    if (name === "app_backup_retention") return [];
    if (name === "app_backup_prepare") {
      const { keyLink: _, ...snapshot } = value;
      return { snapshot, encryptedKey, state: "new" };
    }
    if (name === "app_backup_upload_allowed") uploadsAllowed++;
    return true;
  });
  equal(
    await annotationBackupJob(db, objects, codec, { now: () => clock })({
      id,
      epoch: 1,
      kind: "annotation_backup",
      attempts: 1,
      leaseToken: tag,
      payload: {},
    }, 80000),
    { done: false, retryMs: 1000 },
  );
  equal(uploadsAllowed, 0);
  equal(objects.uploads, 0);
});

Deno.test("first daily copy handles actual Storage HTTP400 missing-object envelope and retains authenticated ciphertext", async () => {
  const value = await fixture();
  let state = "new",
    bucket = false,
    ciphertext: string | null = null,
    committed = 0;
  const objects = new PrivateBackups(
    "https://synthetic.example",
    "synthetic-service",
    (url, init) => {
      const route = new URL(String(url)).pathname;
      if (route === "/storage/v1/bucket" && init?.method === "POST") {
        bucket = true;
        return mockResponse("{}");
      }
      if (route.includes("/bucket/")) {
        return bucket
          ? mockResponse(
            JSON.stringify({
              public: false,
              file_size_limit: 5242880,
              allowed_mime_types: ["application/octet-stream"],
            }),
          )
          : mockResponse(
            JSON.stringify({
              statusCode: "404",
              code: "NoSuchBucket",
              error: "Bucket not found",
            }),
            { status: 400 },
          );
      }
      if (route.includes("/object/") && init?.method === "POST") {
        assert(bucket);
        equal(new Headers(init.headers).get("x-upsert"), "false");
        ciphertext = String(init.body);
        return mockResponse("{}");
      }
      if (route.includes("/object/")) {
        return ciphertext === null
          ? mockResponse(
            JSON.stringify({
              statusCode: "404",
              code: "NoSuchKey",
              error: "not_found",
              message: "Object not found",
            }),
            { status: 400 },
          )
          : mockResponse(ciphertext);
      }
      throw new Error("unexpected_storage_request");
    },
  );
  const db = database((name) => {
    if (name === "app_backup_retention") return [];
    if (name === "app_backup_prepare") {
      const { keyLink: _, ...snapshot } = value;
      return { snapshot, encryptedKey, state };
    }
    if (name === "app_backup_bucket_start") {
      state = "creating";
      return true;
    }
    if (name === "app_backup_upload_allowed") {
      state = "uploading";
      return true;
    }
    if (name === "app_backup_commit") {
      state = "retained";
      committed++;
      return true;
    }
    return true;
  });
  equal(
    await annotationBackupJob(db, objects, codec)({
      id,
      epoch: 1,
      kind: "annotation_backup",
      attempts: 1,
      leaseToken: tag,
      payload: {},
    }, Infinity),
    { done: true, retryMs: 1000 },
  );
  equal(committed, 1);
  assert(ciphertext !== null);
  const decoded = await codec.decode(ciphertext, value);
  equal(decoded.tags, value.tags);
  equal(decoded.assignments, value.assignments);
  equal(decoded.revision, value.revision);
  equal(decoded.day, value.day);
});
