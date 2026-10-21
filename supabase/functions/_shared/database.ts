export interface Database {
  rpc<T>(name: string, arguments_?: Record<string, unknown>): Promise<T>;
}
// PostgREST returns 204 for these SQL `returns void` contracts. Every other RPC
// must return JSON, so an unexpected empty success remains a boundary failure.
const VOID_RPCS = new Set(["app_jobs_started", "app_pacing_defer"]);
// Deliberately expose RPCs only; durable changes belong in database transactions.
export class ServiceDatabase implements Database {
  constructor(
    private readonly origin: string,
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async rpc<T>(
    name: string,
    arguments_: Record<string, unknown> = {},
  ): Promise<T> {
    if (!/^app_[a-z_]+$/.test(name)) throw new Error("invalid_rpc");
    try {
      const response = await this.request(
        `${this.origin}/rest/v1/rpc/${name}`,
        {
          method: "POST",
          headers: {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(arguments_),
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
      if (!response.ok) {
        // Only classify our fixed SQL errors. Never propagate query text, details or values.
        const error = await response.json().catch(() => null);
        if (
          typeof error?.message === "string" &&
          DATABASE_ERRORS.includes(error.message)
        ) {
          throw new DatabaseError(error.message as DatabaseErrorKind);
        }
        throw new DatabaseError("unavailable");
      }
      if (response.status === 204 && VOID_RPCS.has(name)) return undefined as T;
      return await response.json() as T;
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError("unavailable");
    }
  }
}
const DATABASE_ERRORS = [
  "wrong_account",
  "inactive_epoch",
  "stale_revision",
  "unknown_tag",
  "unknown_track",
  "unknown_source",
  "unknown_action",
  "invalid_input",
  "request_conflict",
  "unknown_playlist",
  "playlist_busy",
  "invalid_action",
  "remote_changed",
  "initial_sync_incomplete",
  "no_playable_matches",
] as const;
export type DatabaseErrorKind = typeof DATABASE_ERRORS[number] | "unavailable";
export class DatabaseError extends Error {
  constructor(readonly kind: DatabaseErrorKind) {
    super(`database_${kind}`);
  }
}
