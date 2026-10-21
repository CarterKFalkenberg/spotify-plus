import { createApi } from "./handler.ts";
import { SecretBox } from "../_shared/crypto.ts";
import {
  PLAYBACK_SCOPES,
  SOURCE_SCOPES,
  SPOTIFY_SCOPES,
} from "../_shared/spotify.ts";
import { OAUTH_COOKIE, SESSION_COOKIE } from "../_shared/http.ts";
import { assert, database, equal, TEST_KEY } from "../_shared/testing.ts";
const config = {
  origin: "https://synthetic.example",
  sha: "a".repeat(40),
  clientId: "synthetic-client",
  expectedUserId: "synthetic-owner",
  proxySecret: "p".repeat(32),
  bootstrapSecret: "b".repeat(32),
  ownerBindingKey: TEST_KEY,
};
const box = new SecretBox(TEST_KEY);
function req(path: string, body?: unknown, authorized = true) {
  return new Request(config.origin + "/functions/v1/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-proxy-secret": config.proxySecret,
      "content-type": "application/json",
      origin: config.origin,
      ...(authorized ? { cookie: `${SESSION_COOKIE}=${"s".repeat(43)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
Deno.test("source APIs retain owner/origin boundaries and cached scope proof never fetches Spotify", async () => {
  let calls = 0;
  const encrypted = await box.encrypt({
    accessToken: "synthetic",
    refreshToken: "synthetic",
    scopes: SPOTIFY_SCOPES,
  }, "tokens:1");
  const api = createApi({
    config,
    box,
    db: database((name, args) => {
      if (name === "app_session") return { epoch: 1, state: "connected" };
      calls++;
      if (name === "app_token_scope_proof") return encrypted;
      if (name === "app_sources_list") {
        equal(args, { p_epoch: 1, p_search: "", p_offset: 50, p_limit: 100 });
        return { items: [], total: 0 };
      }
      if (name === "app_sources_selection") return { changedCount: 1 };
      if (name === "app_sources_sync") return { queued: true };
      throw Error("unexpected RPC");
    }),
    fetch: () => {
      throw Error("provider must not be called");
    },
  });
  for (
    const path of [
      "/api/sources/selection",
      "/api/sources/sync",
      "/api/sources/enable",
    ]
  ) equal((await api(req(path, {}, false))).status, 401);
  equal(calls, 0);
  const listed = await api(req("/api/sources?offset=50&limit=100"));
  equal(listed.status, 200);
  equal((await listed.json()).collaborativeConsentRequired, true);
  equal(
    (await api(
      req("/api/sources/selection", { ids: ["liked"], enabled: false }),
    )).status,
    200,
  );
  equal((await api(req("/api/sources/sync", {}))).status, 200);
  equal((await api(req("/api/sources?offset=-1"))).status, 400);
});
Deno.test("source optional consent preserves verified playback scope and encrypts exact callback intent", async () => {
  const encrypted = await box.encrypt({
    accessToken: "synthetic",
    refreshToken: "synthetic",
    scopes: [...SPOTIFY_SCOPES, ...PLAYBACK_SCOPES],
  }, "tokens:1");
  let verifier = "";
  let stateHash = "";
  const api = createApi({
    config,
    box,
    db: database((name, args) => {
      if (name === "app_session") return { epoch: 1, state: "connected" };
      if (name === "app_token_scope_proof") return encrypted;
      if (name === "app_oauth_start") {
        verifier = args.p_encrypted_verifier as string;
        stateHash = args.p_state_hash as string;
        return true;
      }
      throw Error("unexpected RPC");
    }),
  });
  const response = await api(req("/api/sources/enable", {}));
  equal(response.status, 200);
  const auth = new URL((await response.json()).url);
  equal(auth.origin, "https://accounts.spotify.com");
  equal(
    new Set(auth.searchParams.get("scope")!.split(" ")).size,
    SPOTIFY_SCOPES.length + PLAYBACK_SCOPES.length + SOURCE_SCOPES.length,
  );
  const intent = await box.decrypt<
    { sources: boolean; retainedScopes: string[] }
  >(verifier, `oauth:${stateHash}`);
  equal(intent.sources, true);
  equal(intent.retainedScopes, [...PLAYBACK_SCOPES]);
  assert(response.headers.get("set-cookie")?.startsWith(OAUTH_COOKIE));
});
Deno.test("source OAuth missing scope or denial preserves old grant without connect", async () => {
  for (const denied of [false, true]) {
    const state = "s".repeat(43);
    let tokenRequests = 0;
    const { sha256 } = await import("../_shared/crypto.ts");
    const verifier = await box.encrypt({
      verifier: "synthetic-verifier",
      sources: true,
      retainedScopes: [...PLAYBACK_SCOPES],
    }, `oauth:${await sha256(state)}`);
    const api = createApi({
      config,
      box,
      db: database((name) => {
        equal(name, "app_oauth_consume");
        return { epoch: 1, encryptedVerifier: verifier };
      }),
      fetch: () => {
        tokenRequests++;
        return Promise.resolve(
          Response.json({
            access_token: "synthetic",
            refresh_token: "synthetic",
            expires_in: 3600,
            token_type: "Bearer",
            scope: [...SPOTIFY_SCOPES, ...SOURCE_SCOPES].join(" "),
          }),
        );
      },
    });
    const response = await api(
      new Request(
        `${config.origin}/functions/v1/api/auth/spotify/callback?state=${state}&${
          denied ? "error=access_denied" : "code=synthetic-code"
        }`,
        {
          headers: {
            "x-proxy-secret": config.proxySecret,
            cookie: `${OAUTH_COOKIE}=${"b".repeat(43)}`,
          },
        },
      ),
    );
    equal(response.status, 303);
    assert(
      response.headers.get("location")?.includes(
        denied ? "consent_denied" : "missing_scopes",
      ),
    );
    equal(tokenRequests, denied ? 0 : 1);
  }
});
