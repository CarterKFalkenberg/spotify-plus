import { createApi } from "./handler.ts";
import { SecretBox } from "../_shared/crypto.ts";
import { DatabaseError } from "../_shared/database.ts";
import { assert, database, equal, TEST_KEY } from "../_shared/testing.ts";
const origin = "https://synthetic.test";
const config = {
  origin,
  sha: "a".repeat(40),
  clientId: "synthetic",
  expectedUserId: "synthetic",
  proxySecret: "p".repeat(40),
  bootstrapSecret: "b".repeat(40),
  ownerBindingKey: TEST_KEY,
};
const tag = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const filter = {
  membership: "active",
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
const routes: [string, string, unknown, string][] = [
  ["/api/library/status", "GET", null, "app_library_status"],
  ["/api/library/sync", "POST", { reason: "manual" }, "app_library_sync"],
  ["/api/library/search", "POST", {
    filter,
    groupBy: null,
    cursor: null,
    limit: 20,
  }, "app_library_search"],
  [
    "/api/library/acknowledge",
    "POST",
    { trackKeys: ["a".repeat(64)] },
    "app_library_acknowledge",
  ],
  ["/api/tags?search=chill&limit=20", "GET", null, "app_tags_search"],
  ["/api/tags", "POST", { name: "  Chill  " }, "app_tag_create"],
  ["/api/tag-actions", "POST", {
    tagId: tag,
    action: "add",
    selection: { kind: "tracks", trackKeys: ["a".repeat(64)] },
  }, "app_tag_action"],
  [`/api/tag-actions/${tag}/undo`, "POST", {}, "app_tag_undo"],
  ["/api/query/preview", "POST", {
    query: { version: 1, root: { op: "tag", tagId: tag } },
    cursor: null,
    limit: 20,
  }, "app_query_preview"],
];
function request(path: string, method: string, body: unknown, mode = "valid") {
  return new Request(`${origin}/functions/v1/api${path}`, {
    method,
    headers: {
      "x-proxy-secret": config.proxySecret,
      ...(mode === "no-session"
        ? {}
        : { Cookie: `__Host-sp_session=${"s".repeat(43)}` }),
      Origin: mode === "bad-origin" ? "https://other.test" : origin,
      "Content-Type": "application/json",
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}
Deno.test("all library/tag/query routes use authenticated epoch and normalized contract without Spotify calls", async () => {
  for (const [path, method, body, rpc] of routes) {
    let calls = 0;
    const handler = createApi({
      config,
      box: new SecretBox(TEST_KEY),
      fetch: () => {
        throw new Error("no Spotify requests allowed");
      },
      db: database((name, args) => {
        if (name === "app_session") return { epoch: 7, state: "connected" };
        equal(name, rpc);
        equal(args.p_epoch, 7);
        calls++;
        if (name === "app_tag_create") equal(args.p_name, "Chill");
        if (name === "app_tag_action" || name === "app_tag_undo") {
          assert(/^[0-9a-f]{64}$/.test(String(args.p_session_hash)));
        }
        return { synthetic: true };
      }),
    });
    const response = await handler(request(path, method, body));
    equal(response.status, 200);
    equal(await response.json(), { synthetic: true });
    equal(calls, 1);
  }
});
Deno.test("library routes enforce session and mutation origin before domain RPC", async () => {
  for (const [path, method, body] of routes) {
    for (
      const mode of ["no-session", ...(method === "POST" ? ["bad-origin"] : [])]
    ) {
      let domainCalls = 0;
      const handler = createApi({
        config,
        box: new SecretBox(TEST_KEY),
        db: database((name) => {
          if (name === "app_session") return { epoch: 1, state: "connected" };
          domainCalls++;
          return null;
        }),
      });
      const response = await handler(request(path, method, body, mode));
      equal(response.status, mode === "no-session" ? 401 : 403);
      equal(domainCalls, 0);
    }
  }
});
Deno.test("GET parameter and mutation contract errors fail closed without echoed input", async () => {
  const handler = createApi({
    config,
    box: new SecretBox(TEST_KEY),
    db: database((name) => {
      equal(name, "app_session");
      return { epoch: 1, state: "connected" };
    }),
  });
  for (
    const path of [
      "/api/library/status?x=private",
      "/api/tags?search=x&search=y",
      "/api/tags?limit=1e2",
      "/api/tags?limit=0",
      "/api/tags?extra=private",
    ]
  ) {
    const response = await handler(request(path, "GET", null));
    equal(response.status, 400);
    equal(await response.json(), { error: "invalid_input" });
  }
  const response = await handler(
    request("/api/tag-actions", "POST", { secret: "private" }),
  );
  equal(response.status, 400);
  equal(await response.json(), { error: "invalid_input" });
});
Deno.test("fixed database stale/deleted-selection conflicts map explicitly without raw diagnostics", async () => {
  for (
    const kind of [
      "stale_revision",
      "unknown_tag",
      "unknown_track",
      "unknown_action",
      "inactive_epoch",
    ] as const
  ) {
    const handler = createApi({
      config,
      box: new SecretBox(TEST_KEY),
      db: database((name) => {
        if (name === "app_session") return { epoch: 1, state: "connected" };
        throw new DatabaseError(kind);
      }),
    });
    const response = await handler(request("/api/library/status", "GET", null));
    equal(response.status, 409);
    equal(await response.json(), { error: kind });
  }
});
