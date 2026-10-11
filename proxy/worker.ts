/** The worker knows no Spotify tokens or database credentials. */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  APP_ORIGIN: string;
  SUPABASE_ORIGIN: string;
  FRONTEND_SHA: string;
  PROXY_SECRET: string;
}
const routes: Readonly<Record<string, string>> = {
  "/healthz": "GET",
  "/api/session": "GET",
  "/api/disconnect": "POST",
  "/auth/spotify/start": "GET",
  "/auth/spotify/callback": "GET",
};
const forwardedHeaders = ["accept", "content-type", "cookie", "origin"];
const sha = /^[a-f0-9]{40}$/;
function privateHeaders(source?: Headers): Headers {
  const headers = new Headers(source);
  headers.set("cache-control", "private, no-store");
  headers.set("cdn-cache-control", "no-store");
  headers.set("cloudflare-cdn-cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.delete("etag");
  headers.delete("last-modified");
  headers.delete("age");
  headers.delete("access-control-allow-origin");
  headers.delete("access-control-allow-credentials");
  return headers;
}
function error(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: privateHeaders() });
}
function isTime(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}
export async function handleRequest(
  request: Request,
  env: Env,
  upstream = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const method = Object.hasOwn(routes, url.pathname)
    ? routes[url.pathname]
    : undefined;
  if (!method) {
    // Only the three public document routes and compiled assets reach the asset binding.
    if (request.method === "GET" || request.method === "HEAD") {
      if (
        ["/", "/privacy", "/terms"].includes(url.pathname) ||
        /^\/assets\/[A-Za-z0-9._-]+$/.test(url.pathname)
      ) {
        return env.ASSETS.fetch(request);
      }
    }
    return error(404, "not_found");
  }
  if (request.method !== method) return error(405, "method_not_allowed");
  if (
    url.origin !== env.APP_ORIGIN ||
    !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_ORIGIN) ||
    !sha.test(env.FRONTEND_SHA) ||
    typeof env.PROXY_SECRET !== "string" ||
    env.PROXY_SECRET.length < 32
  )
    return error(503, "temporarily_unavailable");
  const headers = new Headers();
  // A fresh allowlist also removes Authorization, apikey, x-forwarded-*, x-*-secret,
  // CF identity headers, and client cache overrides. Origin is preserved for API CSRF checks.
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("x-proxy-secret", env.PROXY_SECRET);
  const target = new URL(
    `/functions/v1/api${url.pathname}`,
    env.SUPABASE_ORIGIN,
  );
  // Only OAuth callback has query input; no arbitrary upstream/path selection exists.
  if (url.pathname === "/auth/spotify/callback") target.search = url.search;
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    };
    if (method === "POST") {
      init.body = request.body;
      init.duplex = "half";
    }
    const response = await upstream(target, init);
    if (url.pathname !== "/healthz") {
      // Never buffer private payloads. Preserve HttpOnly Set-Cookie and OAuth redirects.
      return new Response(response.body, {
        status: response.status,
        headers: privateHeaders(response.headers),
      });
    }
    if (!response.ok) return error(503, "temporarily_unavailable");
    const health = (await response.json()) as Record<string, unknown>;
    if (
      typeof health.apiSha !== "string" ||
      !sha.test(health.apiSha) ||
      !(
        health.jobsSha === null ||
        (typeof health.jobsSha === "string" && sha.test(health.jobsSha))
      ) ||
      !isTime(health.lastSchedulerAt) ||
      !isTime(health.lastJobAt)
    )
      return error(503, "temporarily_unavailable");
    return Response.json(
      {
        frontendSha: env.FRONTEND_SHA,
        apiSha: health.apiSha,
        jobsSha: health.jobsSha,
        lastSchedulerAt: health.lastSchedulerAt,
        lastJobAt: health.lastJobAt,
      },
      { headers: privateHeaders() },
    );
  } catch {
    // Never relay vendor errors, request URLs, credentials or response bodies into logs.
    return error(503, "temporarily_unavailable");
  }
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
