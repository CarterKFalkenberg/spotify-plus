import { requireCheck } from "./config.mjs";

const name = "__Host-sp_oauth";
const failure = "secure_oauth_cookie_required";

// Validate our opaque, ten-minute OAuth browser binding, independently of cookies
// added by the hosting provider. Return only the application Cookie request pair.
export function oauthCallbackCookie(setCookieHeaders) {
  requireCheck(
    Array.isArray(setCookieHeaders) &&
      setCookieHeaders.every((header) => typeof header === "string"),
    failure,
  );
  const candidates = setCookieHeaders.filter((header) => {
    const pair = header.split(";", 1)[0].trim();
    const equals = pair.indexOf("=");
    return (equals < 0 ? pair : pair.slice(0, equals).trim()) === name;
  });
  requireCheck(candidates.length === 1, failure);
  const header = candidates[0];
  requireCheck(!/[\r\n\x00-\x1f\x7f]/.test(header), failure);
  const [pair, ...parts] = header.split(";");
  requireCheck(/^__Host-sp_oauth=[A-Za-z0-9_-]{43}$/.test(pair), failure);
  const attributes = new Map();
  for (const part of parts) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)(?:=([^;]*))?$/.exec(part.trim());
    requireCheck(match !== null, failure);
    const key = match[1].toLowerCase();
    requireCheck(!attributes.has(key), failure);
    // A combined Set-Cookie list is not a single application cookie. A comma is
    // legitimate only in the optional Expires date; Max-Age controls its lifetime.
    requireCheck(
      key === "expires"
        ? Number.isFinite(Date.parse(match[2]))
        : !match[2]?.includes(","),
      failure,
    );
    attributes.set(key, match[2] ?? null);
  }
  const maxAge = attributes.get("max-age");
  requireCheck(
    attributes.get("secure") === null &&
      attributes.get("httponly") === null &&
      attributes.get("samesite")?.toLowerCase() === "lax" &&
      attributes.get("path") === "/" &&
      !attributes.has("domain") &&
      typeof maxAge === "string" &&
      /^[1-9][0-9]{0,2}$/.test(maxAge) &&
      Number(maxAge) <= 600,
    failure,
  );
  return pair;
}
