import { type ApiConfig, createApi } from "./handler.ts";
import { SecretBox } from "../_shared/crypto.ts";
import { SESSION_COOKIE } from "../_shared/http.ts";
import { assert, database, equal, TEST_KEY } from "../_shared/testing.ts";
const config: ApiConfig = {
  origin: "https://synthetic.example",
  sha: "a".repeat(40),
  clientId: "synthetic-client",
  expectedUserId: "synthetic-owner",
  proxySecret: "p".repeat(32),
  bootstrapSecret: "b".repeat(32),
  ownerBindingKey: TEST_KEY,
};
const box = new SecretBox(TEST_KEY);
const pair = {
  accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh",
  scopes: ["streaming", "user-modify-playback-state"],
};
const uri = `spotify:track:${"a".repeat(22)}`;
function request(
  path: string,
  body: unknown = {},
  auth = true,
  origin = config.origin,
) {
  return new Request(`${config.origin}/functions/v1/api/api/playback/${path}`, {
    method: "POST",
    headers: {
      "x-proxy-secret": config.proxySecret,
      "Content-Type": "application/json",
      Origin: origin,
      ...(auth ? { Cookie: `${SESSION_COOKIE}=${"s".repeat(43)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
Deno.test("playback routes require owner session and mutation origin before reading grants", async () => {
  const handler = createApi({
    config,
    box,
    db: database((name) => {
      equal(name, "app_session");
      return { epoch: 1, state: "connected" };
    }),
  });
  for (const path of ["token", "start", "enable"]) {
    equal((await handler(request(path, {}, false))).status, 401);
    equal(
      (await handler(request(path, {}, true, "https://attacker.example")))
        .status,
      403,
    );
  }
});
Deno.test("playback token is no-store and never includes refresh credential", async () => {
  const encryptedTokens = await box.encrypt(pair, "tokens:1");
  const handler = createApi({
    config,
    box,
    db: database((name) =>
      name === "app_session"
        ? { epoch: 1, state: "connected" }
        : { action: "cached", version: 1, encryptedTokens }
    ),
  });
  const response = await handler(request("token"));
  equal(response.status, 200);
  equal(response.headers.get("Cache-Control"), "no-store");
  equal(await response.json(), { accessToken: pair.accessToken });
});
Deno.test("legacy grants cannot be delivered to browser or dispatch playback", async () => {
  const encryptedTokens = await box.encrypt({
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
  }, "tokens:1");
  let network = 0;
  const handler = createApi({
    config,
    box,
    db: database((name) =>
      name === "app_session"
        ? { epoch: 1, state: "connected" }
        : name === "app_playback_track"
        ? { uri, durationMs: 180001 }
        : { action: "cached", version: 1, encryptedTokens }
    ),
    fetch: () => {
      network++;
      throw new Error("unexpected");
    },
  });
  for (
    const req of [
      request("token"),
      request("start", {
        trackKey: "a".repeat(64),
        deviceId: "synthetic-device-1234567890",
      }),
    ]
  ) {
    equal(await (await handler(req)).json(), { error: "playback_required" });
  }
  equal(network, 0);
});
Deno.test("start resolves active library metadata, floors one-third and targets only the explicit SDK device", async () => {
  const encryptedTokens = await box.encrypt(pair, "tokens:1");
  let writes = 0;
  const handler = createApi({
    config,
    box,
    db: database((name, args) => {
      if (name === "app_session") return { epoch: 1, state: "connected" };
      if (name === "app_playback_track") {
        equal(args, { p_epoch: 1, p_track_key: "a".repeat(64) });
        return { uri, durationMs: 180001 };
      }
      if (name === "app_token_claim") {
        return { action: "cached", version: 1, encryptedTokens };
      }
      equal(name, "app_pacing_acquire");
      return { granted: true, retryAfterMs: 0 };
    }),
    fetch: (url, init) => {
      writes++;
      equal(
        String(url),
        "https://api.spotify.com/v1/me/player/play?device_id=synthetic-device-1234567890",
      );
      equal(init?.method, "PUT");
      equal(JSON.parse(init?.body as string), {
        uris: [uri],
        position_ms: 60000,
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  const response = await handler(
    request("start", {
      trackKey: "a".repeat(64),
      deviceId: "synthetic-device-1234567890",
    }),
  );
  equal(response.status, 200);
  equal(await response.json(), { uri, positionMs: 60000, durationMs: 180001 });
  equal(writes, 1);
});
Deno.test("arbitrary URI/URL/position and invalid device input never reach token or Spotify", async () => {
  const handler = createApi({
    config,
    box,
    db: database((name) => {
      equal(name, "app_session");
      return { epoch: 1, state: "connected" };
    }),
  });
  for (
    const body of [{ trackKey: "a".repeat(64), deviceId: "" }, {
      trackKey: "https://synthetic.example",
      deviceId: "synthetic-device-1234567890",
    }, {
      trackKey: "a".repeat(64),
      deviceId: "synthetic-device-1234567890",
      uri,
    }, {
      trackKey: "a".repeat(64),
      deviceId: "synthetic-device-1234567890",
      positionMs: 0,
    }]
  ) equal((await handler(request("start", body))).status, 400);
});
Deno.test("unavailable/removed lookup prevents dispatch and reconnect sessions preserve tagging without playback", async () => {
  for (const state of ["connected", "reconnect"]) {
    const handler = createApi({
      config,
      box,
      db: database((name) => {
        if (name === "app_session") return { epoch: 1, state };
        equal(name, "app_playback_track");
        return null;
      }),
    });
    const response = await handler(
      request("start", {
        trackKey: "a".repeat(64),
        deviceId: "synthetic-device-1234567890",
      }),
    );
    equal(response.status, 409);
    equal(await response.json(), {
      error: state === "connected" ? "track_unavailable" : "reconnect",
    });
  }
});
Deno.test("optional playback consent records intent in server-encrypted verifier and adds no profile scopes", async () => {
  let encrypted = "";
  const handler = createApi({
    config,
    box,
    db: database((name, args) => {
      if (name === "app_session") return { epoch: 1, state: "connected" };
      equal(name, "app_oauth_start");
      encrypted = String(args.p_encrypted_verifier);
      return true;
    }),
  });
  const response = await handler(request("enable"));
  equal(response.status, 200);
  assert(response.headers.get("Set-Cookie")?.includes("HttpOnly"));
  const url = new URL((await response.json()).url);
  const scopes = url.searchParams.get("scope")!.split(" ");
  assert(
    scopes.includes("streaming") &&
      scopes.includes("user-modify-playback-state"),
  );
  assert(
    !scopes.some((s) => /email|private$/.test(s) && s.startsWith("user-")),
  );
  assert(encrypted.length > 20);
  assert(!encrypted.includes("verifier"));
});
