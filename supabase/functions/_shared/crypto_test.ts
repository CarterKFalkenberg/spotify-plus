import {
  opaqueToken,
  ownerFingerprint,
  pkceChallenge,
  SecretBox,
  secretMatches,
  sha256,
} from "./crypto.ts";
import { assert, equal, rejects, TEST_KEY } from "./testing.ts";
Deno.test("opaque sessions have 256 bits and PKCE S256 uses RFC7636 vector", async () => {
  assert(/^[A-Za-z0-9_-]{43}$/.test(opaqueToken()));
  equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  equal((await sha256("session")).length, 64);
});
Deno.test("AES-GCM randomizes ciphertext and authenticates purpose and epoch", async () => {
  const box = new SecretBox(TEST_KEY),
    pair = {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
    };
  const a = await box.encrypt(pair, "tokens:1"),
    b = await box.encrypt(pair, "tokens:1");
  assert(a !== b);
  assert(!a.includes("synthetic"));
  equal(await box.decrypt(a, "tokens:1"), pair);
  await rejects(() => box.decrypt(a, "tokens:2"));
  await rejects(() => box.decrypt(a, "oauth:1"));
  await rejects(() => box.decrypt(a.slice(0, -4) + "AAAA", "tokens:1"));
});
Deno.test("owner binding is stable, keyed, and distinct from raw identity", async () => {
  const a = await ownerFingerprint("synthetic-account", TEST_KEY);
  equal(a, await ownerFingerprint("synthetic-account", TEST_KEY));
  assert(a !== await ownerFingerprint("other-account", TEST_KEY));
  assert(
    a !== await ownerFingerprint("synthetic-account", btoa("q".repeat(32))),
  );
  assert(!a.includes("synthetic"));
});
Deno.test("service authentication denies missing or different secrets", async () => {
  assert(await secretMatches("s".repeat(32), "s".repeat(32)));
  assert(!await secretMatches(null, "s".repeat(32)));
  assert(!await secretMatches("s".repeat(32), "q".repeat(32)));
  assert(!await secretMatches("short", "short"));
});
