// Actual PostgREST/SQL transactions with an entirely synthetic remote playlist.
import type { Database } from "../../functions/_shared/database.ts";
import type { ApiConfig } from "../../functions/api/handler.ts";
import { createApi } from "../../functions/api/handler.ts";
import { SecretBox } from "../../functions/_shared/crypto.ts";
import { TEST_KEY } from "../../functions/_shared/testing.ts";
import { drainJobs } from "../../functions/_shared/jobs.ts";
import {
  type PlaylistSpotify,
  runPlaylistJob,
} from "../../functions/_shared/playlist-runner.ts";
import { SpotifyError } from "../../functions/_shared/spotify.ts";
import type {
  PlaylistListResponse,
  PlaylistMutationResponse,
  QueryPreviewResponse,
  StoredQuery,
} from "../../functions/_shared/contracts.ts";

export async function playlistRestProof(
  db: Database,
  config: ApiConfig,
  cookie: string,
  query: StoredQuery,
  preview: QueryPreviewResponse,
  fixture: (action: string) => Promise<unknown>,
  check: (value: unknown) => void,
) {
  let id = "p".repeat(22);
  let contained = false,
    creates = 0,
    removals = 0,
    networkFailures = 0,
    immediate = 0;
  let items: string[] = [], snapshot = 0;
  let description = "", name = "Synthetic managed playlist";
  const details = () => ({
    id,
    name,
    description,
    public: false,
    collaborative: false,
    ownerId: "synthetic-owner",
    snapshotId: String(snapshot),
    total: items.length,
  });
  const spotify: PlaylistSpotify = {
    getCurrentUser: () =>
      Promise.resolve({
        id: "synthetic-owner",
        accountId: "synthetic-account",
      }),
    createPrivatePlaylist: (input) => {
      creates++;
      id = (creates === 1 ? "p" : "q").repeat(22);
      contained = true;
      name = input.name;
      description = input.description;
      return Promise.resolve(details());
    },
    getPlaylist: () => Promise.resolve(details()),
    containsPlaylists: () => Promise.resolve([contained]),
    getCurrentUserPlaylistsPage: () =>
      Promise.resolve({
        items: contained ? [details()] : [],
        total: contained ? 1 : 0,
        offset: 0,
        limit: 50,
        nextOffset: null,
      }),
    getPlaylistItemsPage: () =>
      Promise.resolve({
        items: items.map((uri) => ({
          uri,
          type: "track",
          isLocal: false,
          addedAt: null,
        })),
        total: items.length,
        offset: 0,
        limit: 50,
        nextOffset: null,
      }),
    replacePlaylistItems: (_id, uris) => {
      items = [...uris];
      return Promise.resolve({ snapshotId: String(++snapshot) });
    },
    appendPlaylistItems: (_id, uris) => {
      items.push(...uris);
      return Promise.resolve({ snapshotId: String(++snapshot) });
    },
    updatePlaylistDescription: (_id, text) => {
      description = text;
      return Promise.resolve();
    },
    removeManagedPlaylists: async (ids) => {
      check(ids.length === 1 && ids[0] === id);
      check(
        await db.rpc("app_playlist_managed", { p_epoch: 1, p_spotify_id: id }),
      );
      if (networkFailures > 0) {
        networkFailures--;
        throw new SpotifyError("network", null, null, true);
      }
      removals++;
      contained = false;
    },
  };
  const drain = () =>
    drainJobs({
      db,
      sha: config.sha,
      backups: {
        purge: () => Promise.reject(new Error("unexpected synthetic purge")),
      },
      playlist: (job, deadline) => runPlaylistJob(db, spotify, job, deadline),
    });
  let background: Promise<unknown> = Promise.resolve();
  const api = createApi({
    db,
    config,
    box: new SecretBox(TEST_KEY),
    startJobs: () => {
      immediate++;
      background = drain();
    },
  });
  const call = (path: string, body?: unknown) =>
    api(
      new Request(config.origin + "/api/api" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-proxy-secret": config.proxySecret,
          Cookie: cookie,
          Origin: config.origin,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const list = async () => {
    const response = await call("/playlists");
    check(response.status === 200);
    return await response.json() as PlaylistListResponse;
  };
  const input = {
    requestId: crypto.randomUUID(),
    query,
    previewRevision: preview.revision,
    name,
    retention: "month",
  };
  const created = await call("/playlists", input);
  check(created.status === 202 && immediate === 1);
  const ack = await created.json() as PlaylistMutationResponse;
  check(ack.playlist.status === "pending");
  await background;
  let current = (await list()).playlists[0];
  check(
    current.status === "ready" && current.trackCount === 1 &&
      items.length === 1 && creates === 1,
  );
  const repeated = await call("/playlists", input);
  check(
    repeated.status === 202 &&
      JSON.stringify(await repeated.json()) === JSON.stringify(ack),
  );
  await background;
  check(creates === 1);
  const action = async (kind: string, extra = {}) => {
    const response = await call(`/playlists/${current.id}/actions`, {
      requestId: crypto.randomUUID(),
      expectedRevision: current.revision,
      action: kind,
      ...extra,
    });
    check(response.status === 202);
    await background;
    current = (await list()).playlists[0];
  };
  name = "Synthetic owner rename";
  description = "Preserve outside text.\n" + description;
  items.push(`spotify:track:${"z".repeat(22)}`);
  snapshot++;
  await action("regenerate");
  check(
    current.status === "ready" && current.name === name && items.length === 1 &&
      description.startsWith("Preserve outside text.\n"),
  );
  await action("pin");
  check(current.retention === "pinned" && current.expiresOn === null);
  await action("unpin", { retention: "week" });
  check(current.retention === "week" && current.expiresOn !== null);
  const stale = await call(`/playlists/${current.id}/actions`, {
    requestId: crypto.randomUUID(),
    expectedRevision: "0",
    action: "pin",
  });
  check(
    stale.status === 409 && (await stale.json()).error === "stale_revision",
  );

  // Permanent disclosure failure must not strand a known managed playlist.
  description = "Synthetic user text ".repeat(30);
  await action("extend", { retention: "month" });
  check(current.status === "incomplete" && current.blockedBy === "unavailable");
  networkFailures = 6;
  await action("delete");
  for (let attempt = 0; attempt < 6; attempt++) {
    await fixture("retry_playlists");
    await drain();
  }
  check((await list()).playlists.length === 0 && removals === 1 && !contained);
  // Natural cron maintenance supersedes the same permanent failure safely.
  input.requestId = crypto.randomUUID();
  check((await call("/playlists", input)).status === 202);
  await background;
  current = (await list()).playlists[0];
  description = "Synthetic user text ".repeat(30);
  await action("extend", { retention: "month" });
  check(current.status === "incomplete");
  await fixture("expire_playlists");
  await db.rpc("app_job_enqueue", { p_kind: "scheduler_ping", p_epoch: null });
  await drain();
  const expired = await list();
  check(
    expired.playlists.length === 0 && expired.lastCleanupAt !== null &&
      removals === 2,
  );
}
