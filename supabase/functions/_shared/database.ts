export interface Database {
  rpc<T>(name: string, arguments_?: Record<string, unknown>): Promise<T>;
}
// Deliberately expose RPCs only; durable changes belong in database transactions.
export class ServiceDatabase implements Database {
  constructor(
    private readonly origin: string,
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async rpc<T>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    if (!/^app_[a-z_]+$/.test(name)) throw new Error("invalid_rpc");
    try {
      const response = await this.request(`${this.origin}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(arguments_),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) {
        // Only classify our fixed SQL errors. Never propagate query text, details or values.
        const error = await response.json().catch(() => null);
        if (error?.message === "wrong_account") throw new DatabaseError("wrong_account");
        throw new DatabaseError("unavailable");
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError("unavailable");
    }
  }
}
export class DatabaseError extends Error {
  constructor(readonly kind: "wrong_account" | "unavailable") {
    super(`database_${kind}`);
  }
}
