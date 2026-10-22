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
  "/api/playback/enable": "POST",
  "/api/playback/token": "POST",
  "/api/playback/start": "POST",
  "/api/sources": "GET",
  "/api/sources/selection": "POST",
  "/api/sources/sync": "POST",
  "/api/sources/enable": "POST",
  "/api/library/status": "GET",
  "/api/library/sync": "POST",
  "/api/library/search": "POST",
  "/api/library/facets": "POST",
  "/api/library/acknowledge": "POST",
  "/api/tags": "GET POST",
  "/api/tags/lookup": "POST",
  "/api/tags/vocabulary": "POST",
  "/api/tags/selection": "POST",
  "/api/tags/manage-preview": "POST",
  "/api/tags/manage": "POST",
  "/api/tag-actions": "POST",
  "/api/query/preview": "POST",
  "/api/playlists": "GET POST",
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
  const allowedMethods = Object.hasOwn(routes, url.pathname)
    ? routes[url.pathname]
    : /^\/api\/(?:tag-actions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/undo|playlists\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/actions)$/.test(
          url.pathname,
        )
      ? "POST"
      : undefined;
  if (!allowedMethods) {
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
  const method = request.method;
  if (!allowedMethods.split(" ").includes(method))
    return error(405, "method_not_allowed");
  if (url.pathname !== "/auth/spotify/callback") {
    const allowed =
      method === "GET" && url.pathname === "/api/sources"
        ? ["search", "offset", "limit"]
        : method === "GET" && url.pathname === "/api/tags"
          ? ["search", "limit"]
          : method === "GET" && url.pathname === "/api/playlists"
            ? ["cursor", "limit"]
            : [];
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
        return error(400, "invalid_input");
    }
    const limit = url.searchParams.get("limit");
    const search = url.searchParams.get("search");
    const cursor = url.searchParams.get("cursor");
    const offset = url.searchParams.get("offset");
    if (
      (limit !== null &&
        (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100)) ||
      (search !== null &&
        (search.length > 1600 ||
          [...search.normalize("NFC").trim().replace(/\s+/gu, " ")].length >
            200)) ||
      (cursor !== null && !/^[A-Za-z0-9_-]{16,512}$/.test(cursor)) ||
      (offset !== null && !/^\d{1,9}$/.test(offset))
    )
      return error(400, "invalid_input");
  }
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
  // Query input is bounded above; the upstream and path are always fixed.
  target.search = url.search;
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    };
    if (method === "POST") {
      if (request.headers.get("origin") !== env.APP_ORIGIN)
        return error(403, "invalid_origin");
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      )
        return error(415, "invalid_content_type");
      const maxBodyBytes =
        url.pathname === "/api/sources/selection" ? 262144 : 16384;
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maxBodyBytes) {
            await reader.cancel();
            return error(413, "body_too_large");
          }
          chunks.push(part.value);
        }
      }
      const body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      init.body = body;
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
