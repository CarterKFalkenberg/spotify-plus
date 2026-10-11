export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
export const SESSION_COOKIE = "__Host-sp_session";
export const OAUTH_COOKIE = "__Host-sp_oauth";
export function cookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}
export function readCookie(request: Request, name: string): string | null {
  const values = (request.headers.get("Cookie") ?? "").split(";").map((c) => c.trim()).filter((c) =>
    c.startsWith(`${name}=`)
  );
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export async function readJson(
  request: Request,
  maxBytes = 16384,
): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    throw new Error("invalid_input");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_input");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new Error("invalid_input");
  }
}
export function pathFor(request: Request, functionName: "api" | "jobs"): string {
  const path = new URL(request.url).pathname;
  // Hosted requests include the gateway prefix; direct synthetic requests use product paths.
  const prefix = `/functions/v1/${functionName}`;
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path === prefix ? "/" : path;
}
