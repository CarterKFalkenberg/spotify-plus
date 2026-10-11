import { playlistApi } from "./playlist-api.ts";
import { assert, database, equal, rejects } from "./testing.ts";
import { ContractError } from "./contracts.ts";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
Deno.test("playlist routes normalize requests and return queued intent with explicit epoch", async () => {
  const input = {
    requestId: id,
    query: { version: 1, root: { op: "tag", tagId: id } },
    previewRevision: { library: "4", annotations: "8" },
    name: " Synthetic ",
    retention: "month",
  };
  const calls: unknown[] = [];
  const db = database((name, args) => {
    calls.push({ name, args });
    return { requestId: id, playlist: { status: "pending" } };
  });
  const request = new Request("https://app.test/api/playlists", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const response = await playlistApi(
    request,
    "/api/playlists",
    "session",
    3,
    db,
  );
  equal(response?.status, 202);
  equal(calls, [{
    name: "app_playlist_create",
    args: { p_epoch: 3, p_request: { ...input, name: "Synthetic" } },
  }]);
});
Deno.test("playlist GET rejects duplicate/unknown/loose integer parameters before database work", async () => {
  let calls = 0;
  const db = database(() => {
    calls++;
    return {};
  });
  for (
    const query of [
      "limit=1&limit=2",
      "bad=x",
      "limit=1e2",
      "limit=01",
      "limit=",
      "limit=101",
      "cursor=bad",
    ]
  ) {
    await rejects(
      () =>
        playlistApi(
          new Request(`https://app.test/api/playlists?${query}`),
          "/api/playlists",
          "session",
          1,
          db,
        ),
      (e) => e instanceof ContractError,
    );
  }
  equal(calls, 0);
  assert(
    await playlistApi(
      new Request("https://app.test/api/playlists"),
      "/api/playlists",
      "session",
      1,
      db,
    ),
  );
  equal(calls, 1);
});
Deno.test("lifecycle route validates managed UUID and explicit retention before RPC", async () => {
  const calls: unknown[] = [];
  const db = database((name, args) => {
    calls.push({ name, args });
    return {};
  });
  const data = {
    action: "unpin",
    requestId: id,
    expectedRevision: "2",
    retention: "week",
  };
  const req = new Request(`https://app.test/api/playlists/${id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  equal(
    (await playlistApi(req, `/api/playlists/${id}/actions`, "session", 1, db))
      ?.status,
    202,
  );
  equal(calls, [{
    name: "app_playlist_action",
    args: {
      p_epoch: 1,
      p_id: id,
      p_request: {
        requestId: id,
        expectedRevision: "2",
        action: "unpin",
        retention: "week",
      },
    },
  }]);
});
