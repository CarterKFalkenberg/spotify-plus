// Runs only against the disposable local stack. Keys arrive through stdin, never argv/logs.
import {
  DatabaseError,
  ServiceDatabase,
} from "../../functions/_shared/database.ts";
import {
  ownerFingerprint,
  SecretBox,
  sha256,
} from "../../functions/_shared/crypto.ts";
import { type ApiConfig, createApi } from "../../functions/api/handler.ts";
import { createJobs } from "../../functions/jobs/handler.ts";
import { SPOTIFY_SCOPES } from "../../functions/_shared/spotify.ts";
import { SESSION_COOKIE } from "../../functions/_shared/http.ts";
import { TEST_KEY } from "../../functions/_shared/testing.ts";
import { createLibraryRunner } from "../../functions/_shared/library.ts";
import type {
  CreateTagResponse,
  LibrarySearchResponse,
  LibraryStatusDTO,
  QueryPreviewResponse,
  TagActionResponse,
  TagLookupResponse,
  TagSearchResponse,
  UndoTagActionResponse,
} from "../../functions/_shared/contracts.ts";

import { playlistRestProof } from "./rest-playlists.ts";

let phase = "input";
let assertions = 0;
function check(value: unknown): asserts value {
  if (!value) throw new Error("assertion_failed");
  assertions++;
}
try {
  const input = await new Response(Deno.stdin.readable).json();
  check(input.origin === "http://127.0.0.1:61021");
  check(
    typeof input.serviceKey === "string" && typeof input.anonKey === "string",
  );
  const raw = async (
    name: string,
    args: Record<string, unknown> = {},
    key = input.serviceKey,
  ) => {
    const response = await fetch(`${input.origin}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    const body = await response.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch { /* Void responses are deliberately inspected separately. */ }
    return { status: response.status, empty: body === "", json };
  };
  phase = "schema_cache";
  const deadline = Date.now() + 10000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    const response = await raw("app_test_fixture", { p_action: "ready" });
    ready = response.status === 200 && response.json?.guardUntouched === true;
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  check(ready);
  phase = "safeupdate_and_roles";
  for (const kind of ["update", "delete"]) {
    const response = await raw(`app_test_unsafe_${kind}`);
    check(response.status === 400 && response.json?.code === "21000");
    check(
      response.json?.message ===
        `${kind.toUpperCase()} requires a WHERE clause`,
    );
  }
  check((await raw("app_account_status", {}, input.anonKey)).status === 401);
  check(
    (await raw("app_test_fixture", { p_action: "ready" }, input.anonKey))
      .status === 401,
  );
  const db = new ServiceDatabase(input.origin, input.serviceKey);
  const fixture = (p_action: string) =>
    db.rpc<Record<string, unknown>>("app_test_fixture", { p_action });
  check((await fixture("inspect")).guardUntouched === true);
  phase = "void_response";
  // Deliberately distinct from the maintenance SHA, so this cannot pre-seed its assertion.
  const probeSha = "d".repeat(40);
  const voidResponse = await raw("app_jobs_started", { p_sha: probeSha });
  check(voidResponse.status === 204 && voidResponse.empty);
  check(await db.rpc("app_jobs_started", { p_sha: probeSha }) === undefined);
  check((await db.rpc<{ jobsSha: string }>("app_health")).jobsSha === probeSha);
  phase = "pacing";
  const status = await db.rpc<{ epoch: number; state: string }>(
    "app_account_status",
  );
  check(status.state === "disconnected");
  const epoch = status.epoch;
  const acquire = () =>
    db.rpc<{ granted: boolean; retryAfterMs: number }>("app_pacing_acquire", {
      p_epoch: epoch,
      p_interval_ms: 500,
    });
  check((await acquire()).granted === true);
  const denied = await acquire();
  check(denied.granted === false && denied.retryAfterMs > 0);
  await fixture("reset_pacing");
  phase = "verified_bootstrap";
  const config: ApiConfig = {
    origin: "https://synthetic.example",
    sha: "a".repeat(40),
    clientId: "synthetic-client",
    expectedUserId: "synthetic-owner",
    proxySecret: "p".repeat(32),
    bootstrapSecret: "b".repeat(32),
    ownerBindingKey: TEST_KEY,
  };
  let identityCalls = 0;
  const api = createApi({
    db,
    box: new SecretBox(TEST_KEY),
    config,
    fetch: (url, init) => {
      check(String(url) === "https://api.spotify.com/v1/me");
      check(
        new Headers(init?.headers).get("Authorization") ===
          "Bearer synthetic-access",
      );
      identityCalls++;
      return Promise.resolve(
        Response.json({
          id: "synthetic-owner",
          account_id: "synthetic-account",
        }),
      );
    },
  });
  const apiRequest = (path: string, init: RequestInit = {}) =>
    new Request(config.origin + "/api" + path, {
      ...init,
      headers: {
        "x-proxy-secret": config.proxySecret,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  const authorizedAt = new Date(Date.now() - 3600000).toISOString();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const grant = {
    clientId: config.clientId,
    userId: config.expectedUserId,
    accountId: "synthetic-account",
    authorizedAt,
    accessExpiresAt: expiresAt,
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
    scopes: SPOTIFY_SCOPES,
  };
  const bootstrapRequest = () =>
    apiRequest("/internal/bootstrap", {
      method: "POST",
      headers: { "x-bootstrap-secret": config.bootstrapSecret },
      body: JSON.stringify(grant),
    });
  const unauthorized = await api(
    apiRequest("/internal/bootstrap", {
      method: "POST",
      body: JSON.stringify(grant),
    }),
  );
  check(unauthorized.status === 401 && Number(identityCalls) === 0);
  phase = "bootstrap_commit";
  const imported = await api(bootstrapRequest());
  check(
    imported.status === 200 && (await imported.json()).consumed === true &&
      identityCalls === 1,
  );
  phase = "bootstrap_cookie";
  const setCookie = imported.headers.get("set-cookie") ?? "";
  check(
    setCookie.includes("HttpOnly") && setCookie.includes("Secure") &&
      setCookie.includes("SameSite=Lax"),
  );
  const cookie = setCookie.split(";")[0];
  check(cookie.startsWith(SESSION_COOKIE + "="));
  const sessionHash = await sha256(cookie.slice(SESSION_COOKIE.length + 1));
  phase = "bootstrap_session";
  const session = await db.rpc<{ authorizedAt: string; epoch: number }>(
    "app_session",
    { p_token_hash: sessionHash },
  );
  check(
    session.epoch === epoch &&
      Date.parse(session.authorizedAt) === Date.parse(authorizedAt),
  );
  check(
    (await (await api(
      apiRequest("/api/session", { headers: { Cookie: cookie } }),
    )).json()).authenticated === true,
  );
  const replay = await api(bootstrapRequest());
  check(
    replay.status === 200 && replay.headers.get("set-cookie") === null &&
      identityCalls === 1,
  );
  phase = "oauth_state";
  const start = await api(apiRequest("/auth/spotify/start"));
  check(start.status === 303);
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const browser = start.headers.get("set-cookie")!.split(";")[0];
  const callback = () =>
    apiRequest(`/auth/spotify/callback?state=${state}&error=access_denied`, {
      headers: { Cookie: browser },
    });
  check(
    (await api(callback())).headers.get("location")?.endsWith(
      "auth_error=consent_denied",
    ),
  );
  check(
    (await api(callback())).headers.get("location")?.endsWith(
      "auth_error=invalid_state",
    ),
  );
  phase = "refresh_and_owner_fences";
  const connectArgs = {
    p_epoch: epoch,
    p_account_id: "synthetic-account",
    p_owner_fingerprint: await ownerFingerprint("synthetic-account", TEST_KEY),
    p_initial_owner_verified: false,
    p_encrypted_tokens: "synthetic-encrypted-record",
    p_access_expires_at: expiresAt,
    p_authorized_at: authorizedAt,
    p_session_hash: null,
    p_bootstrap: false,
  };
  let wrongOwner = false;
  try {
    await db.rpc("app_connect", {
      ...connectArgs,
      p_owner_fingerprint: "e".repeat(64),
    });
  } catch (error) {
    wrongOwner = error instanceof DatabaseError &&
      error.kind === "wrong_account";
  }
  check(wrongOwner);
  type Claim = {
    action: string;
    version: number;
    lease: string;
    retryAfterMs: number;
  };
  const claim = (p_force_version?: number) =>
    db.rpc<Claim>("app_token_claim", {
      p_epoch: epoch,
      ...(p_force_version === undefined ? {} : { p_force_version }),
    });
  let cached = await claim();
  check(cached.action === "cached");
  let refresh = await claim(cached.version);
  check(refresh.action === "refresh" && (await claim()).action === "busy");
  check(
    await db.rpc("app_token_finish", {
      p_epoch: epoch,
      p_lease: refresh.lease,
      p_encrypted_tokens: "synthetic-rotated",
      p_access_expires_at: expiresAt,
    }) === true,
  );
  check((await claim(cached.version)).action === "cached");
  check(
    await db.rpc("app_token_finish", {
      p_epoch: epoch,
      p_lease: refresh.lease,
      p_encrypted_tokens: "stale",
      p_access_expires_at: expiresAt,
    }) === false,
  );
  cached = await claim();
  refresh = await claim(cached.version);
  check(
    await db.rpc("app_token_fail", {
      p_epoch: epoch,
      p_lease: refresh.lease,
      p_reconnect: false,
      p_retry_ms: 60000,
    }) === true,
  );
  const cooldown = await claim(cached.version);
  check(cooldown.action === "cooldown" && cooldown.retryAfterMs > 59000);
  check(
    await db.rpc("app_pacing_defer", {
      p_epoch: epoch,
      p_retry_ms: 1,
      p_kind: "quota",
    }) === undefined,
  );
  check((await acquire()).retryAfterMs > 21599000);
  await fixture("reset_pacing");
  refresh = await claim(cached.version);
  check(refresh.action === "refresh");
  check(
    await db.rpc("app_token_fail", {
      p_epoch: epoch,
      p_lease: refresh.lease,
      p_reconnect: true,
    }) === true,
  );
  check(
    (await claim()).action === "reconnect" &&
      (await fixture("inspect")).credentials === false,
  );
  check(await db.rpc("app_connect", connectArgs) === true);
  cached = await claim();
  refresh = await claim(cached.version);
  check(refresh.action === "refresh");
  await fixture("expire_refresh");
  check(
    (await claim()).action === "reconnect" &&
      (await fixture("inspect")).credentials === false,
  );
  check(await db.rpc("app_connect", connectArgs) === true);
  await fixture("expire_authorization");
  check(
    (await claim()).action === "reconnect" &&
      (await fixture("inspect")).credentials === false,
  );
  check(await db.rpc("app_connect", connectArgs) === true);
  phase = "jobs_maintenance";
  let purges = 0;
  const cronSecret = "c".repeat(32);
  const jobs = createJobs({
    db,
    sha: config.sha,
    cronSecret,
    library: createLibraryRunner({
      db,
      annotationBox: new SecretBox(TEST_KEY),
      wait: () => Promise.resolve(),
      spotify: () => ({
        getSavedTracksPage: () =>
          Promise.resolve({
            offset: 0,
            limit: 50,
            nextOffset: null,
            total: 1,
            items: [{
              addedAt: "2026-01-01T00:00:00Z",
              track: {
                id: "a".repeat(22),
                uri: `spotify:track:${"a".repeat(22)}`,
                name: "Synthetic library track",
                artists: [{ id: "b".repeat(22), name: "Synthetic artist" }],
                album: {
                  id: "c".repeat(22),
                  name: "Synthetic album",
                  releaseDate: "2026",
                  images: [],
                },
                durationMs: 1000,
                explicit: false,
                isLocal: false,
                isPlayable: true,
              },
            }],
          }),
      }),
    }),
    backups: {
      purge: () => {
        purges++;
        return Promise.resolve(true);
      },
    },
  });
  const jobsRequest = () =>
    new Request(config.origin + "/jobs", {
      method: "POST",
      headers: { "x-cron-secret": cronSecret },
    });
  await db.rpc("app_job_enqueue", { p_kind: "scheduler_ping", p_epoch: null });
  const drained = await jobs(jobsRequest());
  check(drained.status === 200);
  check((await drained.json()).completed >= 1);
  const health = await db.rpc<{ jobsSha: string; lastJobAt: string }>(
    "app_health",
  );
  check(
    health.jobsSha === config.sha &&
      Number.isFinite(Date.parse(health.lastJobAt)),
  );
  check((await fixture("inspect")).maintenanceRecorded === true);
  phase = "library_transactions";
  const libraryStatus = await db.rpc<LibraryStatusDTO>("app_library_status", {
    p_epoch: epoch,
  });
  check(libraryStatus.initialSyncComplete && libraryStatus.activeCount === 1);
  const createdTag = await db.rpc<CreateTagResponse>("app_tag_create", {
    p_epoch: epoch,
    p_name: "Synthetic Tag",
  });
  check(createdTag.created);
  check(
    !(await db.rpc<CreateTagResponse>("app_tag_create", {
      p_epoch: epoch,
      p_name: "synthetic tag",
    })).created,
  );
  const filter = {
    membership: "active",
    search: "",
    untagged: false,
    newOnly: false,
    artistId: null,
  };
  const foundTracks = await db.rpc<LibrarySearchResponse>(
    "app_library_search",
    {
      p_epoch: epoch,
      p_request: { filter, groupBy: null, cursor: null, limit: 1 },
    },
  );
  check(
    foundTracks.groupBy === null && foundTracks.tracks.length === 1 &&
      foundTracks.totalTracks === 1,
  );
  const tagAction = await db.rpc<TagActionResponse>("app_tag_action", {
    p_epoch: epoch,
    p_session_hash: sessionHash,
    p_request: {
      action: "add",
      tagId: createdTag.tag.id,
      selection: {
        kind: "filter",
        filter,
        expectedRevision: foundTracks.revision,
      },
    },
  });
  check(tagAction.changedCount === 1 && tagAction.selectedCount === 1);
  const preview = await db.rpc<QueryPreviewResponse>("app_query_preview", {
    p_epoch: epoch,
    p_request: {
      query: { version: 1, root: { op: "tag", tagId: createdTag.tag.id } },
      cursor: null,
      limit: 1,
    },
  });
  check(
    preview.generationReady && preview.matchedCount === 1 &&
      preview.playableCount === 1 && preview.durationMs === 1000,
  );
  phase = "playlist_transactions";
  await playlistRestProof(
    db,
    config,
    cookie,
    { version: 1, root: { op: "tag", tagId: createdTag.tag.id } },
    preview,
    fixture,
    check,
  );
  check(
    (await raw("app_playlist_list", { p_epoch: epoch }, input.anonKey))
      .status === 401,
  );
  phase = "library_transactions";
  const undone = await db.rpc<UndoTagActionResponse>("app_tag_undo", {
    p_epoch: epoch,
    p_session_hash: sessionHash,
    p_action_id: tagAction.actionId,
  });
  check(undone.restoredCount === 1 && undone.skippedCount === 0);
  phase = "atomic_tag_name_and_lookup";
  const nameSelection = {
    kind: "filter",
    filter: { ...filter, untagged: true },
    expectedRevision: undone.revision,
  };
  const mutate = (path: string, body: unknown) =>
    api(apiRequest(path, {
      method: "POST",
      headers: { Cookie: cookie, Origin: config.origin },
      body: JSON.stringify(body),
    }));
  const namedResponse = await mutate("/api/tag-actions", {
    action: "add",
    tagName: "  Synthetic   Atomic Tag  ",
    selection: nameSelection,
  });
  check(namedResponse.status === 200);
  const named = await namedResponse.json() as TagActionResponse;
  check(
    named.tag.name === "Synthetic Atomic Tag" &&
      named.tag.activeTrackCount === 1 && named.changedCount === 1 &&
      named.selectedCount === 1,
  );
  const lookupResponse = await mutate("/api/tags/lookup", {
    tagIds: [named.tag.id.toUpperCase(), createdTag.tag.id],
  });
  check(lookupResponse.status === 200);
  const lookup = await lookupResponse.json() as TagLookupResponse;
  check(
    lookup.tags.length === 2 && lookup.tags[0].id === named.tag.id &&
      lookup.tags[0].name === named.tag.name &&
      lookup.tags[1].id === createdTag.tag.id &&
      lookup.revision.annotations === named.revision.annotations,
  );
  const unknownLookup = await mutate("/api/tags/lookup", {
    tagIds: [named.tag.id, "ffffffff-ffff-4fff-8fff-ffffffffffff"],
  });
  check(
    unknownLookup.status === 409 &&
      JSON.stringify(await unknownLookup.json()) === '{"error":"unknown_tag"}',
  );
  check(
    (await mutate("/api/tags/lookup", {
      tagIds: [named.tag.id, named.tag.id.toUpperCase()],
    })).status === 400,
  );
  check(
    (await raw("app_tags_lookup", {
      p_epoch: epoch,
      p_tag_ids: [named.tag.id],
    }, input.anonKey)).status === 401,
  );
  const staleNamed = await mutate("/api/tag-actions", {
    action: "add",
    tagName: "Synthetic Orphan Must Not Exist",
    selection: nameSelection,
  });
  check(
    staleNamed.status === 409 &&
      (await staleNamed.json()).error === "stale_revision",
  );
  const orphan = await db.rpc<TagSearchResponse>("app_tags_search", {
    p_epoch: epoch,
    p_search: "Synthetic Orphan",
    p_limit: 20,
  });
  check(orphan.tags.length === 0);
  const namedUndoResponse = await mutate(
    `/api/tag-actions/${named.actionId}/undo`,
    {},
  );
  check(namedUndoResponse.status === 200);
  const namedUndo = await namedUndoResponse.json() as UndoTagActionResponse;
  check(namedUndo.restoredCount === 1 && namedUndo.skippedCount === 0);
  const acknowledgement = await db.rpc<{ changedCount: number }>(
    "app_library_acknowledge",
    { p_epoch: epoch, p_track_keys: [foundTracks.tracks[0].trackKey] },
  );
  check(acknowledgement.changedCount === 1);
  check(
    (await raw("app_library_status", { p_epoch: epoch }, input.anonKey))
      .status === 401,
  );
  phase = "disconnect_and_purge";
  await db.rpc("app_oauth_start", {
    p_state_hash: "f".repeat(64),
    p_browser_hash: "g".repeat(64),
    p_encrypted_verifier: "synthetic",
  });
  const jobId = await db.rpc<string>("app_job_enqueue", {
    p_kind: "synthetic",
    p_epoch: epoch,
    p_priority: 100,
  });
  const job = await db.rpc<{ id: string; leaseToken: string }>("app_job_claim");
  check(job.id === jobId);
  cached = await claim();
  refresh = await claim(cached.version);
  check(refresh.action === "refresh");
  const disconnectRequest = (origin: string) =>
    apiRequest("/api/disconnect", {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
      body: JSON.stringify({ confirmation: "DELETE ALL APP DATA" }),
    });
  check((await api(disconnectRequest("https://wrong.example"))).status === 403);
  const disconnected = await api(disconnectRequest(config.origin));
  check(
    disconnected.status === 202 &&
      (await disconnected.json()).connection === "disconnecting",
  );
  const purged = await fixture("inspect");
  check(
    purged.credentials === false && purged.sessions === 0 &&
      purged.oauthStates === 0 && purged.accountJobs === 0,
  );
  check(await db.rpc("app_session", { p_token_hash: sessionHash }) === null);
  check(
    await db.rpc("app_token_finish", {
      p_epoch: epoch,
      p_lease: refresh.lease,
      p_encrypted_tokens: "late",
      p_access_expires_at: expiresAt,
    }) === false,
  );
  check(
    await db.rpc("app_job_finish", {
      p_id: job.id,
      p_lease: job.leaseToken,
      p_outcome: "done",
    }) === false,
  );
  check(await db.rpc("app_connect", connectArgs) === false);
  const cleanup = await jobs(jobsRequest());
  check(
    cleanup.status === 200 && (await cleanup.json()).completed >= 1 &&
      purges === 1,
  );
  const final = await db.rpc<
    { state: string; ownerBound: boolean; bootstrapConsumed: boolean }
  >("app_account_status");
  check(
    final.state === "disconnected" && final.ownerBound === true &&
      final.bootstrapConsumed === true,
  );
  phase = "guarded_scheduler";
  await fixture("scheduler");
  check((await fixture("inspect")).guardUntouched === true);
  console.log(JSON.stringify({
    passed: true,
    assertions,
    safeupdate: true,
    void204: true,
    serviceDatabase: true,
    bootstrap: true,
    tokenRecovery: true,
    jobsDrain: true,
    libraryTransactions: true,
    playlistTransactions: true,
    atomicTagNameAndLookup: true,
    disconnectPurge: true,
    spotifyNetworkRequests: 0,
  }));
} catch {
  // Never serialize an exception, provider response, input or generated local key.
  console.error(
    JSON.stringify({ passed: false, blocker: `local_rest_${phase}_failed` }),
  );
  Deno.exitCode = 1;
}
