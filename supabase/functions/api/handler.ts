import { ContractError } from "../_shared/contracts.ts";
import { libraryApi } from "./library.ts";
import {
  opaqueToken,
  ownerFingerprint,
  pkceChallenge,
  SecretBox,
  secretMatches,
  sha256,
} from "../_shared/crypto.ts";
import { type Database, DatabaseError } from "../_shared/database.ts";
import {
  cookie,
  json,
  OAUTH_COOKIE,
  pathFor,
  readCookie,
  readJson,
  redirect,
  SESSION_COOKIE,
} from "../_shared/http.ts";
import {
  SPOTIFY_SCOPES,
  SpotifyClient,
  SpotifyError,
} from "../_shared/spotify.ts";
import {
  databasePacing,
  exchangeToken,
  type TokenPair,
} from "../_shared/tokens.ts";

export interface ApiConfig {
  origin: string;
  sha: string;
  clientId: string;
  expectedUserId: string;
  proxySecret: string;
  bootstrapSecret: string;
  ownerBindingKey: string;
}
interface AccountStatus {
  epoch: number;
  state: string;
  bootstrapConsumed: boolean;
  ownerBound: boolean;
}
interface Session {
  epoch: number;
  state: string;
  authorizedAt: string;
  authorizationDeadline: string;
}
export interface ApiDependencies {
  db: Database;
  box: SecretBox;
  config: ApiConfig;
  fetch?: typeof fetch;
  now?: () => number;
}
const CLEAR_OAUTH = cookie(OAUTH_COOKIE, "", 0);
export const DISCONNECT_REMAINS =
  "Minimal login security configuration remains: a keyed owner fingerprint, the account epoch, and a one-time bootstrap marker. Existing Spotify playlists remain, and their automatic cleanup stops. App-controlled backups must finish deleting before reconnect. Spotify grant revocation is available in your Spotify account Apps page; provider-internal retention is outside this app’s control.";
