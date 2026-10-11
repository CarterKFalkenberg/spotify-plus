import type { Database } from "./database.ts";
import { SecretBox } from "./crypto.ts";
import { SpotifyError } from "./spotify.ts";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
interface Claim {
  action: "cached" | "refresh" | "busy" | "reconnect" | "cooldown";
  retryAfterMs?: number;
  encryptedTokens?: string;
  version?: number;
  lease?: string;
}
export interface TokenGrant extends TokenPair {
  expiresIn: number;
  scopes?: string[];
}
export async function exchangeToken(
  parameters: URLSearchParams,
  request: typeof fetch = fetch,
): Promise<TokenGrant> {
  let response: Response;
  try {
    response = await request("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters,
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
  } catch {
    throw new SpotifyError("network", null, null, true);
  }
  // A 429 is an explicit refusal even when the gateway omitted or mangled JSON.
  // Classify it before decoding; it never means a refresh rotation was ambiguous.
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const dateDelay = retryAfter === null
      ? NaN
      : Date.parse(retryAfter) - Date.now();
    const delay = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Number.isFinite(dateDelay) && dateDelay > 0
      ? dateDelay
      : 30000;
    await response.body?.cancel();
    throw new SpotifyError("rate_limit", 429, delay);
  }
  let data: Record<string, unknown>;
  try {
    const decoded: unknown = await response.json();
    if (
      decoded === null || typeof decoded !== "object" || Array.isArray(decoded)
    ) {
      throw new Error("invalid_token_response");
    }
    data = decoded as Record<string, unknown>;
  } catch {
    throw new SpotifyError("response", response.status, null, true);
  }
  if (!response.ok) {
    if (data.error === "invalid_grant") {
      throw new SpotifyError("authentication", response.status);
    }
    throw new SpotifyError(
      "http",
      response.status,
      null,
      response.status >= 500,
    );
  }
  if (
    typeof data.access_token !== "string" || !data.access_token ||
    typeof data.expires_in !== "number" || data.expires_in <= 0 ||
    data.expires_in > 86400 || data.token_type !== "Bearer" ||
    (data.refresh_token !== undefined &&
      (typeof data.refresh_token !== "string" || !data.refresh_token))
  ) {
    throw new SpotifyError("response", response.status, null, true);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string"
      ? data.refresh_token
      : "",
    expiresIn: data.expires_in,
    scopes: typeof data.scope === "string" ? data.scope.split(" ") : undefined,
  };
}
// SQL claims serialize workers; a token version prevents duplicate refresh when two reads get 401.
export class OwnerTokens {
  private observed: { token: string; version: number } | undefined;
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly epoch: number,
    private readonly clientId: string,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}
  getAccessToken(): Promise<string> {
    return this.obtain(null);
  }
  refreshAccessToken(rejectedToken: string): Promise<string> {
    return this.obtain(
      this.observed?.token === rejectedToken ? this.observed.version : null,
      rejectedToken,
    );
  }
  private async obtain(
    forceVersion: number | null,
    rejectedToken?: string,
  ): Promise<string> {
    const claim = await this.db.rpc<Claim>("app_token_claim", {
      p_epoch: this.epoch,
      p_force_version: forceVersion,
    });
    if (claim.action === "reconnect") throw new SpotifyError("authentication");
    if (claim.action === "cooldown") {
      throw new SpotifyError("cooldown", null, claim.retryAfterMs ?? 30000);
    }
    if (claim.action === "busy") throw new SpotifyError("cooldown", null, 1000);
    if (!claim.encryptedTokens || !claim.version) {
      throw new SpotifyError("control_unavailable");
    }
    let pair: TokenPair;
    try {
      pair = await this.box.decrypt<TokenPair>(
        claim.encryptedTokens,
        `tokens:${this.epoch}`,
      );
      if (
        !pair || typeof pair.accessToken !== "string" || !pair.accessToken ||
        typeof pair.refreshToken !== "string" || !pair.refreshToken
      ) {
        throw new Error("invalid_token_record");
      }
    } catch {
      // No provider call occurred. Preserve credentials and release a claim so
      // a key/configuration fault cannot later masquerade as a lost rotation.
      if (claim.action === "refresh" && claim.lease) {
        await this.db.rpc("app_token_fail", {
          p_epoch: this.epoch,
          p_lease: claim.lease,
          p_reconnect: false,
          p_retry_ms: 0,
        });
      }
      throw new SpotifyError("control_unavailable");
    }
    if (claim.action === "cached") {
      this.observed = { token: pair.accessToken, version: claim.version };
      // A newly constructed provider may be asked to refresh a rejected token. Resolve its version first.
      if (rejectedToken === pair.accessToken && forceVersion === null) {
        return this.obtain(claim.version);
      }
      return pair.accessToken;
    }
    if (!claim.lease) throw new SpotifyError("control_unavailable");
    let refreshed: TokenGrant;
    try {
      refreshed = await exchangeToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.clientId,
          refresh_token: pair.refreshToken,
        }),
        this.request,
      );
    } catch (error) {
      const reconnect = !(error instanceof SpotifyError) ||
        error.kind === "authentication" ||
        error.ambiguous;
      await this.db.rpc("app_token_fail", {
        p_epoch: this.epoch,
        p_lease: claim.lease,
        p_reconnect: reconnect,
        p_retry_ms: error instanceof SpotifyError && error.kind === "rate_limit"
          ? error.retryAfterMs ?? 30000
          : 0,
      });
      if (reconnect) throw new SpotifyError("authentication");
      throw error;
    }
    const nextPair = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || pair.refreshToken,
    };
    const accepted = await this.db.rpc<boolean>("app_token_finish", {
      p_epoch: this.epoch,
      p_lease: claim.lease,
      p_encrypted_tokens: await this.box.encrypt(
        nextPair,
        `tokens:${this.epoch}`,
      ),
      p_access_expires_at: new Date(this.now() + refreshed.expiresIn * 1000)
        .toISOString(),
    });
    if (!accepted) throw new SpotifyError("authentication");
    this.observed = { token: nextPair.accessToken, version: claim.version + 1 };
    return nextPair.accessToken;
  }
}
export function databasePacing(db: Database, epoch: number) {
  return {
    acquire: (interval: number) =>
      db.rpc<{ granted: boolean; retryAfterMs: number }>("app_pacing_acquire", {
        p_epoch: epoch,
        p_interval_ms: interval,
      }),
    defer: async (
      input: { retryAfterMs: number; kind: "rate_limit" | "quota" },
    ) => {
      await db.rpc("app_pacing_defer", {
        p_epoch: epoch,
        p_retry_ms: input.retryAfterMs,
        p_kind: input.kind,
      });
    },
  };
}
