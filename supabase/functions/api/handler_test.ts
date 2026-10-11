import { mockResponse } from "../_shared/testing.ts";
import { type ApiConfig, createApi } from "./handler.ts";
import { SecretBox, sha256 } from "../_shared/crypto.ts";
import { OAUTH_COOKIE, SESSION_COOKIE } from "../_shared/http.ts";
import { DatabaseError } from "../_shared/database.ts";
import { assert, database, equal, TEST_KEY } from "../_shared/testing.ts";
import { SPOTIFY_SCOPES } from "../_shared/spotify.ts";
const config: ApiConfig = {
  origin: "https://synthetic.example",
  sha: "a".repeat(40),
  clientId: "synthetic-client",
  expectedUserId: "synthetic-owner",
  proxySecret: "p".repeat(32),
  bootstrapSecret: "b".repeat(32),
  ownerBindingKey: TEST_KEY,
};
const box = new SecretBox(TEST_KEY),
  session = "s".repeat(43),
  oauth = "o".repeat(43),
  state = "t".repeat(43);
const authenticated = {
  epoch: 1,
  state: "connected",
  authorizedAt: new Date().toISOString(),
  authorizationDeadline: "2099-01-01T00:00:00.000Z",
};
function request(path: string, init: RequestInit = {}): Request {
  return new Request(config.origin + path, {
    ...init,
    headers: { "x-proxy-secret": config.proxySecret, ...init.headers },
  });
}
Deno.test("proxy secret protects health OAuth bootstrap and owner routes before any database call", async () => {
  const handler = createApi({
    config,
    box,
    db: database(() => {
      throw new Error("database must not run");
    }),
  });
  for (
    const path of [
      "/healthz",
      "/auth/spotify/start",
      "/auth/spotify/callback",
      "/internal/bootstrap",
      "/api/session",
      "/api/disconnect",
    ]
  ) {
    equal((await handler(new Request(config.origin + path))).status, 401);
  }
});
Deno.test("health includes deployment SHA and DB scheduler evidence", async () => {
  const handler = createApi({
    config,
    box,
    db: database(() => ({
      jobsSha: "b".repeat(40),
      lastSchedulerAt: "synthetic-time",
      lastJobAt: null,
    })),
  });
  const body = await (await handler(request("/functions/v1/api/healthz")))
    .json();
  equal(body.apiSha, config.sha);
  equal(body.jobsSha, "b".repeat(40));
  equal(body.lastSchedulerAt, "synthetic-time");
});
Deno.test("only opaque owner session authorizes protected mutation and same-origin confirmation is required", async () => {
  let disconnects = 0;
  const handler = createApi({
    config,
    box,
    db: database((name, args) => {
      if (name === "app_session") {
        return args.p_token_hash ? authenticated : null;
      }
      if (name === "app_disconnect") {
        disconnects++;
        return { epoch: 2, jobId: "synthetic" };
      }
      return { state: "disconnected" };
    }),
  });
  equal(
    (await handler(request("/api/disconnect", { method: "POST" }))).status,
    401,
  );
  const cookie = `${SESSION_COOKIE}=${session}`;
  equal(
    (await handler(
      request("/api/disconnect", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://attacker.example" },
      }),
    )).status,
    403,
  );
  equal(
    (await handler(
      request("/api/disconnect", {
        method: "POST",
        headers: { Cookie: cookie },
      }),
    ))
      .status,
    403,
  );
  equal(
    (await handler(
      request("/api/disconnect", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: config.origin,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    )).status,
    400,
  );
  const result = await handler(
    request("/api/disconnect", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: config.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirmation: "DELETE ALL APP DATA" }),
    }),
  );
  equal(result.status, 202);
  equal(disconnects, 1);
  assert(result.headers.get("Set-Cookie")?.includes("Max-Age=0"));
  const body = await result.json();
  equal(body.purgeComplete, false);
  assert(body.detail.includes("fingerprint"));
});
Deno.test("unknown, expired, or duplicate cookies do not authenticate", async () => {
  const handler = createApi({
    config,
    box,
    db: database((name) =>
      name === "app_session" ? null : { state: "disconnecting" }
    ),
  });
  for (
    const cookie of [
      `${SESSION_COOKIE}=${session}`,
      `${SESSION_COOKIE}=${session}; ${SESSION_COOKIE}=${session}`,
    ]
  ) {
    const body = await (await handler(
      request("/api/session", { headers: { Cookie: cookie } }),
    ))
      .json();
    equal(body.authenticated, false);
    equal(body.connection, "disconnecting");
  }
});
Deno.test("OAuth start keeps PKCE verifier server-side with expiring secure browser cookie", async () => {
  let verifier = "";
  let stored = false;
  const handler = createApi({
    config,
    box,
    db: database(async (name, args) => {
      equal(name, "app_oauth_start");
      stored = true;
      verifier = await box.decrypt(
        args.p_encrypted_verifier as string,
        `oauth:${args.p_state_hash}`,
      );
      return 1;
    }),
  });
  const response = await handler(request("/auth/spotify/start"));
  equal(response.status, 303);
  assert(stored);
  const location = new URL(response.headers.get("Location")!);
  equal(location.origin, "https://accounts.spotify.com");
  assert(!location.toString().includes(verifier));
  equal(location.searchParams.get("code_challenge_method"), "S256");
  const scopes = location.searchParams.get("scope")!;
  assert(!scopes.includes("user-read"));
  equal(scopes, SPOTIFY_SCOPES.join(" "));
  const cookie = response.headers.get("Set-Cookie")!;
  for (
    const part of [
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=600",
      "Path=/",
    ]
  ) {
    assert(cookie.includes(part));
  }
});
Deno.test("OAuth invalid state or missing browser cookie cannot contact token endpoint", async () => {
  let contacts = 0;
  const handler = createApi({
    config,
    box,
    db: database(() => null),
    fetch: () => {
      contacts++;
      throw new Error("unexpected");
    },
  });
  const response = await handler(
    request(`/auth/spotify/callback?state=${state}&code=synthetic`),
  );
  assert(
    response.headers.get("Location")?.endsWith("auth_error=invalid_state"),
  );
  equal(contacts, 0);
});
Deno.test("consent denial consumes browser-bound state and shows explicit denial", async () => {
  let consumed = false;
  const handler = createApi({
    config,
    box,
    db: database((name) => {
      equal(name, "app_oauth_consume");
      consumed = true;
      return { epoch: 1, encryptedVerifier: "unused" };
    }),
  });
  const response = await handler(
    request(`/auth/spotify/callback?state=${state}&error=access_denied`, {
      headers: { Cookie: `${OAUTH_COOKIE}=${oauth}` },
    }),
  );
  assert(
    response.headers.get("Location")?.endsWith("auth_error=consent_denied"),
  );
  assert(consumed);
});
async function oauthHandler(
  outcome: "ok" | "wrong" | "cancelled" | "forbidden",
) {
  let requests = 0;
  let connectArgs: Record<string, unknown> | undefined;
  const handler = createApi({
    config,
    box,
    db: database(async (name, args) => {
      if (name === "app_oauth_consume") {
        return {
          epoch: 1,
          encryptedVerifier: await box.encrypt(
            "synthetic-verifier",
            `oauth:${await sha256(state)}`,
          ),
        };
      }
      if (name === "app_pacing_acquire") {
        return { granted: true, retryAfterMs: 0 };
      }
      if (name === "app_connect") {
        connectArgs = args;
        if (outcome === "wrong") throw new DatabaseError("wrong_account");
        return outcome !== "cancelled";
      }
      throw new Error("unexpected database call");
    }),
    fetch: () => {
      requests++;
      if (requests === 1) {
        return mockResponse(
          JSON.stringify({
            access_token: "synthetic-token",
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: SPOTIFY_SCOPES.join(" "),
          }),
        );
      }
      if (outcome === "forbidden") {
        return mockResponse(
          JSON.stringify({ error: { message: "upstream sensitive" } }),
          {
            status: 403,
          },
        );
      }
      return mockResponse(
        JSON.stringify({
          id: "synthetic-owner",
          account_id: "synthetic-immutable-account",
        }),
      );
    },
  });
  const result = await handler(
    request(`/auth/spotify/callback?state=${state}&code=synthetic`, {
      headers: { Cookie: `${OAUTH_COOKIE}=${oauth}` },
    }),
  );
  return { result, connectArgs };
}
Deno.test("OAuth success persists encrypted grant and hashed session before issuing secure cookie", async () => {
  const { result, connectArgs } = await oauthHandler("ok");
  equal(result.status, 303);
  equal(result.headers.get("Location"), config.origin);
  assert(connectArgs);
  equal((connectArgs.p_session_hash as string).length, 64);
  assert(
    !(connectArgs.p_encrypted_tokens as string).includes("synthetic-token"),
  );
  assert(result.headers.get("Set-Cookie")?.includes(SESSION_COOKIE));
});
for (
  const [outcome, code] of [["wrong", "wrong_account"], [
    "cancelled",
    "authorization_cancelled",
  ], [
    "forbidden",
    "forbidden",
  ]] as const
) {
  Deno.test(`OAuth ${outcome} does not issue owner session or invent forbidden cause`, async () => {
    const { result } = await oauthHandler(outcome);
    assert(result.headers.get("Location")?.endsWith(`auth_error=${code}`));
    assert(!result.headers.get("Set-Cookie")?.includes(SESSION_COOKIE));
    assert(!result.headers.get("Location")?.includes("allowlist"));
  });
}
Deno.test("bootstrap requires independent operator secret and does not return grant data", async () => {
  const handler = createApi({
    config,
    box,
    db: database(() => ({ bootstrapConsumed: true })),
  });
  equal((await handler(request("/internal/bootstrap"))).status, 401);
  const result = await handler(
    request("/internal/bootstrap", {
      headers: { "x-bootstrap-secret": config.bootstrapSecret },
    }),
  );
  equal(await result.json(), { consumed: true });
});
Deno.test("bootstrap retains original authorization and only reports consumption after accepted commit", async () => {
  let connect: Record<string, unknown> | undefined;
  const handler = createApi({
    config,
    box,
    db: database((name, args) => {
      if (name === "app_account_status") {
        return {
          epoch: 1,
          state: "disconnected",
          bootstrapConsumed: false,
          ownerBound: false,
        };
      }
      if (name === "app_pacing_acquire") {
        return { granted: true, retryAfterMs: 0 };
      }
      if (name === "app_connect") {
        connect = args;
        return true;
      }
      throw new Error("unexpected");
    }),
    fetch: () =>
      mockResponse(
        JSON.stringify({
          id: "synthetic-owner",
          account_id: "synthetic-account",
        }),
      ),
  });
  const authorizedAt = "2026-10-01T00:00:00.000Z";
  const response = await handler(
    request("/internal/bootstrap", {
      method: "POST",
      headers: {
        "x-bootstrap-secret": config.bootstrapSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId: config.clientId,
        userId: config.expectedUserId,
        authorizedAt,
        accessExpiresAt: "2099-01-01T00:00:00Z",
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        scopes: SPOTIFY_SCOPES,
      }),
    }),
  );
  equal(await response.json(), { consumed: true });
  assert(connect);
  equal(connect.p_authorized_at, authorizedAt);
  equal(connect.p_session_hash, null);
});
