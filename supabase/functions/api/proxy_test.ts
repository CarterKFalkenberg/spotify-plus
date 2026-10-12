import { type Env, handleRequest } from "../../../proxy/worker.ts";
import { createApi } from "./handler.ts";
import { SecretBox, sha256 } from "../_shared/crypto.ts";
import { SESSION_COOKIE } from "../_shared/http.ts";
import { database, equal, TEST_KEY } from "../_shared/testing.ts";

const origin = "https://synthetic.test";
const session = "s".repeat(43);
const tag = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const revision = { library: "1", annotations: "2" };
const routes: [string, Record<string, unknown>, string][] = [
  ["/api/library/facets", {
    filter: {
      membership: "active",
      search: "",
      untagged: false,
      newOnly: false,
      artistId: null,
    },
    facet: "artist",
    cursor: null,
    limit: 20,
  }, "app_library_facets"],
  ["/api/tags/vocabulary", {
    search: "",
    sort: "mostUsed",
    cursor: null,
    limit: 9,
  }, "app_tags_vocabulary"],
  ["/api/tags/selection", {
    selection: { kind: "tracks", trackKeys: ["1".repeat(64)] },
    tagIds: [tag],
    expectedRevision: revision,
  }, "app_tags_selection"],
  ["/api/tags/manage-preview", {
    action: "rename",
    tagId: tag,
    name: "  Synthetic   tag  ",
    expectedRevision: revision,
  }, "app_tags_manage_preview"],
  ["/api/tags/manage", {
    action: "delete",
    tagId: tag,
    expectedRevision: revision,
    confirmedAssignmentCount: 0,
  }, "app_tags_manage"],
];
const env: Env = {
  ASSETS: {
    fetch: () => {
      throw new Error("must not serve assets");
    },
  },
  APP_ORIGIN: origin,
  SUPABASE_ORIGIN: "https://abcdefghijklmnopqrst.supabase.co",
  FRONTEND_SHA: "a".repeat(40),
  PROXY_SECRET: "p".repeat(40),
};
const config = {
  origin,
  sha: env.FRONTEND_SHA,
  clientId: "synthetic",
  expectedUserId: "synthetic",
  proxySecret: env.PROXY_SECRET,
  bootstrapSecret: "b".repeat(40),
  ownerBindingKey: TEST_KEY,
};
function request(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${session}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
Deno.test("fast-tagging POSTs traverse the real proxy and authenticated API to exact domain RPCs", async () => {
  const sessionHash = await sha256(session);
  for (const [path, body, rpc] of routes) {
    let domainCalls = 0, forwarded = 0;
    const api = createApi({
      config,
      box: new SecretBox(TEST_KEY),
      fetch: () => {
        throw new Error("Spotify transport must not run");
      },
      db: database((name, args) => {
        if (name === "app_session") {
          equal(args.p_token_hash, sessionHash);
          return { epoch: 7, state: "connected" };
        }
        equal(name, rpc);
        equal(args.p_epoch, 7);
        equal(
          args.p_request,
          path === "/api/tags/manage-preview"
            ? { ...body, name: "Synthetic tag" }
            : body,
        );
        equal(
          args.p_session_hash,
          path === "/api/tags/manage" ? sessionHash : undefined,
        );
        domainCalls++;
        return { synthetic: true, revision };
      }),
    });
    const response = await handleRequest(
      request(path, body, {
        "x-proxy-secret": "untrusted-client-secret",
        authorization: "Bearer untrusted",
        apikey: "untrusted",
      }),
      env,
      async (input, init) => {
        forwarded++;
        equal(String(input), env.SUPABASE_ORIGIN + "/functions/v1/api" + path);
        const forwardedRequest = new Request(input, init);
        equal(forwardedRequest.headers.get("x-proxy-secret"), env.PROXY_SECRET);
        equal(forwardedRequest.headers.get("authorization"), null);
        equal(forwardedRequest.headers.get("apikey"), null);
        return await api(forwardedRequest);
      },
    );
    equal(response.status, 200);
    equal(await response.json(), { synthetic: true, revision });
    equal(response.headers.get("cache-control"), "private, no-store");
    equal({ forwarded, domainCalls }, { forwarded: 1, domainCalls: 1 });
  }
});
Deno.test("fast-tagging proxy routes retain method, neighbor, query, origin and body restrictions", async () => {
  for (const [path, body] of routes) {
    const cases: [Request, number][] = [
      [new Request(origin + path), 405],
      [new Request(origin + path, { method: "PUT" }), 405],
      [request(path + "/extra", body), 404],
      [request(path + "-extra", body), 404],
      [request(path + "?extra=1", body), 400],
      [request(path, body, { origin: "https://other.test" }), 403],
      [request(path, body, { "content-type": "text/plain" }), 415],
      [request(path, "x".repeat(16385)), 413],
    ];
    for (const [req, status] of cases) {
      const response = await handleRequest(req, env, () => {
        throw new Error("denied request must not reach upstream");
      });
      equal(response.status, status);
      equal(response.headers.get("cache-control"), "private, no-store");
    }
  }
});
Deno.test("fast-tagging proxy-to-API requests cannot bypass owner session or server proxy secret", async () => {
  for (const [path, body] of routes) {
    for (
      const mode of ["missing-cookie", "wrong-cookie", "wrong-proxy-secret"]
    ) {
      let domainCalls = 0;
      const api = createApi({
        config,
        box: new SecretBox(TEST_KEY),
        db: database((name) => {
          if (name === "app_session") return null;
          domainCalls++;
          return null;
        }),
      });
      const req = request(path, body);
      if (mode === "missing-cookie") req.headers.delete("cookie");
      if (mode === "wrong-cookie") {
        req.headers.set("cookie", `${SESSION_COOKIE}=${"z".repeat(43)}`);
      }
      const response = await handleRequest(
        req,
        mode === "wrong-proxy-secret"
          ? { ...env, PROXY_SECRET: "wrong-server-secret".repeat(3) }
          : env,
        (input, init) => api(new Request(input, init)),
      );
      equal(response.status, 401);
      equal(await response.json(), { error: "unauthorized" });
      equal(domainCalls, 0);
      equal(response.headers.get("cache-control"), "private, no-store");
    }
  }
});
