import {
  BackupDeadline,
  backupTimeout,
  type BackupWork,
} from "./backup-budget.ts";
import {
  type AnnotationObjectStorage,
  MAX_BACKUP_BYTES,
} from "./annotation-backups.ts";
export const BACKUP_BUCKET = "annotation-backups";
export interface BackupStorage {
  purge(
    paths?: string[],
    work?: BackupWork,
    checkpoint?: (path: string) => Promise<boolean>,
  ): Promise<boolean>;
}
// Epoch buckets are never reused. Deleting the bucket fences late object commits.
// The foundation bucket remains private and is emptied for legacy compatibility.
export class PrivateBackups implements BackupStorage, AnnotationObjectStorage {
  constructor(
    private readonly origin: string,
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  private async call(
    path: string,
    method: string,
    body?: unknown,
    work?: BackupWork,
  ): Promise<unknown> {
    try {
      const response = await this.request(`${this.origin}/storage/v1/${path}`, {
        method,
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(backupTimeout(work)),
        redirect: "error",
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch (error) {
      if (error instanceof BackupDeadline) throw error;
      throw new Error("backup_storage_unavailable");
    }
  }
  private epochBucket(epoch: number, id: string) {
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new Error("invalid_backup_path");
    }
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
      throw new Error("invalid_backup_path");
    }
    return `${BACKUP_BUCKET}-e${epoch}-${id}`;
  }
  async ensure(
    path: string,
    create: boolean,
    work?: BackupWork,
  ): Promise<boolean> {
    const id = this.bucketForPath(path);
    try {
      if (create) {
        const response = await this.request(
          `${this.origin}/storage/v1/bucket`,
          {
            method: "POST",
            headers: {
              apikey: this.key,
              Authorization: `Bearer ${this.key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id,
              name: id,
              public: false,
              file_size_limit: MAX_BACKUP_BYTES,
              allowed_mime_types: ["application/octet-stream"],
            }),
            signal: AbortSignal.timeout(backupTimeout(work)),
            redirect: "error",
          },
        );
        // Creation acknowledgement loss is harmless; inspect the actual bucket configuration.
        if (!response.ok) throw new Error();
      }
      if (!await this.bucketExists(id, work)) return false;
      const actual = await this.call(`bucket/${id}`, "GET", undefined, work);
      if (
        !actual || typeof actual !== "object" || !("public" in actual) ||
        actual.public !== false || !("file_size_limit" in actual) ||
        actual.file_size_limit !== MAX_BACKUP_BYTES ||
        !("allowed_mime_types" in actual) ||
        JSON.stringify(actual.allowed_mime_types) !==
          '["application/octet-stream"]'
      ) throw new Error();
      return true;
    } catch (error) {
      if (error instanceof BackupDeadline) throw error;
      throw new Error("backup_storage_unavailable");
    }
  }
  async retire(path: string, work?: BackupWork): Promise<boolean> {
    const id = this.bucketForPath(path);
    const exists = await this.bucketExists(id, work);
    if (!exists) return true;
    await this.call(`bucket/${id}/empty`, "POST", {}, work);
    await this.call(`bucket/${id}`, "DELETE", undefined, work);
    return !await this.bucketExists(id, work);
  }
  private async bucketExists(id: string, work?: BackupWork): Promise<boolean> {
    try {
      const response = await this.request(
        `${this.origin}/storage/v1/bucket/${id}`,
        {
          headers: { apikey: this.key, Authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(backupTimeout(work)),
          redirect: "error",
        },
      );
      if (response.status === 404) return false;
      if (!response.ok) throw new Error();
      return true;
    } catch (error) {
      if (error instanceof BackupDeadline) throw error;
      throw new Error("backup_storage_unavailable");
    }
  }
  private bucketForPath(path: string) {
    this.validatePath(path);
    return this.epochBucket(
      Number(path.split("-")[0]),
      path.slice(path.indexOf("-") + 1, -4),
    );
  }
  private validatePath(path: string) {
    if (
      !/^[1-9][0-9]*-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.bin$/.test(path)
    ) throw new Error("invalid_backup_path");
  }
  private objectPath(path: string) {
    if (
      !/^[1-9][0-9]*-[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.bin$/.test(path)
    ) throw new Error("invalid_backup_path");
    return `object/${this.bucketForPath(path)}/${path}`;
  }
  async read(path: string, work?: BackupWork): Promise<string | null> {
    try {
      const response = await this.request(
        `${this.origin}/storage/v1/${this.objectPath(path)}`,
        {
          headers: { apikey: this.key, Authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(backupTimeout(work)),
          redirect: "error",
        },
      );
      if (response.status === 404) return null;
      if (
        !response.ok ||
        Number(response.headers.get("content-length") ?? 0) > MAX_BACKUP_BYTES
      ) throw new Error();
      // Bound streaming reads even when Content-Length is absent or dishonest.
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > MAX_BACKUP_BYTES) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof BackupDeadline) throw error;
      throw new Error("backup_storage_unavailable");
    }
  }
  async upload(
    path: string,
    ciphertext: string,
    work?: BackupWork,
  ): Promise<void> {
    if (new TextEncoder().encode(ciphertext).length > MAX_BACKUP_BYTES) {
      throw new Error("invalid_annotation_backup");
    }
    try {
      const response = await this.request(
        `${this.origin}/storage/v1/${this.objectPath(path)}`,
        {
          method: "POST",
          headers: {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/octet-stream",
            "x-upsert": "false",
            "cache-control": "no-store",
          },
          body: ciphertext,
          signal: AbortSignal.timeout(backupTimeout(work)),
          redirect: "error",
        },
      );
      // Never overwrite an existing daily copy. A conflict is reconciled on the next leased attempt.
      if (!response.ok) throw new Error();
    } catch (error) {
      if (error instanceof BackupDeadline) throw error;
      throw new Error("backup_storage_unavailable");
    }
  }
  async remove(paths: string[], work?: BackupWork): Promise<void> {
    if (paths.length > 1) throw new Error("invalid_backup_batch");
    if (!paths.length) return;
    for (const path of paths) this.objectPath(path);
    for (const path of paths) {
      if (!await this.retire(path, work)) {
        throw new Error("backup_retention_pending");
      }
    }
  }
  async purge(
    paths: string[] = [],
    work?: BackupWork,
    checkpoint?: (path: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (paths.length > 1) throw new Error("invalid_backup_batch");
    for (const path of paths) {
      if (!await this.retire(path, work)) return false;
      if (checkpoint && !await checkpoint(path)) return false;
    }
    // Empty through Storage API, never SQL DELETE (which would leave object bytes behind).
    await this.call(`bucket/${BACKUP_BUCKET}/empty`, "POST", {}, work);
    const remaining = await this.call(`object/list/${BACKUP_BUCKET}`, "POST", {
      prefix: "",
      limit: 1,
      offset: 0,
    }, work);
    if (!Array.isArray(remaining)) {
      throw new Error("backup_storage_unavailable");
    }
    return remaining.length === 0;
  }
}
