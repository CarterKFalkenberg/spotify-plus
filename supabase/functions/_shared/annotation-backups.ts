import { BackupDeadline, type BackupWork } from "./backup-budget.ts";
import { SecretBox, sha256 } from "./crypto.ts";
import type { Database } from "./database.ts";
import type { FeatureJob } from "./library.ts";
export const MAX_SNAPSHOT_BYTES = 3744914;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export interface AnnotationSnapshot {
  version: 1;
  keyVersion: 1;
  id: string;
  day: string;
  owner: string;
  epoch: number;
  revision: string;
  keyLink: string;
  tags: { id: string; name: string; normalizedName: string }[];
  assignments: { trackKey: string; tagId: string }[];
}
function fields(
  value: unknown,
  names: string[],
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === names.sort().join();
}
export function validateSnapshot(value: unknown): AnnotationSnapshot {
  const fail = () => {
    throw new Error("invalid_annotation_backup");
  };
  if (
    !fields(value, [
      "version",
      "keyVersion",
      "id",
      "day",
      "owner",
      "epoch",
      "revision",
      "keyLink",
      "tags",
      "assignments",
    ])
  ) return fail();
  if (
    value.version !== 1 || value.keyVersion !== 1 ||
    typeof value.id !== "string" || !uuid.test(value.id) ||
    typeof value.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
    new Date(value.day).toISOString().slice(0, 10) !== value.day ||
    typeof value.owner !== "string" || !hash.test(value.owner) ||
    !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1 ||
    typeof value.revision !== "string" ||
    (!/^\d{1,19}$/.test(value.revision) ||
      BigInt(value.revision) > 9223372036854775807n) ||
    typeof value.keyLink !== "string" || !hash.test(value.keyLink) ||
    !Array.isArray(value.tags) || !Array.isArray(value.assignments) ||
    value.tags.length > 20000 || value.assignments.length > 100000
  ) return fail();
  const ids = new Set<string>(),
    names = new Set<string>(),
    edges = new Set<string>();
  for (const tag of value.tags) {
    if (
      !fields(tag, ["id", "name", "normalizedName"]) ||
      typeof tag.id !== "string" || !uuid.test(tag.id) ||
      typeof tag.name !== "string" || tag.name.length < 1 ||
      [...tag.name].length > 80 || typeof tag.normalizedName !== "string" ||
      !tag.normalizedName || ids.has(tag.id) || names.has(tag.normalizedName)
    ) return fail();
    ids.add(tag.id);
    names.add(tag.normalizedName);
  }
  for (const edge of value.assignments) {
    if (
      !fields(edge, ["trackKey", "tagId"]) ||
      typeof edge.trackKey !== "string" || !hash.test(edge.trackKey) ||
      typeof edge.tagId !== "string" || !ids.has(edge.tagId) ||
      edges.has(`${edge.trackKey}:${edge.tagId}`)
    ) return fail();
    edges.add(`${edge.trackKey}:${edge.tagId}`);
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
      MAX_SNAPSHOT_BYTES
  ) return fail();
  return value as unknown as AnnotationSnapshot;
}
export function backupPath(
  snapshot: Pick<AnnotationSnapshot, "epoch" | "id">,
): string {
  return `${snapshot.epoch}-${snapshot.id}.bin`;
}
function binding(snapshot: Pick<AnnotationSnapshot, "owner" | "epoch" | "id">) {
  return `spotify-plus:annotation-backup:v1:${snapshot.owner}:${snapshot.epoch}:${snapshot.id}`;
}
export class AnnotationBackupCodec {
  constructor(private readonly box: SecretBox) {}
  async encode(value: AnnotationSnapshot): Promise<string> {
    const snapshot = validateSnapshot(value);
    const encrypted = await this.box.encrypt(snapshot, binding(snapshot));
    if (encrypted.length > MAX_BACKUP_BYTES) {
      throw new Error("invalid_annotation_backup");
    }
    return encrypted;
  }
  async decode(
    encrypted: string,
    expected: Pick<AnnotationSnapshot, "owner" | "epoch" | "id" | "keyLink">,
  ): Promise<AnnotationSnapshot> {
    if (encrypted.length > MAX_BACKUP_BYTES) {
      throw new Error("invalid_annotation_backup");
    }
    const value = validateSnapshot(
      await this.box.decrypt(encrypted, binding(expected)),
    );
    if (
      value.owner !== expected.owner || value.epoch !== expected.epoch ||
      value.id !== expected.id || value.keyLink !== expected.keyLink
    ) throw new Error("invalid_annotation_backup");
    return value;
  }
}
export interface AnnotationObjectStorage {
  ensure(path: string, create: boolean, work?: BackupWork): Promise<boolean>;
  retire(path: string, work?: BackupWork): Promise<boolean>;
  read(path: string, work?: BackupWork): Promise<string | null>;
  upload(path: string, ciphertext: string, work?: BackupWork): Promise<void>;
  remove(paths: string[], work?: BackupWork): Promise<void>;
}
interface BackupPlan {
  snapshot: Omit<AnnotationSnapshot, "keyLink">;
  encryptedKey: string;
  state: "new" | "creating" | "uploading" | "retained";
}
export function annotationBackupJob(
  db: Database,
  storage: AnnotationObjectStorage,
  codec: AnnotationBackupCodec,
  options: { now?: () => number } = {},
): FeatureJob {
  const now = options.now ?? Date.now;
  return async (job, deadline) => {
    const work = { deadline: deadline - 10000, now };
    const available = () => now() < work.deadline;
    if (!available()) return { done: false, retryMs: 1000 };
    try {
      if (job.epoch === null || job.kind !== "annotation_backup") {
        throw new Error("invalid_backup_job");
      }
      const args = {
        p_epoch: job.epoch,
        p_id: job.id,
        p_lease: job.leaseToken,
      };
      // One target per attempt, checkpointed immediately. A deletion outage cannot
      // accumulate fresh daily targets or make a retry rescan confirmed absences.
      const cleanup = async () => {
        if (!available()) return "yield";
        const pending = await db.rpc<string[] | null>(
          "app_backup_retention",
          args,
        );
        if (!pending) return "stale";
        if (!pending.length) return "done";
        if (!available()) return "yield";
        const path = pending[0];
        await storage.remove([path], work);
        if (
          !await db.rpc<boolean>("app_backup_retention_finish", {
            ...args,
            p_paths: [path],
          })
        ) return "stale";
        // Bound this invocation to one cleanup target even with many overdue days.
        return "yield";
      };
      const before = await cleanup();
      if (before === "stale") return null;
      if (before === "yield") return { done: false, retryMs: 1000 };
      if (!available()) return { done: false, retryMs: 1000 };
      const plan = await db.rpc<BackupPlan | null>("app_backup_prepare", args);
      if (!plan) return null;
      const expected = {
        ...plan.snapshot,
        keyLink: await sha256(plan.encryptedKey),
      };
      const path = backupPath(expected);
      if (!available()) return { done: false, retryMs: 1000 };
      const snapshotArgs = { ...args, p_snapshot_id: expected.id };
      if (plan.state !== "retained") {
        const create = plan.state === "new" &&
          await db.rpc<boolean>("app_backup_bucket_start", snapshotArgs);
        if (!await storage.ensure(path, create, work)) {
          await db.rpc("app_backup_abandon", snapshotArgs);
          return { done: false, retryMs: 60000 };
        }
        if (!available()) return { done: false, retryMs: 1000 };
        if (!await db.rpc<boolean>("app_backup_upload_allowed", snapshotArgs)) {
          // Only this snapshot bucket is retired; never touch a later connection.
          if (
            await db.rpc<boolean>("app_backup_retire_allowed", {
              p_epoch: job.epoch,
              p_snapshot_id: expected.id,
            })
          ) await storage.retire(path, work);
          return null;
        }
      }
      if (plan.state !== "retained") {
        // Read first: an upload may have succeeded before its acknowledgement was lost.
        let encrypted = await storage.read(path, work);
        if (encrypted === null) {
          encrypted = await codec.encode(expected);
          if (!available()) return { done: false, retryMs: 1000 };
          await storage.upload(path, encrypted, work);
        }
        if (!available()) return { done: false, retryMs: 1000 };
        const actual = await codec.decode(encrypted, expected);
        if (!available()) return { done: false, retryMs: 1000 };
        if (actual.day !== expected.day) {
          throw new Error("invalid_annotation_backup");
        }
        if (
          !await db.rpc<boolean>("app_backup_commit", {
            ...args,
            p_snapshot_id: actual.id,
            p_revision: actual.revision,
            p_key_link: actual.keyLink,
          })
        ) return null;
      }
      const after = await cleanup();
      return after === "stale"
        ? null
        : { done: after === "done", retryMs: 1000 };
    } catch (error) {
      if (error instanceof BackupDeadline) {
        return { done: false, retryMs: 1000 };
      }
      throw error;
    }
  };
}
// Operator-only helper. Never called from API or a scheduled job.
export async function restoreAnnotations(
  db: Database,
  storage: AnnotationObjectStorage,
  codec: AnnotationBackupCodec,
  input: {
    snapshotId: string;
    epoch: number;
    owner: string;
    expectedRevision: string;
  },
) {
  const context = await db.rpc<{ keyLink: string }>(
    "app_backup_restore_context",
    {
      p_epoch: input.epoch,
      p_owner: input.owner,
      p_snapshot_id: input.snapshotId,
      p_expected_revision: input.expectedRevision,
    },
  );
  const encrypted = await storage.read(
    backupPath({ epoch: input.epoch, id: input.snapshotId }),
  );
  if (encrypted === null) throw new Error("annotation_backup_missing");
  const snapshot = await codec.decode(encrypted, {
    id: input.snapshotId,
    epoch: input.epoch,
    owner: input.owner,
    keyLink: context.keyLink,
  });
  return await db.rpc<{ restoredTags: number; restoredAssignments: number }>(
    "app_backup_restore",
    {
      p_epoch: input.epoch,
      p_owner: input.owner,
      p_expected_revision: input.expectedRevision,
      p_snapshot: snapshot,
    },
  );
}
