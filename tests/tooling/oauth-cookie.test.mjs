import { describe, expect, it } from "vitest";
import { oauthCallbackCookie } from "../../scripts/live/oauth-cookie.mjs";

const pair = `__Host-sp_oauth=${"a".repeat(43)}`;
const cookie = `${pair}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
const provider =
  "provider=synthetic; Domain=.example.test; Path=/; HttpOnly; Secure";
const secureForeign =
  "foreign=synthetic; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600";
const rejects = (headers) => {
  try {
    oauthCallbackCookie(headers);
  } catch (error) {
    expect(error.code).toBe("secure_oauth_cookie_required");
    expect(error.message).not.toContain("synthetic");
    return;
  }
  throw new Error("expected invalid application cookie to fail");
};

describe("OAuth callback application cookie boundary", () => {
  it("returns only the exact application pair when an unrelated provider cookie has different policy", () => {
    for (const headers of [
      [provider, cookie],
      [cookie, provider],
    ]) {
      const response = new Headers();
      for (const header of headers) response.append("set-cookie", header);
      const request = new Request(
        "https://synthetic.example/auth/spotify/callback",
        {
          headers: { cookie: oauthCallbackCookie(response.getSetCookie()) },
        },
      );
      expect(request.headers.get("cookie")).toBe(pair);
      expect(request.headers.get("cookie")).not.toContain("provider");
    }
  });
  it("accepts case-insensitive attributes and a shorter positive binding lifetime", () => {
    expect(
      oauthCallbackCookie([
        `${pair}; secure; HTTPONLY; samesite=lAx; pAth=/; MAX-AGE=300`,
      ]),
    ).toBe(pair);
  });
  it.each([
    [],
    [secureForeign],
    [cookie.replace("__Host-sp_oauth", "__host-sp_oauth")],
    [cookie.replace("__Host-sp_oauth", "__Host-sp_oauth_extra")],
    [cookie, cookie],
    [cookie, "__Host-sp_oauth; HttpOnly; Secure"],
  ])(
    "rejects missing or duplicate exact-name application bindings %#",
    (...headers) => {
      rejects(headers);
    },
  );
  it.each([
    cookie.replace("; HttpOnly", ""),
    cookie.replace("; Secure", ""),
    cookie.replace("; Secure", "; Secure=false"),
    cookie.replace("; HttpOnly", "; HttpOnly=true"),
    cookie.replace("SameSite=Lax", "SameSite=None"),
    cookie.replace("SameSite=Lax", "SameSite=Laxer"),
    cookie.replace("; SameSite=Lax", ""),
    cookie.replace("; Path=/", ""),
    cookie.replace("Path=/", "Path=/auth"),
    cookie + "; Domain=.example.test",
    cookie + "; Domain=",
    cookie.replace("; Max-Age=600", ""),
    cookie.replace("Max-Age=600", "Max-Age=0"),
    cookie.replace("Max-Age=600", "Max-Age=-1"),
    cookie.replace("Max-Age=600", "Max-Age=601"),
    cookie.replace("Max-Age=600", "Max-Age=1e2"),
    cookie.replace("Max-Age=600", "Max-Age=Infinity"),
    cookie + "; secure",
    cookie + "; Path=/other",
    cookie + "; SameSite=None",
    cookie + "; Max-Age=2592000",
    cookie.replace(pair, "__Host-sp_oauth="),
    cookie.replace(pair, `__Host-sp_oauth=${"a".repeat(42)}`),
    cookie.replace(pair, `__Host-sp_oauth="${"a".repeat(43)}"`),
    cookie.replace(pair, `__Host-sp_oauth =${"a".repeat(43)}`),
    cookie.replace(pair, `__Host-sp_oauth= ${"a".repeat(43)}`),
    cookie.replace(pair, pair + " "),
    " " + cookie,
    cookie + "\r\nprovider=synthetic",
    cookie + ", " + secureForeign,
    cookie + "; Expires=invalid",
    cookie + "; malformed attribute",
  ])(
    "rejects malformed or insecure application cookie even with a secure foreign cookie %#",
    (invalid) => {
      rejects([secureForeign, invalid]);
    },
  );
});