function stringField(
  body: Record<string, unknown>,
  key: string,
  max = 4096,
): string {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > max) {
    throw new Error("invalid_input");
  }
  return value;
}
function validDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_input");
  return new Date(timestamp).toISOString();
}
export function createApi(
  { db, box, config, fetch: request = fetch, now = Date.now }: ApiDependencies,
) {
  const authFailure = (kind: string) =>
    redirect(`${config.origin}/?auth_error=${kind}`, [CLEAR_OAUTH]);
  async function identity(accessToken: string, epoch: number) {
    const client = new SpotifyClient({
      tokens: {
        getAccessToken: () => Promise.resolve(accessToken),
        refreshAccessToken: () =>
          Promise.reject(new SpotifyError("authentication")),
      },
      pacing: databasePacing(db, epoch),
      isManagedPlaylist: () => Promise.resolve(false),
      fetch: request,
    });
    return await client.getCurrentUser();
  }
  async function persistGrant(
    input: {
      epoch: number;
      pair: TokenPair;
      expiresAt: string;
      authorizedAt: string;
      bootstrap: boolean;
    },
  ) {
    const profile = await identity(input.pair.accessToken, input.epoch);
    const session = opaqueToken();
    const accepted = await db.rpc<boolean>("app_connect", {
      p_epoch: input.epoch,
      p_account_id: profile.accountId,
      p_owner_fingerprint: await ownerFingerprint(
        profile.accountId,
        config.ownerBindingKey,
      ),
      p_initial_owner_verified: profile.id === config.expectedUserId,
      p_encrypted_tokens: await box.encrypt(
        input.pair,
        `tokens:${input.epoch}`,
      ),
      p_access_expires_at: input.expiresAt,
      p_authorized_at: input.authorizedAt,
      p_session_hash: await sha256(session),
      p_bootstrap: input.bootstrap,
    });
    return accepted ? session : null;
  }
  return async (req: Request): Promise<Response> => {
    if (
      !await secretMatches(
        req.headers.get("x-proxy-secret"),
        config.proxySecret,
      )
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    const path = pathFor(req, "api");
    const url = new URL(req.url);
    try {
      if (path === "/healthz" && req.method === "GET") {
        return json({
          apiSha: config.sha,
          ...await db.rpc<Record<string, unknown>>("app_health"),
        });
      }
      if (path === "/internal/bootstrap") {
        if (
          !await secretMatches(
            req.headers.get("x-bootstrap-secret"),
            config.bootstrapSecret,
          )
        ) {
          return json({ error: "unauthorized" }, 401);
        }
        if (
          req.headers.has("Origin") &&
          req.headers.get("Origin") !== config.origin
        ) {
          return json({ error: "invalid_origin" }, 403);
        }
        const status = await db.rpc<AccountStatus>("app_account_status");
        if (req.method === "GET") {
          return json({ consumed: status.bootstrapConsumed });
        }
        if (req.method !== "POST") {
          return json({ error: "method_not_allowed" }, 405);
        }
        if (status.bootstrapConsumed) return json({ consumed: true });
        if (status.state !== "disconnected" || status.ownerBound) {
          return json({ error: "bootstrap_unavailable" }, 409);
        }
        const body = await readJson(req);
        if (
          stringField(body, "clientId") !== config.clientId ||
          stringField(body, "userId") !== config.expectedUserId
        ) return json({ error: "wrong_account" }, 403);
        const scopes = body.scopes;
        if (
          !Array.isArray(scopes) ||
          SPOTIFY_SCOPES.some((scope) => !scopes.includes(scope))
        ) {
          return json({ error: "missing_scopes" }, 400);
        }
        const authorizedAt = validDate(stringField(body, "authorizedAt"));
        const expiresAt = validDate(stringField(body, "accessExpiresAt"));
        if (Date.parse(expiresAt) <= now()) {
          return json({ error: "bootstrap_access_expired" }, 409);
        }
        const session = await persistGrant({
          epoch: status.epoch,
          pair: {
            accessToken: stringField(body, "accessToken"),
            refreshToken: stringField(body, "refreshToken"),
          },
          expiresAt,
          authorizedAt,
          bootstrap: true,
        });
        if (!session) return json({ error: "bootstrap_conflict" }, 409);
        return json({ consumed: true }, 200, {
          "Set-Cookie": cookie(SESSION_COOKIE, session, 30 * 24 * 60 * 60),
        });
      }
      if (path === "/auth/spotify/start" && req.method === "GET") {
        const state = opaqueToken(),
          browser = opaqueToken(),
          verifier = opaqueToken();
        const stateHash = await sha256(state);
        await db.rpc("app_oauth_start", {
          p_state_hash: stateHash,
          p_browser_hash: await sha256(browser),
          p_encrypted_verifier: await box.encrypt(
            verifier,
            `oauth:${stateHash}`,
          ),
        });
        const auth = new URL("https://accounts.spotify.com/authorize");
        auth.search = new URLSearchParams({
          client_id: config.clientId,
          response_type: "code",
          redirect_uri: `${config.origin}/auth/spotify/callback`,
          state,
          code_challenge_method: "S256",
          code_challenge: await pkceChallenge(verifier),
          scope: SPOTIFY_SCOPES.join(" "),
          show_dialog: "true",
        }).toString();
        return redirect(auth.toString(), [cookie(OAUTH_COOKIE, browser, 600)]);
      }
      if (path === "/auth/spotify/callback" && req.method === "GET") {
        const state = url.searchParams.get("state"),
          browser = readCookie(req, OAUTH_COOKIE);
        if (!state || !browser || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
          return authFailure("invalid_state");
        }
        const stateHash = await sha256(state);
        const grant = await db.rpc<
          { epoch: number; encryptedVerifier: string } | null
        >(
          "app_oauth_consume",
          { p_state_hash: stateHash, p_browser_hash: await sha256(browser) },
        );
        if (!grant) return authFailure("invalid_state");
        if (url.searchParams.get("error")) {
          return authFailure(
            url.searchParams.get("error") === "access_denied"
              ? "consent_denied"
              : "authorization_failed",
          );
        }
        const code = url.searchParams.get("code");
        if (!code || code.length > 4096) return authFailure("invalid_callback");
        const verifier = await box.decrypt<string>(
          grant.encryptedVerifier,
          `oauth:${stateHash}`,
        );
        const tokens = await exchangeToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: config.clientId,
            code,
            redirect_uri: `${config.origin}/auth/spotify/callback`,
            code_verifier: verifier,
          }),
          request,
        );
        if (
          !tokens.refreshToken ||
          SPOTIFY_SCOPES.some((scope) => !tokens.scopes?.includes(scope))
        ) return authFailure("missing_scopes");
        const session = await persistGrant({
          epoch: grant.epoch,
          pair: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          },
          expiresAt: new Date(now() + tokens.expiresIn * 1000).toISOString(),
          authorizedAt: new Date(now()).toISOString(),
          bootstrap: false,
        });
        if (!session) return authFailure("authorization_cancelled");
        return redirect(config.origin, [
          CLEAR_OAUTH,
          cookie(SESSION_COOKIE, session, 30 * 24 * 60 * 60),
        ]);
      }
      // No protected handler may run based on proxy trust alone. Even reconnect sessions need this lookup.
      const token = readCookie(req, SESSION_COOKIE);
      const session = token
        ? await db.rpc<Session | null>("app_session", {
          p_token_hash: await sha256(token),
        })
        : null;
      if (path === "/api/session" && req.method === "GET") {
        if (!session) {
          const status = await db.rpc<AccountStatus>("app_account_status");
          return json({
            authenticated: false,
            connection: status.state === "disconnecting"
              ? "disconnecting"
              : "disconnected",
          });
        }
        const daysRemaining = Math.ceil(
          (Date.parse(session.authorizationDeadline) - now()) / 86400000,
        );
        return json({
          authenticated: true,
          connection: session.state,
          authorizationDeadline: session.authorizationDeadline,
          reconnectWarning: session.state === "reconnect"
            ? "required"
            : daysRemaining <= 7
            ? "seven_days"
            : daysRemaining <= 30
            ? "thirty_days"
            : null,
        });
      }
      if (!session) return json({ error: "unauthorized" }, 401);
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.headers.get("Origin") !== config.origin
      ) return json({ error: "invalid_origin" }, 403);
      if (path === "/api/disconnect" && req.method === "POST") {
        const body = await readJson(req);
        if (body.confirmation !== "DELETE ALL APP DATA") {
          return json({ error: "confirmation_required" }, 400);
        }
        const result = await db.rpc<{ epoch: number; jobId: string } | null>(
          "app_disconnect",
          {
            p_epoch: session.epoch,
          },
        );
        if (!result) return json({ error: "session_changed" }, 409);
        return json(
          {
            disconnected: true,
            purgeComplete: false,
            connection: "disconnecting",
            detail: DISCONNECT_REMAINS,
            revokeUrl: "https://www.spotify.com/account/apps/",
          },
          202,
          { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) },
        );
      }
      const library = await libraryApi(
        req,
        path,
        await sha256(token!),
        session.epoch,
        db,
      );
      if (library) return library;
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof ContractError) {
        return json({ error: "invalid_input" }, 400);
      }
      if (
        error instanceof DatabaseError &&
        !["wrong_account", "unavailable"].includes(error.kind)
      ) {
        return json(
          { error: error.kind },
          error.kind === "invalid_input" ? 400 : 409,
        );
      }
      const kind = error instanceof SpotifyError
        ? error.kind === "forbidden"
          ? "forbidden"
          : error.kind === "authentication"
          ? "reconnect"
          : "temporarily_unavailable"
        : error instanceof DatabaseError && error.kind === "wrong_account"
        ? "wrong_account"
        : error instanceof Error && error.message === "invalid_input"
        ? "invalid_input"
        : "temporarily_unavailable";
      if (path === "/auth/spotify/callback") return authFailure(kind);
      return json(
        { error: kind },
        kind === "wrong_account" || kind === "forbidden"
          ? 403
          : kind === "invalid_input"
          ? 400
          : 503,
      );
    }
  };
}
