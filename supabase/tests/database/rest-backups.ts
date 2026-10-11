// Run only on the disposable stack. stdin contains its service key; output is
// counts/status only. No real Spotify requests, real restores or cloud targets.
import { PrivateBackups } from "../../functions/_shared/backups.ts";
import {
  AnnotationBackupCodec,
  annotationBackupJob,
  backupPath,
  restoreAnnotations,
} from "../../functions/_shared/annotation-backups.ts";
import { ownerFingerprint, SecretBox } from "../../functions/_shared/crypto.ts";
import { ServiceDatabase } from "../../functions/_shared/database.ts";
import { createLibraryRunner } from "../../functions/_shared/library.ts";
import { drainJobs } from "../../functions/_shared/jobs.ts";
import { TEST_KEY } from "../../functions/_shared/testing.ts";
import type {
  CreateTagResponse,
  LibrarySearchResponse,
  LibraryStatusDTO,
} from "../../functions/_shared/contracts.ts";
let phase = "input", assertions = 0;
function check(value: unknown): asserts value {
  if (!value) throw new Error("assertion_failed");
  assertions++;
}
try {
  const input = await new Response(Deno.stdin.readable).json();
  check(
    input.origin === "http://127.0.0.1:61021" &&
      typeof input.serviceKey === "string",
  );
  const db = new ServiceDatabase(input.origin, input.serviceKey),
    storage = new PrivateBackups(input.origin, input.serviceKey),
    codec = new AnnotationBackupCodec(new SecretBox(TEST_KEY));
  const fixture = (p_action: string) =>
    db.rpc<Record<string, unknown>>("app_test_backup_fixture", { p_action });
  phase = "installed_fk";
  // This fixture is installed after the earlier REST proof. PostgREST may still
  // be reloading the service-only RPC cache when this child starts.
  let ready = false;
  const schemaDeadline = Date.now() + 10000;
  while (!ready && Date.now() < schemaDeadline) {
    try {
      ready = (await fixture("inspect")).bucketForeignKey === true;
    } catch { /* Fixed failure below; never print provider diagnostics. */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(ready);
  const status = await db.rpc<{ state: string; epoch: number }>(
    "app_account_status",
  );
  check(status.state === "disconnected");
  const epoch = status.epoch,
    owner = await ownerFingerprint("synthetic-account", TEST_KEY),
    session = "f".repeat(64);
  check(
    await db.rpc("app_connect", {
      p_epoch: epoch,
      p_account_id: "synthetic-account",
      p_owner_fingerprint: owner,
      p_initial_owner_verified: true,
      p_encrypted_tokens: "synthetic-only",
      p_access_expires_at: new Date(Date.now() + 3600000).toISOString(),
      p_authorized_at: new Date().toISOString(),
      p_session_hash: session,
      p_bootstrap: false,
    }),
  );
  const library = createLibraryRunner({
    db,
    annotationBox: new SecretBox(TEST_KEY),
    wait: () => Promise.resolve(),
    spotify: () => ({
      getSavedTracksPage: () =>
        Promise.resolve({
          offset: 0,
          limit: 50,
          nextOffset: null,
          total: 1,
          items: [{
            addedAt: "2026-01-01T00:00:00Z",
            track: {
              id: "a".repeat(22),
              uri: `spotify:track:${"a".repeat(22)}`,
              name: "Synthetic",
              artists: [],
              album: {
                id: "b".repeat(22),
                name: "Synthetic",
                releaseDate: "2026",
                images: [],
              },
              durationMs: 1000,
              explicit: false,
              isLocal: false,
              isPlayable: true,
            },
          }],
        }),
    }),
  });
  phase = "synthetic_import";
  await drainJobs({
    db,
    backups: storage,
    sha: "a".repeat(40),
    library,
    annotationBackup: annotationBackupJob(db, storage, codec),
  });
  const found = await db.rpc<LibrarySearchResponse>("app_library_search", {
    p_epoch: epoch,
    p_request: {
      filter: {
        membership: "active",
        search: "",
        untagged: false,
        newOnly: false,
        artistId: null,
      },
      groupBy: null,
      cursor: null,
      limit: 10,
    },
  });
  check(found.groupBy === null && found.tracks.length === 1);
  const tag = await db.rpc<CreateTagResponse>("app_tag_create", {
    p_epoch: epoch,
    p_name: "Synthetic backup tag",
  });
  await db.rpc("app_tag_action", {
    p_epoch: epoch,
    p_session_hash: session,
    p_request: {
      action: "add",
      tagId: tag.tag.id,
      selection: { kind: "tracks", trackKeys: [found.tracks[0].trackKey] },
    },
  });
  phase = "encrypted_daily_copy";
  await db.rpc("app_job_enqueue", {
    p_kind: "annotation_backup",
    p_epoch: epoch,
  });
  const copied = await drainJobs({
    db,
    backups: storage,
    sha: "a".repeat(40),
    library,
    annotationBackup: annotationBackupJob(db, storage, codec),
  });
  phase = "encrypted_daily_copy_worker";
  check(copied.retried === 0 && copied.completed >= 1);
  phase = "encrypted_daily_copy_record";
  const latest = await fixture("latest");
  check(typeof latest.id === "string");
  const path = backupPath({ epoch, id: latest.id });
  phase = "encrypted_daily_copy_storage";
  const encrypted = await storage.read(path);
  check(encrypted !== null && !encrypted.includes("Synthetic"));
  phase = "isolated_restore";
  await db.rpc("app_tag_action", {
    p_epoch: epoch,
    p_session_hash: session,
    p_request: {
      action: "remove",
      tagId: tag.tag.id,
      selection: { kind: "tracks", trackKeys: [found.tracks[0].trackKey] },
    },
  });
  const state = await db.rpc<LibraryStatusDTO>("app_library_status", {
    p_epoch: epoch,
  });
  const restored = await restoreAnnotations(db, storage, codec, {
    snapshotId: latest.id,
    epoch,
    owner,
    expectedRevision: state.revision.annotations,
  });
  check(restored.restoredTags === 1 && restored.restoredAssignments === 1);
  phase = "storage_concurrency";
  // Each private target has one creation call and is never recreated. Actual
  // concurrent HTTP upload/deletion exercises the installed Storage/FK contract.
  for (let i = 0; i < 4; i++) {
    const racePath = backupPath({ epoch, id: crypto.randomUUID() });
    check(await storage.ensure(racePath, true));
    const raced = await Promise.allSettled([
      storage.upload(racePath, "synthetic-ciphertext"),
      storage.retire(racePath),
    ]);
    check(raced.some((result) => result.status === "fulfilled"));
    check(await storage.retire(racePath));
    check(await storage.read(racePath) === null);
    let rejected = false;
    try {
      await storage.upload(racePath, "late");
    } catch {
      rejected = true;
    }
    check(rejected);
  }
  phase = "disconnect_upload_fence";
  // Hold a fetched upload before it reaches Storage, then actually disconnect
  // and delete its never-reused bucket before delivering the late HTTP request.
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let lateHttpStatus: number | null = null;
  let missingBucketResponse = false;
  const delayed = new PrivateBackups(
    input.origin,
    input.serviceKey,
    async (url, init) => {
      if (init?.method === "POST" && String(url).includes("/object/")) {
        entered();
        await hold;
        // The client signal was created before the deliberate hold. A fresh
        // timeout ensures this proof reaches Storage after disconnect finishes.
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(10000),
        });
        lateHttpStatus = response.status;
        if (response.status === 404) missingBucketResponse = true;
        else if (response.status === 400) {
          // Some Storage versions wrap a missing-bucket 404 in HTTP 400.
          // Inspect only the fixed code/message; never emit provider content.
          const body = await response.clone().json().catch(() => null);
          missingBucketResponse = body?.code === "NoSuchBucket" ||
            body?.error === "Bucket not found" ||
            body?.message === "Bucket not found";
        }
        return response;
      }
      return fetch(url, init);
    },
  );
  const late = delayed.upload(path, "late").then(() => false, () => true);
  await enteredPromise;
  const disconnected = await db.rpc<{ epoch: number }>("app_disconnect", {
    p_epoch: epoch,
  });
  // Exercise the real bounded purge job and its durable per-target checkpoints.
  for (let attempt = 0; attempt < 10; attempt++) {
    await drainJobs({ db, backups: storage, sha: "a".repeat(40) });
    const current = await db.rpc<{ state: string }>("app_account_status");
    if (current.state === "disconnected") break;
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  check(
    (await db.rpc<{ epoch: number; state: string }>("app_account_status"))
      .state === "disconnected",
  );
  check(disconnected.epoch === epoch + 1);
  release();
  check(await late);
  check(lateHttpStatus !== null && missingBucketResponse);
  check(await storage.read(path) === null);
  check((await fixture("inspect")).annotationBackups === 0);
  console.log(
    JSON.stringify({
      status: "passed",
      assertions,
      storageRaceIterations: 4,
      isolatedRestore: true,
      lateUploadRejected: true,
      lateUploadHttpStatus: lateHttpStatus,
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      status: "failed",
      blocker: `local_backup_${phase}_failed`,
      assertions,
    }),
  );
  Deno.exit(1);
}
