// Operator-only: call directly, never expose through the product proxy.
import { existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentHead,
  privateFetch,
  privateJson,
  readJson,
  requireCheck,
  validateTargets,
} from "./live/config.mjs";
export async function importBootstrap(root) {
  const local = resolve(root, ".local");
  const config = validateTargets(readJson(resolve(local, "config.json")));
  const head = currentHead(root);
  const keys = readJson(resolve(local, "runtime-keys.json"));
  const url = `https://${config.supabaseProjectRef}.supabase.co/functions/v1/api/internal/bootstrap`;
  const headers = {
    "x-proxy-secret": keys.proxySecret,
    "x-bootstrap-secret": keys.bootstrapSecret,
    "content-type": "application/json",
  };
  const get = await privateFetch(url, { headers });
  requireCheck(get.ok, "bootstrap_status_unavailable");
  const status = await get.json();
  const path = resolve(local, "spotify-bootstrap.json");
  if (status.consumed === true) {
    // A committed server state also reconciles a previous lost POST response.
    privateJson(resolve(local, "spotify-bootstrap-consumed.json"), {
      consumed: true,
      buildSha: head,
      verifiedAt: new Date().toISOString(),
    });
    if (existsSync(path)) unlinkSync(path);
    return { consumed: true, previouslyCommitted: true, sessionIssued: false };
  }
  let grant = readJson(path);
  requireCheck(
    !Object.hasOwn(grant, "refreshAttemptedAt"),
    "bootstrap_refresh_ambiguous_reconnect_required",
  );
  requireCheck(
    grant.clientId === config.spotifyClientId &&
      grant.userId === config.spotifyExpectedUserId &&
      typeof grant.accountId === "string" &&
      Number.isFinite(Date.parse(grant.authorizedAt)),
    "bootstrap_grant_mismatch",
  );
  if (!(Date.parse(grant.accessExpiresAt) > Date.now() + 60_000)) {
    // Save before dispatch so a crash/lost response cannot replay a possibly
    // rotated refresh token. A fresh setup OAuth grant replaces this whole file.
    privateJson(path, {
      ...grant,
      refreshAttemptedAt: new Date().toISOString(),
    });
    try {
      const response = await privateFetch(
        "https://accounts.spotify.com/api/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: config.spotifyClientId,
            refresh_token: grant.refreshToken,
          }),
        },
      );
      const tokens = await response.json();
      if (response.status === 400 && tokens?.error === "invalid_grant") {
        // A definitive OAuth refusal did not rotate the grant.
        privateJson(path, grant);
        requireCheck(false, "bootstrap_refresh_rejected_reconnect_required");
      }
      requireCheck(
        response.ok &&
          tokens !== null &&
          typeof tokens === "object" &&
          typeof tokens.access_token === "string" &&
          tokens.access_token.length > 0 &&
          Number.isSafeInteger(tokens.expires_in) &&
          tokens.expires_in > 0 &&
          tokens.expires_in <= 86400 &&
          (tokens.refresh_token === undefined ||
            (typeof tokens.refresh_token === "string" &&
              tokens.refresh_token.length > 0)),
        "bootstrap_refresh_ambiguous_reconnect_required",
      );
      const refreshed = {
        ...grant,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? grant.refreshToken,
        accessExpiresAt: new Date(
          Date.now() + tokens.expires_in * 1000,
        ).toISOString(),
      };
      // Clear the marker only with the safely saved rotation. authorizedAt stays original.
      privateJson(path, refreshed);
      grant = refreshed;
    } catch (error) {
      requireCheck(
        false,
        error.code === "bootstrap_refresh_rejected_reconnect_required"
          ? error.code
          : "bootstrap_refresh_ambiguous_reconnect_required",
      );
    }
  }
  const response = await privateFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(grant),
  });
  requireCheck(
    response.ok && (await response.json()).consumed === true,
    "bootstrap_import_unconfirmed",
  );
  const sessionCookies = response.headers
    .getSetCookie()
    .filter((value) => value.startsWith("__Host-sp_session="));
  requireCheck(
    sessionCookies.length === 1 &&
      /^__Host-sp_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/.test(
        sessionCookies[0],
      ),
    "bootstrap_session_cookie_unconfirmed",
  );
  // This cookie exists only after the live identity check and accepted app_connect transaction.
  // Persist it before the subsequent confirmation request, which might fail independently.
  privateJson(resolve(local, "owner-session.json"), {
    origin: config.appUrl,
    cookie: sessionCookies[0].split(";")[0],
    source: "verified-bootstrap-oauth",
    issuedAt: new Date().toISOString(),
  });
  const committed = await privateFetch(url, { headers });
  requireCheck(
    committed.ok && (await committed.json()).consumed === true,
    "bootstrap_commit_unconfirmed",
  );
  privateJson(resolve(local, "spotify-bootstrap-consumed.json"), {
    consumed: true,
    buildSha: head,
    verifiedAt: new Date().toISOString(),
    authorizedAt: grant.authorizedAt,
  });
  unlinkSync(path);
  return { consumed: true, previouslyCommitted: false, sessionIssued: true };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  importBootstrap(resolve(dirname(fileURLToPath(import.meta.url)), ".."))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          consumed: false,
          blocker: error.code ?? "bootstrap_import_failed",
        }),
      );
      process.exitCode = 1;
    });
}
