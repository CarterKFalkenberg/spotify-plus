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
  check((await fixture("inspect")).bucketForeignKey === true);
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
  await drainJobs({
    db,
    backups: storage,
    sha: "a".repeat(40),
    library,
    annotationBackup: annotationBackupJob(db, storage, codec),
  });
  const latest = await fixture("latest");
  check(typeof latest.id === "string");
  const path = backupPath({ epoch, id: latest.id });
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
  const delayed = new PrivateBackups(
    input.origin,
    input.serviceKey,
    async (url, init) => {
      if (init?.method === "POST" && String(url).includes("/object/")) {
        entered();
        await hold;
      }
      return fetch(url, init);
    },
  );
  const late = delayed.upload(path, "late").then(() => false, () => true);
  await enteredPromise;
  const disconnected = await db.rpc<{ epoch: number }>("app_disconnect", {
    p_epoch: epoch,
  });
  const targets = await db.rpc<string[]>("app_backup_purge_targets", {
    p_epoch: disconnected.epoch,
  });
  check(await storage.purge(targets));
  check(await db.rpc("app_disconnect_finish", { p_epoch: disconnected.epoch }));
  release();
  check(await late);
  check(await storage.read(path) === null);
  check((await fixture("inspect")).annotationBackups === 0);
  console.log(
    JSON.stringify({
      status: "passed",
      assertions,
      storageRaceIterations: 4,
      isolatedRestore: true,
      lateUploadRejected: true,
    }),
  );
} catch {
  console.error(JSON.stringify({ status: "failed", phase, assertions }));
  Deno.exit(1);
}
