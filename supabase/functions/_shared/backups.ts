export const BACKUP_BUCKET = "annotation-backups";
export interface BackupStorage {
  purge(): Promise<boolean>;
}
// Fixed private bucket, no client-supplied paths. Future backup writers must serialize with
// disconnect and use epoch fencing; no writer is present in the foundation.
export class PrivateBackups implements BackupStorage {
  constructor(
    private readonly origin: string,
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  private async call(path: string, method: string, body: unknown): Promise<unknown> {
    try {
      const response = await this.request(`${this.origin}/storage/v1/${path}`, {
        method,
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error("backup_storage_unavailable");
    }
  }
  async purge(): Promise<boolean> {
    // Empty through Storage API, never SQL DELETE (which would leave object bytes behind).
    await this.call(`bucket/${BACKUP_BUCKET}/empty`, "POST", {});
    const remaining = await this.call(`object/list/${BACKUP_BUCKET}`, "POST", {
      prefix: "",
      limit: 1,
      offset: 0,
    });
    if (!Array.isArray(remaining)) throw new Error("backup_storage_unavailable");
    return remaining.length === 0;
  }
}
