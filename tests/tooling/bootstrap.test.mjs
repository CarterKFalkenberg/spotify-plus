import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { importBootstrap } from "../../scripts/import-bootstrap.mjs";
const dirs = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "tagger-bootstrap-synthetic-"));
  dirs.push(root);
  const local = resolve(root, ".local");
  mkdirSync(local);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  git("config", "user.name", "Synthetic Test");
  git("config", "user.email", "synthetic@example.test");
  writeFileSync(resolve(root, ".gitignore"), ".local/\n");
  git("add", ".gitignore");
  git("commit", "-m", "Synthetic fixture");
  const config = {
    appUrl: "https://spotify-plus.synthetic.workers.dev",
    supabaseProjectRef: "abcdefghijklmnopqrst",
    cloudflareAccountId: "a".repeat(32),
    cloudflareWorkerName: "spotify-plus",
    spotifyClientId: "synthetic-client",
    spotifyExpectedUserId: "synthetic-owner",
    budgetMonthlyUsd: 0,
    hosting: { supabasePlan: "free", cloudflarePlan: "free" },
    authorization: { deployToConfiguredFreeHosting: true },
  };
  writeFileSync(resolve(local, "config.json"), JSON.stringify(config));
  writeFileSync(
    resolve(local, "runtime-keys.json"),
    JSON.stringify({
      proxySecret: "synthetic-proxy",
      bootstrapSecret: "synthetic-bootstrap",
    }),
  );
  const grant = {
    clientId: config.spotifyClientId,
    userId: config.spotifyExpectedUserId,
    accountId: "synthetic-account",
    authorizedAt: "2026-01-01T12:00:00Z",
    accessToken: "expired-synthetic-access",
    refreshToken: "original-synthetic-refresh",
    accessExpiresAt: "2026-01-01T13:00:00Z",
    scopes: ["synthetic"],
  };
  const path = resolve(local, "spotify-bootstrap.json");
  writeFileSync(path, JSON.stringify(grant));
  return { root, local, path, grant };
}
it("persists refresh rotation and original authorization date before importing, then removes only after commit", async () => {
  const { root, local, path, grant } = fixture();
  let committed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("accounts.spotify.com")) {
        const marked = JSON.parse(readFileSync(path, "utf8"));
        expect(Number.isFinite(Date.parse(marked.refreshAttemptedAt))).toBe(
          true,
        );
        expect(marked.authorizedAt).toBe(grant.authorizedAt);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        return Response.json({
          access_token: "fresh-synthetic-access",
          refresh_token: "rotated-synthetic-refresh",
          expires_in: 3600,
        });
      }
      if (init.method === "POST") {
        expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty(
          "refreshAttemptedAt",
        );
        expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
          refreshToken: "rotated-synthetic-refresh",
          authorizedAt: grant.authorizedAt,
        });
        expect(JSON.parse(init.body)).toMatchObject({
          accessToken: "fresh-synthetic-access",
          refreshToken: "rotated-synthetic-refresh",
          authorizedAt: grant.authorizedAt,
        });
        committed = true;
        return Response.json(
          { consumed: true },
          {
            headers: {
              "set-cookie": `__Host-sp_session=${"a".repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
            },
          },
        );
      }
      expect(existsSync(path)).toBe(true);
      return Response.json({ consumed: committed });
    }),
  );
  expect(await importBootstrap(root)).toEqual({
    consumed: true,
    previouslyCommitted: false,
    sessionIssued: true,
  });
  expect(existsSync(path)).toBe(false);
  const savedSession = JSON.parse(
    readFileSync(resolve(local, "owner-session.json"), "utf8"),
  );
  expect(savedSession).toMatchObject({
    cookie: `__Host-sp_session=${"a".repeat(43)}`,
    source: "verified-bootstrap-oauth",
  });
  expect(statSync(resolve(local, "owner-session.json")).mode & 0o777).toBe(
    0o600,
  );
  expect(
    JSON.parse(
      readFileSync(resolve(local, "spotify-bootstrap-consumed.json"), "utf8"),
    ).consumed,
  ).toBe(true);
});
it("an unconfirmed import preserves rotated credentials for recovery", async () => {
  const { root, path } = fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).includes("accounts.spotify.com")
        ? Response.json({
            access_token: "fresh-synthetic-access",
            refresh_token: "rotated-synthetic-refresh",
            expires_in: 3600,
          })
        : init.method === "POST"
          ? new Response("opaque provider failure", { status: 503 })
          : Response.json({ consumed: false }),
    ),
  );
  await expect(importBootstrap(root)).rejects.toThrow(
    "bootstrap_import_unconfirmed",
  );
  expect(JSON.parse(readFileSync(path, "utf8")).refreshToken).toBe(
    "rotated-synthetic-refresh",
  );
});
it("already committed bootstrap reconciles a lost response without token refresh or second POST", async () => {
  const { root, path } = fixture();
  const fetch = vi.fn(async () => Response.json({ consumed: true }));
  vi.stubGlobal("fetch", fetch);
  expect(await importBootstrap(root)).toEqual({
    consumed: true,
    previouslyCommitted: true,
    sessionIssued: false,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(existsSync(path)).toBe(false);
});

it("a success body without a secure session cookie cannot create a local owner session", async () => {
  const { root, local, path } = fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).includes("accounts.spotify.com")
        ? Response.json({
            access_token: "fresh-synthetic-access",
            expires_in: 3600,
          })
        : Response.json({ consumed: init.method === "POST" }),
    ),
  );
  await expect(importBootstrap(root)).rejects.toThrow(
    "bootstrap_session_cookie_unconfirmed",
  );
  expect(existsSync(resolve(local, "owner-session.json"))).toBe(false);
  expect(existsSync(path)).toBe(true);
});

for (const outcome of [
  "lost response",
  "malformed JSON",
  "incomplete grant",
  "null grant",
  "date overflow",
  "expiry beyond one day",
  "fractional expiry",
]) {
  it(`an ambiguous refresh (${outcome}) durably prevents a second refresh or import`, async () => {
    const { root, local, path, grant } = fixture();
    let refreshes = 0,
      imports = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("accounts.spotify.com")) {
          refreshes++;
          expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty(
            "refreshAttemptedAt",
          );
          if (outcome === "lost response")
            throw new TypeError("synthetic lost response");
          if (outcome === "malformed JSON") return new Response("{");
          if (outcome === "null grant") return Response.json(null);
          if (
            [
              "date overflow",
              "expiry beyond one day",
              "fractional expiry",
            ].includes(outcome)
          )
            return Response.json({
              access_token: "possibly-rotated",
              refresh_token: "new-refresh",
              expires_in:
                outcome === "date overflow"
                  ? 1e308
                  : outcome === "expiry beyond one day"
                    ? 86401
                    : 3600.5,
            });
          return Response.json({
            access_token: "possibly-rotated",
            expires_in: 3600,
            refresh_token: "",
          });
        }
        if (init.method === "POST") imports++;
        return Response.json({ consumed: false });
      }),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(importBootstrap(root)).rejects.toThrow(
        "bootstrap_refresh_ambiguous_reconnect_required",
      );
    }
    expect(refreshes).toBe(1);
    expect(imports).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      ...grant,
      refreshAttemptedAt: expect.any(String),
    });
    expect(existsSync(resolve(local, "owner-session.json"))).toBe(false);
    expect(existsSync(resolve(local, "spotify-bootstrap-consumed.json"))).toBe(
      false,
    );
  });
}
for (const accessExpiresAt of [
  "2020-01-01T00:00:00Z",
  "2099-01-01T00:00:00Z",
]) {
  it(`a surviving crash marker blocks refresh and import regardless of access expiry (${accessExpiresAt})`, async () => {
    const { root, path, grant } = fixture();
    writeFileSync(
      path,
      JSON.stringify({
        ...grant,
        accessExpiresAt,
        refreshAttemptedAt: "2026-10-11T00:00:00Z",
      }),
    );
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).not.toContain("accounts.spotify.com");
      expect(init.method).not.toBe("POST");
      return Response.json({ consumed: false });
    });
    vi.stubGlobal("fetch", fetch);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(importBootstrap(root)).rejects.toThrow(
        "bootstrap_refresh_ambiguous_reconnect_required",
      );
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty(
      "refreshAttemptedAt",
    );
  });
}
it("a fresh setup grant replaces the uncertain file and restores normal import", async () => {
  const { root, path, grant } = fixture();
  writeFileSync(
    path,
    JSON.stringify({ ...grant, refreshAttemptedAt: "2026-10-11T00:00:00Z" }),
  );
  let consumed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      expect(String(url)).not.toContain("accounts.spotify.com");
      if (init.method === "POST") {
        const imported = JSON.parse(init.body);
        expect(imported.authorizedAt).toBe("2026-10-11T12:00:00Z");
        expect(imported.refreshToken).toBe("new-consent-refresh");
        expect(imported).not.toHaveProperty("refreshAttemptedAt");
        consumed = true;
        return Response.json(
          { consumed },
          {
            headers: {
              "set-cookie": `__Host-sp_session=${"b".repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
            },
          },
        );
      }
      return Response.json({ consumed });
    }),
  );
  await expect(importBootstrap(root)).rejects.toThrow(
    "bootstrap_refresh_ambiguous_reconnect_required",
  );
  // connect-spotify writes a complete new helper grant instead of spreading old fields.
  writeFileSync(
    path,
    JSON.stringify({
      ...grant,
      authorizedAt: "2026-10-11T12:00:00Z",
      accessToken: "new-consent-access",
      refreshToken: "new-consent-refresh",
      accessExpiresAt: "2099-01-01T00:00:00Z",
    }),
  );
  expect(await importBootstrap(root)).toEqual({
    consumed: true,
    previouslyCommitted: false,
    sessionIssued: true,
  });
  expect(existsSync(path)).toBe(false);
});
it("a definitive invalid_grant refusal clears only the attempt marker and never imports", async () => {
  const { root, path, grant } = fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("accounts.spotify.com"))
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      expect(init.method).not.toBe("POST");
      return Response.json({ consumed: false });
    }),
  );
  await expect(importBootstrap(root)).rejects.toThrow(
    "bootstrap_refresh_rejected_reconnect_required",
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(grant);
});
