import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { handleRequest, type Env } from "../../proxy/worker";
const apiSha = "b".repeat(40),
  jobsSha = "c".repeat(40);
const env: Env = {
  ASSETS: { fetch: vi.fn(async () => new Response("static asset")) },
  APP_ORIGIN: "https://tagger.example.test",
  SUPABASE_ORIGIN: "https://abcdefghijklmnopqrst.supabase.co",
  FRONTEND_SHA: "a".repeat(40),
  PROXY_SECRET: "synthetic-secret-".repeat(3),
};
const request = (path: string, init?: RequestInit) =>
  new Request(env.APP_ORIGIN + path, init);
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("fixed same-origin proxy", () => {
  it("handles the platform ExecutionContext without treating it as fetch", async () => {
    const remote = vi.fn(async () =>
      Response.json({ authenticated: false, connection: "disconnected" }),
    );
    vi.stubGlobal("fetch", remote);
    const entrypoint = worker.fetch as (
      request: Request,
      env: Env,
      context: object,
    ) => Promise<Response>;
    const response = await entrypoint(request("/api/session"), env, {
      waitUntil: () => undefined,
    });
    expect(response.status).toBe(200);
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it.each([
    "/internal/bootstrap",
    "/functions/v1/jobs",
    "/api/anything",
    "/auth/spotify/other",
    "/api/session/extra",
    "/api/%2e%2e/internal/bootstrap",
    "//evil.test/api/session",
  ])("rejects unknown path %s without fetching", async (path) => {
    const remote = vi.fn();
    expect((await handleRequest(request(path), env, remote)).status).toBe(404);
    expect(remote).not.toHaveBeenCalled();
  });
  it("rejects non-allowlisted methods and cannot POST to a static fallback", async () => {
    const remote = vi.fn();
    expect(
      (
        await handleRequest(
          request("/api/session", { method: "POST" }),
          env,
          remote,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handleRequest(
          request("/privacy", { method: "POST" }),
          env,
          remote,
        )
      ).status,
    ).toBe(404);
    expect(remote).not.toHaveBeenCalled();
  });
  it("forwards only approved headers and streaming body to the configured origin", async () => {
    const remote = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        expect(String(_url)).toBe(
          env.SUPABASE_ORIGIN + "/functions/v1/api/api/disconnect",
        );
        const headers = new Headers(init?.headers);
        expect([...headers.keys()].sort()).toEqual([
          "content-type",
          "cookie",
          "origin",
          "x-proxy-secret",
        ]);
        expect(headers.get("x-proxy-secret")).toBe(env.PROXY_SECRET);
        expect(headers.get("cookie")).toBe("session=synthetic");
        expect(headers.get("origin")).toBe(env.APP_ORIGIN);
        expect(init?.redirect).toBe("manual");
        expect(await new Response(init?.body).text()).toBe(
          '{"confirmation":"DELETE ALL APP DATA"}',
        );
        return Response.json(
          { disconnected: true },
          {
            status: 202,
            headers: {
              "cache-control": "public",
              etag: "bad",
              "set-cookie": "session=; Secure; HttpOnly; Path=/; Max-Age=0",
            },
          },
        );
      },
    );
    const response = await handleRequest(
      request("/api/disconnect?upstream=https://evil.test", {
        method: "POST",
        headers: {
          cookie: "session=synthetic",
          origin: env.APP_ORIGIN,
          "content-type": "application/json",
          authorization: "Bearer attacker",
          apikey: "attacker",
          "x-forwarded-host": "evil.test",
          "x-proxy-secret": "attacker",
          "x-cron-secret": "attacker",
          "x-bootstrap-secret": "attacker",
        },
        body: '{"confirmation":"DELETE ALL APP DATA"}',
      }),
      env,
      remote,
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
  it("preserves callback query, cookies and redirect without following it", async () => {
    const remote = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(
        String(url).endsWith(
          "/auth/spotify/callback?code=synthetic&state=synthetic",
        ),
      ).toBe(true);
      expect(init?.redirect).toBe("manual");
      const headers = new Headers({ location: env.APP_ORIGIN + "/" });
      headers.append(
        "set-cookie",
        "session=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/",
      );
      headers.append(
        "set-cookie",
        "oauth=; Secure; HttpOnly; Path=/; Max-Age=0",
      );
      return new Response(null, { status: 302, headers });
    });
    const response = await handleRequest(
      request("/auth/spotify/callback?code=synthetic&state=synthetic"),
      env,
      remote,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(env.APP_ORIGIN + "/");
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });
  it("preserves separate OAuth and provider cookies without applying application policy to the provider", async () => {
    const cookies = [
      `__Host-sp_oauth=${"a".repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "provider=synthetic; Path=/; HttpOnly; Secure; Domain=.example.test",
    ];
    const headers = new Headers({
      location: "https://accounts.spotify.com/authorize?state=synthetic",
    });
    for (const value of cookies) headers.append("set-cookie", value);
    const response = await handleRequest(
      request("/auth/spotify/start"),
      env,
      async () => new Response(null, { status: 303, headers }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("reports actual jobs revision rather than assuming it matches the frontend", async () => {
    const remote = vi.fn(async () =>
      Response.json({
        apiSha,
        jobsSha,
        lastSchedulerAt: "2026-10-11T12:00:00Z",
        lastJobAt: null,
        secret: "must not be reflected",
      }),
    );
    const response = await handleRequest(request("/healthz"), env, remote);
    expect(await response.json()).toEqual({
      frontendSha: env.FRONTEND_SHA,
      apiSha,
      jobsSha,
      lastSchedulerAt: "2026-10-11T12:00:00Z",
      lastJobAt: null,
    });
  });
  it("retains unknown jobs revision before first execution", async () => {
    const response = await handleRequest(request("/healthz"), env, async () =>
      Response.json({
        apiSha,
        jobsSha: null,
        lastSchedulerAt: null,
        lastJobAt: null,
      }),
    );
    expect(
      ((await response.json()) as { jobsSha: unknown }).jobsSha,
    ).toBeNull();
  });
  it.each([
    { apiSha },
    { apiSha, jobsSha: "<untrusted>", lastSchedulerAt: null, lastJobAt: null },
  ])("fails closed on invalid health schema", async (health) => {
    expect(
      (
        await handleRequest(request("/healthz"), env, async () =>
          Response.json(health),
        )
      ).status,
    ).toBe(503);
  });
  it("never exposes vendor exceptions or follows a user-selected target", async () => {
    const response = await handleRequest(
      request("/api/session"),
      env,
      async () => {
        throw new Error("secret raw vendor response");
      },
    );
    expect(await response.text()).toBe('{"error":"temporarily_unavailable"}');
    const remote = vi.fn();
    expect(
      (
        await handleRequest(
          request("/api/session"),
          { ...env, SUPABASE_ORIGIN: "https://evil.test" },
          remote,
        )
      ).status,
    ).toBe(503);
    expect(remote).not.toHaveBeenCalled();
  });
});
