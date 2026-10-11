import { mockResponse } from "./testing.ts";
import { SecretBox } from "./crypto.ts";
import { exchangeToken, OwnerTokens } from "./tokens.ts";
import { SpotifyError } from "./spotify.ts";
import { assert, database, equal, rejects, TEST_KEY } from "./testing.ts";
const box = new SecretBox(TEST_KEY);
const pair = {
  accessToken: "synthetic-old-access",
  refreshToken: "synthetic-old-refresh",
};
Deno.test("refresh persists rotated token before returning access and retains supplied epoch", async () => {
  const encrypted = await box.encrypt(pair, "tokens:3");
  let persisted = false;
  const db = database(async (name, args) => {
    equal(args.p_epoch, 3);
    if (name === "app_token_claim") {
      return {
        action: "refresh",
        encryptedTokens: encrypted,
        version: 8,
        lease: "lease",
      };
    }
    equal(name, "app_token_finish");
    equal(await box.decrypt(args.p_encrypted_tokens as string, "tokens:3"), {
      accessToken: "synthetic-new-access",
      refreshToken: "synthetic-rotated",
    });
    assert(!("p_authorized_at" in args));
    persisted = true;
    return true;
  });
  const tokens = new OwnerTokens(
    db,
    box,
    3,
    "client",
    () =>
      mockResponse(
        JSON.stringify({
          access_token: "synthetic-new-access",
          refresh_token: "synthetic-rotated",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      ),
  );
  equal(await tokens.getAccessToken(), "synthetic-new-access");
  assert(persisted);
});
Deno.test("refresh without replacement preserves previous refresh token", async () => {
  const encrypted = await box.encrypt(pair, "tokens:1");
  const db = database(async (name, args) => {
    if (name === "app_token_claim") {
      return {
        action: "refresh",
        encryptedTokens: encrypted,
        version: 1,
        lease: "lease",
      };
    }
    equal(
      (await box.decrypt<{ refreshToken: string }>(
        args.p_encrypted_tokens as string,
        "tokens:1",
      ))
        .refreshToken,
      pair.refreshToken,
    );
    return true;
  });
  await new OwnerTokens(
    db,
    box,
    1,
    "client",
    () =>
      mockResponse(
        JSON.stringify({
          access_token: "new",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      ),
  ).getAccessToken();
});
Deno.test("refresh result rejected by cancelled epoch never returns token", async () => {
  const encrypted = await box.encrypt(pair, "tokens:1");
  const db = database((name) =>
    name === "app_token_claim"
      ? {
        action: "refresh",
        encryptedTokens: encrypted,
        version: 1,
        lease: "lease",
      }
      : false
  );
  await rejects(
    () =>
      new OwnerTokens(db, box, 1, "client", () =>
        mockResponse(
          JSON.stringify({
            access_token: "new",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        )).getAccessToken(),
    (e) => e instanceof SpotifyError && e.kind === "authentication",
  );
});
Deno.test("rotated token from another worker satisfies stale 401 without another refresh", async () => {
  const encrypted = await box.encrypt(pair, "tokens:1");
  let calls = 0;
  let forced: unknown;
  const db = database(async (_name, args) => {
    calls++;
    forced = args.p_force_version;
    return {
      action: "cached",
      encryptedTokens: calls === 1 ? encrypted : await box.encrypt(
        { ...pair, accessToken: "other-worker-access" },
        "tokens:1",
      ),
      version: calls,
    };
  });
  const tokens = new OwnerTokens(db, box, 1, "client", () => {
    throw new Error("must not call provider");
  });
  equal(await tokens.getAccessToken(), pair.accessToken);
  equal(
    await tokens.refreshAccessToken(pair.accessToken),
    "other-worker-access",
  );
  equal(forced, 1);
});
for (const failure of ["invalid_grant", "lost_response", "malformed_success"]) {
  Deno.test(`refresh ${failure} parks reconnect without replay`, async () => {
    const encrypted = await box.encrypt(pair, "tokens:1");
    let failed = false;
    let requests = 0;
    const db = database((name, args) => {
      if (name === "app_token_claim") {
        return {
          action: "refresh",
          encryptedTokens: encrypted,
          version: 1,
          lease: "lease",
        };
      }
      equal(name, "app_token_fail");
      equal(args.p_reconnect, true);
      failed = true;
      return true;
    });
    const request: typeof fetch = () => {
      requests++;
      if (failure === "lost_response") throw new Error("secret diagnostic");
      if (failure === "malformed_success") return mockResponse("malformed");
      return mockResponse(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "private provider detail",
        }),
        { status: 400 },
      );
    };
    await rejects(
      () => new OwnerTokens(db, box, 1, "client", request).getAccessToken(),
      (e) =>
        e instanceof SpotifyError && e.kind === "authentication" &&
        !e.message.includes("private"),
    );
    assert(failed);
    equal(requests, 1);
  });
}
Deno.test("busy refresh yields cooldown, not revoked consent", async () => {
  await rejects(
    () =>
      new OwnerTokens(database(() => ({ action: "busy" })), box, 1, "client")
        .getAccessToken(),
    (e) => e instanceof SpotifyError && e.kind === "cooldown",
  );
});
Deno.test("explicit token rate-limit releases lease for later retry", async () => {
  let cleared = false;
  const encrypted = await box.encrypt(pair, "tokens:1");
  const db = database((name, args) => {
    if (name === "app_token_claim") {
      return {
        action: "refresh",
        encryptedTokens: encrypted,
        version: 1,
        lease: "lease",
      };
    }
    equal(args.p_reconnect, false);
    equal(args.p_retry_ms, 20000);
    cleared = true;
    return true;
  });
  await rejects(
    () =>
      new OwnerTokens(
        db,
        box,
        1,
        "client",
        () =>
          mockResponse("{}", { status: 429, headers: { "Retry-After": "20" } }),
      ).getAccessToken(),
    (e) =>
      e instanceof SpotifyError && e.kind === "rate_limit" &&
      e.retryAfterMs === 20000,
  );
  assert(cleared);
});
Deno.test("token endpoint diagnostics never enter errors", async () => {
  await rejects(
    () =>
      exchangeToken(
        new URLSearchParams(),
        () =>
          mockResponse(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "sensitive",
            }),
            {
              status: 400,
            },
          ),
      ),
    (e) => e instanceof SpotifyError && !e.message.includes("sensitive"),
  );
});

for (const body of ["", "malformed", "null"]) {
  Deno.test(`refused token 429 with ${body || "empty"} body preserves credentials and durable Retry-After`, async () => {
    const encrypted = await box.encrypt(pair, "tokens:1");
    let retained = false;
    const db = database((name, args) => {
      if (name === "app_token_claim") {
        return {
          action: "refresh",
          encryptedTokens: encrypted,
          version: 1,
          lease: "lease",
        };
      }
      equal(name, "app_token_fail");
      equal(args.p_reconnect, false);
      equal(args.p_retry_ms, 60000);
      retained = true;
      return true;
    });
    await rejects(
      () =>
        new OwnerTokens(
          db,
          box,
          1,
          "client",
          () =>
            mockResponse(body, {
              status: 429,
              headers: { "Retry-After": "60" },
            }),
        )
          .getAccessToken(),
      (error) =>
        error instanceof SpotifyError && error.kind === "rate_limit" &&
        error.retryAfterMs === 60000 && !error.ambiguous,
    );
    assert(retained);
  });
}
Deno.test("invalid_grant classification requires an object response", async () => {
  for (const body of ["null", "[]", '"invalid_grant"']) {
    await rejects(
      () =>
        exchangeToken(
          new URLSearchParams(),
          () => mockResponse(body, { status: 400 }),
        ),
      (error) => error instanceof SpotifyError && error.kind === "response",
    );
  }
});

Deno.test("local decryption failure releases unused refresh lease without losing credentials", async () => {
  let released = false;
  let requests = 0;
  const db = database((name, args) => {
    if (name === "app_token_claim") {
      return {
        action: "refresh",
        encryptedTokens: "unreadable-synthetic-record",
        version: 1,
        lease: "lease",
      };
    }
    equal(name, "app_token_fail");
    equal(args.p_reconnect, false);
    equal(args.p_retry_ms, 0);
    released = true;
    return true;
  });
  await rejects(
    () =>
      new OwnerTokens(db, box, 1, "client", () => {
        requests++;
        throw new Error("must not request");
      }).getAccessToken(),
    (error) =>
      error instanceof SpotifyError && error.kind === "control_unavailable",
  );
  assert(released);
  equal(requests, 0);
});
