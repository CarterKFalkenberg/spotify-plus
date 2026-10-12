// Operator stdin only; output is a fixed projection of counts and booleans.
// Do not log responses, metadata, identifiers, exceptions, or request URLs.
import type {
  LibraryFilter,
  LibrarySearchResponse,
  LibraryStatusDTO,
  ManagedPlaylistDTO,
  PlaylistListResponse,
  PlaylistMutationResponse,
  QueryPreviewResponse,
  StoredQuery,
  TagActionResponse,
  TrackDTO,
  UndoTagActionResponse,
} from "../../supabase/functions/_shared/contracts.ts";
import { parseQuery } from "../../supabase/functions/_shared/contracts.ts";
import { ServiceDatabase } from "../../supabase/functions/_shared/database.ts";
import {
  ownerFingerprint,
  SecretBox,
} from "../../supabase/functions/_shared/crypto.ts";
import {
  databasePacing,
  OwnerTokens,
} from "../../supabase/functions/_shared/tokens.ts";
import {
  SpotifyClient,
  SpotifyError,
  type SpotifyPage,
  type SpotifyPlaylist,
  type SpotifyPlaylistItem,
} from "../../supabase/functions/_shared/spotify.ts";
import { pacedRequests } from "./paced-request.ts";
import { retryAfter } from "../../supabase/functions/_shared/retry-after.ts";
import {
  check,
  cleanupFixturesSql,
  type CoreRegistry,
  duePlaylistSql,
  fixtureName,
  insertFixturesSql,
  newRegistry,
  ProofFailure,
  validateRegistry,
} from "./core-fixtures.ts";

interface Input {
  origin: string;
  appUrl: string;
  projectRef: string;
  managementToken: string;
  serviceKey: string;
  clientId: string;
  encryptionKey: string;
  bindingKey: string;
  ownerFingerprint: string;
  epoch: number;
  registryPath: string;
  cookie: string;
  authorized: boolean;
  head: string;
}
export async function writeCoreRegistry(path: string, registry: CoreRegistry) {
  validateRegistry(registry);
  const file = await Deno.open(`${path}.tmp`, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    await Deno.chmod(`${path}.tmp`, 0o600);
    const bytes = new TextEncoder().encode(JSON.stringify(registry));
    let offset = 0;
    while (offset < bytes.length) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(`${path}.tmp`, path);
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export async function assertDisposableRenameAcknowledged(
  response: Response,
  defer: (input: { retryAfterMs: number; kind: "rate_limit" }) => Promise<void>,
) {
  const status = response.status;
  if (status === 200 || status === 204) {
    await response.body?.cancel();
    return;
  }
  if (status === 429) {
    const delay = Math.max(
      60000,
      retryAfter(response.headers.get("retry-after"), Date.now()) ?? 60000,
    );
    try {
      await defer({ retryAfterMs: delay, kind: "rate_limit" });
    } catch {
      await response.body?.cancel();
      throw new ProofFailure("core_disposable_rename_cooldown_unconfirmed");
    }
  }
  // Never read/emit a vendor error body or replay a dispatched write.
  await response.body?.cancel();
  const reason = status === 400
    ? "bad_request"
    : status === 401
    ? "unauthorized"
    : status === 403
    ? "forbidden"
    : status === 429
    ? "rate_limited"
    : status >= 500 && status <= 599
    ? "server_error"
    : "unexpected_status";
  throw new ProofFailure(`core_disposable_rename_${reason}`);
}
export interface PlaylistReadinessWork {
  status: string;
  blockedBy: string | null;
  operationState: string | null;
  jobState: string | null;
}
export function playlistWorkCanProgress(work: PlaylistReadinessWork) {
  if (![null, "unavailable", "rateLimited"].includes(work.blockedBy)) {
    return false;
  }
  // Completion can race the earlier product DTO read. Re-poll the product
  // endpoint rather than treating the database observation as readiness proof.
  if (
    work.status === "ready" && work.blockedBy === null &&
    work.operationState === null && work.jobState === null
  ) return true;
  return ["pending", "incomplete"].includes(work.status) &&
    work.operationState === "active" &&
    ["queued", "running"].includes(work.jobState ?? "");
}
export async function waitForPlaylistReady(
  read: () => Promise<ManagedPlaylistDTO | null>,
  readWork: () => Promise<PlaylistReadinessWork | null>,
  pause: (ms: number) => Promise<void> = sleep,
  attempts = 120,
): Promise<ManagedPlaylistDTO> {
  for (let i = 0; i < attempts; i++) {
    const p = await read();
    check(p !== null, "core_playlist_work_blocked");
    check(
      [null, "unavailable", "rateLimited"].includes(p.blockedBy),
      "core_playlist_work_blocked",
    );
    if (p.status === "ready" && p.blockedBy === null) return p;
    check(
      ["pending", "incomplete"].includes(p.status),
      "core_playlist_incomplete_requires_operator",
    );
    if (p.status === "incomplete" || p.blockedBy !== null) {
      const work = await readWork();
      check(
        work !== null && playlistWorkCanProgress(work),
        "core_playlist_incomplete_requires_operator",
      );
    }
    // Observe the durable worker's own backoff; never submit Retry here.
    await pause(5000);
  }
  throw new ProofFailure("core_playlist_not_ready");
}
async function privateFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new ProofFailure("core_request_unavailable");
  }
}
export function assertProgress(s: LibraryStatusDTO) {
  check(
    ["idle", "importing", "verifying"].includes(s.syncPhase) &&
      [s.importedCount, s.activeCount, s.untaggedCount, s.newCount].every((n) =>
        Number.isSafeInteger(n) && n >= 0
      ) &&
      (s.reportedTotal === null ||
        Number.isSafeInteger(s.reportedTotal) && s.reportedTotal >= 0) &&
      s.untaggedCount <= s.activeCount && s.newCount <= s.activeCount &&
      typeof s.initialSyncComplete === "boolean",
    "core_progress_schema_failed",
  );
  check(s.blockedBy === null, "core_library_work_blocked");
}
export function assertPreview(
  p: QueryPreviewResponse,
  tracks: readonly TrackDTO[],
) {
  check(
    p.generationReady === true &&
      [p.matchedCount, p.playableCount, p.excludedCount, p.durationMs].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) &&
      p.matchedCount === p.playableCount + p.excludedCount &&
      p.matchedCount === tracks.length &&
      new Set(tracks.map((t) => t.trackKey)).size === tracks.length,
    "core_preview_counts_failed",
  );
  const playable = tracks.filter((t) => t.metadata?.playableUri);
  check(
    playable.length === p.playableCount &&
      playable.reduce((n, t) => n + (t.metadata?.durationMs ?? 0), 0) ===
        p.durationMs,
    "core_preview_duration_failed",
  );
  for (let i = 1; i < tracks.length; i++) {
    const before = tracks[i - 1], after = tracks[i];
    const a = Date.parse(before.metadata?.likedAt ?? ""),
      b = Date.parse(after.metadata?.likedAt ?? "");
    check(
      Number.isFinite(a) && Number.isFinite(b) &&
        (a > b || a === b && before.trackKey < after.trackKey),
      "core_preview_order_failed",
    );
  }
}
export function assertPreviewPage(
  expected: StoredQuery,
  first: QueryPreviewResponse,
  page: QueryPreviewResponse,
) {
  let sameQuery = false;
  try {
    sameQuery = JSON.stringify(parseQuery(expected)) ===
      JSON.stringify(parseQuery(page.query));
  } catch {
    throw new ProofFailure("core_preview_query_invalid");
  }
  check(
    first.revision.library === page.revision.library &&
      first.revision.annotations === page.revision.annotations &&
      first.matchedCount === page.matchedCount &&
      first.playableCount === page.playableCount &&
      first.excludedCount === page.excludedCount &&
      first.generationReady === page.generationReady && sameQuery &&
      first.durationMs === page.durationMs,
    "core_preview_revision_changed",
  );
}
export async function runCoreProof(input: Input) {
  check(input.authorized === true, "core_playlist_authorization_required");
  check(
    /^[a-f0-9]{40}$/.test(input.head) &&
      /^[a-z0-9]{20}$/.test(input.projectRef),
    "core_target_invalid",
  );
  let requestSpotify: ReturnType<typeof pacedRequests> | undefined;
  const db = new ServiceDatabase(input.origin, input.serviceKey);
  const tokens = new OwnerTokens(
    db,
    new SecretBox(input.encryptionKey),
    input.epoch,
    input.clientId,
  );
  const pacing = databasePacing(db, input.epoch);
  check(
    await db.rpc("app_epoch_active", { p_epoch: input.epoch }),
    "core_owner_not_active",
  );
  const sql = async <T>(query: string, readOnly = true): Promise<T[]> => {
    const response = await privateFetch(
      `https://api.supabase.com/v1/projects/${input.projectRef}/database/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.managementToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, read_only: readOnly }),
      },
    );
    check(response.ok, "core_operator_query_failed");
    try {
      const value = await response.json();
      check(Array.isArray(value), "core_operator_schema_failed");
      return value;
    } catch {
      throw new ProofFailure("core_operator_schema_failed");
    }
  };
  const fixtureStatement = async (query: string) => {
    const result = await sql<{ ok: boolean }>(query, false);
    check(
      result.length === 1 && result[0].ok === true,
      "core_fixture_statement_unconfirmed",
    );
  };
  const api = async <T>(
    path: string,
    body?: unknown,
    expected = 200,
  ): Promise<T> => {
    const response = await privateFetch(input.appUrl + "/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: input.cookie,
        origin: input.appUrl,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    check(
      response.status === expected &&
        response.headers.get("cache-control")?.includes("no-store"),
      "core_product_api_failed",
    );
    try {
      return await response.json();
    } catch {
      throw new ProofFailure("core_product_schema_failed");
    }
  };
  const save = (r: CoreRegistry) => writeCoreRegistry(input.registryPath, r);
  let observations = 0;
  const lock = await Deno.open(input.registryPath + ".lock", {
    createNew: true,
    write: true,
    mode: 0o600,
  }).catch(() => {
    throw new ProofFailure("core_operator_lock_requires_recovery");
  });
  try {
    let registry: CoreRegistry | null = null;
    try {
      const info = await Deno.lstat(input.registryPath);
      check(
        info.isFile && !info.isSymlink && (info.mode! & 0o777) === 0o600,
        "invalid_core_registry",
      );
      registry = JSON.parse(await Deno.readTextFile(input.registryPath));
      validateRegistry(registry!);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new ProofFailure("invalid_core_registry");
      }
    }
    const old = registry;
    if (old && old.phase !== "cleaned") {
      check(
        old.epoch === input.epoch &&
          old.ownerFingerprint === input.ownerFingerprint,
        "core_recovery_owner_changed",
      );
      // Reconcile the durable request UUID before any new intent. Never replay an ambiguous Spotify POST.
      const rows = await sql<
        { id: string; spotify_id: string | null; status: string }
      >(`select p.id,p.spotify_id,p.status from app.playlists p join app.playlist_requests r on r.playlist_id=p.id where r.request_id='${old.requestId}' and p.epoch=${old.epoch} and p.name like 'Tagger API test ${old.run}%';`);
      check(rows.length <= 1, "core_recovery_identity_ambiguous");
      if (rows.length === 1) {
        check(
          old.playlistId === null || old.playlistId === rows[0].id,
          "core_recovery_identity_ambiguous",
        );
        old.playlistId = rows[0].id;
        old.spotifyPlaylistId = rows[0].spotify_id;
        await save(old);
        if (rows[0].status !== "removed") {
          const p = await findPlaylist(old.playlistId);
          check(
            p?.status === "ready" || p?.status === "incomplete",
            "core_recovery_wait_for_durable_playlist",
          );
          await api(`/playlists/${old.playlistId}/actions`, {
            requestId: crypto.randomUUID(),
            expectedRevision: p.revision,
            action: "delete",
          }, 202);
          await waitRemoved(old);
        }
        await confirmRemoved(old);
      }
      check(
        old.phase !== "creating" || rows.length === 1,
        "core_recovery_create_outcome_unconfirmed",
      );
      await waitQuiet();
      await fixtureStatement(cleanupFixturesSql(old, true));
      old.phase = "cleaned";
      await save(old);
      throw new ProofFailure("core_previous_fixture_cleaned_rerun");
    }
    // All public product endpoints must reject an unauthenticated caller; POST bodies are invalid
    // as a second guard so a regression cannot create/delete data while testing authorization.
    for (
      const [path, method] of [
        ["/library/status", "GET"],
        ["/library/sync", "POST"],
        ["/library/search", "POST"],
        ["/library/acknowledge", "POST"],
        ["/tags", "GET"],
        ["/tags", "POST"],
        ["/tag-actions", "POST"],
        ["/query/preview", "POST"],
        ["/playlists", "GET"],
        ["/playlists", "POST"],
      ]
    ) {
      const response = await privateFetch(input.appUrl + "/api" + path, {
        method,
        headers: { origin: input.appUrl, "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      check(response.status === 401, "core_public_route_unprotected");
    }

    const automatic = await completeSync();
    const opened = await api<LibraryStatusDTO>("/library/sync", {
      reason: "app-open",
    });
    assertProgress(opened);
    const probeFirst = await sql<{ last_probe_at: string | null }>(
      "select last_probe_at from app.library_state where singleton;",
    );
    const openedAgain = await api<LibraryStatusDTO>("/library/sync", {
      reason: "app-open",
    });
    assertProgress(openedAgain);
    const probeSecond = await sql<{ last_probe_at: string | null }>(
      "select last_probe_at from app.library_state where singleton;",
    );
    check(
      probeFirst[0]?.last_probe_at === probeSecond[0]?.last_probe_at,
      "core_app_open_debounce_failed",
    );
    const syncBefore = Date.now();
    await api("/library/sync", { reason: "manual" });
    const status = await completeSync(syncBefore);
    // Completion retains pass counters but intentionally deletes sync_seen. Assert the
    // persisted stable-completion transition; synthetic SQL tests prove set comparison.
    const stable = await sql<{ stable: boolean }>(
      `select exists(select 1 from app.library_state s join app.sync_runs r on r.id=s.latest_run_id join app.jobs j on j.id=r.job_id where s.epoch=${input.epoch} and s.initial_sync_complete and r.completed_at is not null and r.pass>=2 and r.prior_valid_pass=r.pass-1 and not r.invalid_pass and r.received_count=r.reported_total and j.state='done') as stable;`,
    );
    check(stable[0]?.stable === true, "core_stable_pass_evidence_missing");
    await waitQuiet();
    registry = newRegistry(input.epoch, input.ownerFingerprint);
    const r = registry;
    await save(r);
    r.phase = "inserting";
    await save(r);
    await fixtureStatement(insertFixturesSql(r));
    r.phase = "fixtures";
    await save(r);
    try {
      await tagging(r);
      await fixtureStatement(cleanupFixturesSql(r, false));
      r.phase = "tracks-cleaned";
      await save(r);
      const query: StoredQuery = {
        version: 1,
        root: { op: "not", child: { op: "tag", tagId: r.tagIds[1] } },
      };
      const pacingBefore = await previewObservation();
      const preview = await allPreview(query);
      const pacingAfter = await previewObservation();
      check(
        pacingBefore.quiet && pacingAfter.quiet &&
          pacingBefore.signature === pacingAfter.signature,
        "core_preview_transport_observation_changed",
      );
      check(preview.page.playableCount > 0, "core_no_playable_matches");
      const request = {
        requestId: r.requestId,
        query,
        previewRevision: preview.page.revision,
        name: fixtureName(r),
        retention: "month",
      };
      r.phase = "creating";
      await save(r);
      const ack = await api<PlaylistMutationResponse>(
        "/playlists",
        request,
        202,
      );
      check(
        ack.requestId === r.requestId &&
          ["pending", "incomplete", "ready"].includes(ack.playlist.status),
        "core_create_intent_not_durable",
      );
      r.playlistId = ack.playlist.id;
      r.phase = "playlist";
      await save(r);
      const duplicate = await api<PlaylistMutationResponse>(
        "/playlists",
        request,
        202,
      );
      check(
        duplicate.playlist.id === r.playlistId &&
          duplicate.requestId === r.requestId,
        "core_request_deduplication_failed",
      );
      let p = await waitReady(r);
      check(
        p.trackCount === preview.page.playableCount &&
          p.retention === "month" && p.expiresOn !== null,
        "core_snapshot_count_failed",
      );
      check(
        typeof p.spotifyUrl === "string" &&
          /^https:\/\/open.spotify.com\/playlist\/[A-Za-z0-9]{22}$/.test(
            p.spotifyUrl,
          ),
        "core_playlist_url_failed",
      );
      r.spotifyPlaylistId = p.spotifyUrl!.split("/").at(-1)!;
      await save(r);
      const remote = await remotePlaylist(r);
      const expected = preview.tracks.flatMap((t) =>
        t.metadata?.playableUri ? [t.metadata.playableUri] : []
      );
      await ordered(r, expected);
      check(
        remote.collaborative === false &&
          remote.name === fixtureName(r) &&
          remote.description?.includes("Tagger") &&
          remote.description.includes(p.expiresOn!),
        "core_disclosure_failed",
      );
      await publicationAcknowledged(r, "create");
      p = await action(r, p, "pin");
      check(
        p.retention === "pinned" && p.expiresOn === null,
        "core_pin_failed",
      );
      p = await action(r, p, "unpin", "week");
      check(
        p.retention === "week" && p.expiresOn !== null,
        "core_unpin_failed",
      );
      p = await action(r, p, "extend", "month");
      check(
        p.retention === "month" && p.expiresOn !== null,
        "core_extend_failed",
      );
      // Only this registered disposable receives an outside name/note edit.
      const note = `Synthetic outside note ${r.run}`;
      const current = await remotePlaylist(r);
      await renameDisposable(r, current, note);
      const regeneratedPreview = await allPreview(query);
      p = await action(r, p, "regenerate");
      const regenerated = await remotePlaylist(r);
      check(
        regenerated.name === fixtureName(r) + " renamed" &&
          regenerated.description?.includes(note) &&
          regenerated.collaborative === false,
        "core_regenerate_preservation_failed",
      );
      await publicationAcknowledged(r, "regenerate");
      await ordered(
        r,
        regeneratedPreview.tracks.flatMap((t) =>
          t.metadata?.playableUri ? [t.metadata.playableUri] : []
        ),
      );
      check(
        p.trackCount === regeneratedPreview.page.playableCount,
        "core_regenerate_count_failed",
      );
      // Every API-triggered drain is bounded to 80s. Wait 100s after its final action and require
      // no live leases/due jobs before making the recorded playlist due. Never invoke jobs/tick.
      await sleep(50000);
      await sleep(50000);
      await waitQuiet();
      const before = await sql<{ boundary: string }>(
        "select clock_timestamp()::text as boundary;",
      );
      await fixtureStatement(duePlaylistSql(r));
      // Natural maintenance may take fifteen minutes, followed by minute dispatch
      // and bounded worker drains. This proof never queues scheduler work.
      await waitRemoved(r, 240);
      let scheduled = false;
      for (let i = 0; i < 24; i++) {
        scheduled = await cronEvidence(before[0].boundary, r);
        if (scheduled) break;
        await sleep(5000);
      }
      check(scheduled, "core_authenticated_cron_expiry_not_observed");
      await confirmRemoved(r);
      r.phase = "removed";
      await save(r);
      await waitQuiet();
      await fixtureStatement(cleanupFixturesSql(r, true));
      r.phase = "cleaned";
      await save(r);
      return {
        automaticImportComplete: automatic.initialSyncComplete,
        stableManualSync: true,
        progressObservations: observations,
        activeTracks: status.activeCount,
        protectedCoreRoutes: true,
        isolatedTagging: true,
        changedOnlyUndo: true,
        filterRevisionGuard: true,
        previewMatches: preview.page.matchedCount,
        previewPlayable: preview.page.playableCount,
        previewExcluded: preview.page.excludedCount,
        previewDurationMs: preview.page.durationMs,
        previewPacingCredentialObservationUnchanged: true,
        publicationWriteAcknowledged: true,
        publicationReadbackVerified: false,
        publicReadback: remote.public,
        regeneratedPublicReadback: regenerated.public,
        noncollaborativeSnapshot: true,
        orderedSnapshot: true,
        requestIntentDeduplicated: true,
        pinUnpinExtend: true,
        regeneratePreservesNameAndNotes: true,
        acceleratedDeadline: true,
        authenticatedScheduledExpiry: true,
        removedByContains: true,
        removedByCurrentUserPlaylists: true,
        fixturesCleaned: true,
      };
    } catch (error) {
      // Deliberately preserve the registry on any uncertainty; next invocation reconciles
      // only its request/playlist and runs exact-ID cleanup before allowing a new proof.
      await save(r);
      throw error;
    }
  } finally {
    lock.close();
    await Deno.remove(input.registryPath + ".lock");
  }

  async function completeSync(after: number | null = null) {
    for (let i = 0; i < 180; i++) {
      const s = await api<LibraryStatusDTO>("/library/status");
      assertProgress(s);
      observations++;
      if (
        s.initialSyncComplete && s.syncPhase === "idle" &&
        (after === null || Date.parse(s.lastCompletedAt ?? "") >= after)
      ) return s;
      await sleep(5000);
    }
    throw new ProofFailure("core_stable_sync_not_completed");
  }
  async function waitQuiet() {
    for (let i = 0; i < 30; i++) {
      const rows = await sql<{ quiet: boolean }>(
        `select not exists(select 1 from app.jobs where (state='running' and lease_until>clock_timestamp()) or (epoch=${input.epoch} and kind in ('library_sync','library_probe','playlist') and state in ('queued','running','parked'))) as quiet;`,
      );
      if (rows[0]?.quiet) return;
      await sleep(5000);
    }
    throw new ProofFailure("core_jobs_not_quiet");
  }
  async function previewObservation() {
    const rows = await sql<{ quiet: boolean; signature: string }>(
      `select not exists(select 1 from app.jobs where state in ('queued','running') and (retry_at<=now() or lease_until>now())) as quiet, md5(p.next_at::text||p.cooldown_until::text||c.version::text||coalesce(c.refresh_lease::text,'')) as signature from app.spotify_pacing p cross join app.credentials c where p.singleton and c.singleton and c.epoch=${input.epoch};`,
    );
    check(rows.length === 1, "core_preview_observation_missing");
    return rows[0];
  }
  async function allPreview(query: StoredQuery) {
    let cursor: string | null = null;
    let first: QueryPreviewResponse | null = null;
    const tracks: TrackDTO[] = [];
    const cursors = new Set<string>();
    do {
      const p: QueryPreviewResponse = await api("/query/preview", {
        query,
        cursor,
        limit: 100,
      });
      first ??= p;
      assertPreviewPage(query, first, p);
      tracks.push(...p.tracks);
      cursor = p.nextCursor;
      check(
        cursor === null || typeof cursor === "string" && !cursors.has(cursor),
        "core_preview_paging_invalid",
      );
      if (cursor !== null) cursors.add(cursor);
      check(
        tracks.length <= 100000 && cursors.size <= 1000,
        "core_preview_unbounded",
      );
    } while (cursor !== null);
    assertPreview(first!, tracks);
    return { page: first!, tracks };
  }
  async function tagging(r: CoreRegistry) {
    const filter: LibraryFilter = {
      membership: "active",
      search: fixtureName(r),
      untagged: false,
      newOnly: false,
      artistId: null,
    };
    const search = (
      patch: Partial<LibraryFilter> = {},
      groupBy: "artist" | null = null,
    ) =>
      api<LibrarySearchResponse>("/library/search", {
        filter: { ...filter, ...patch },
        groupBy,
        cursor: null,
        limit: 100,
      });
    const found = await search();
    check(
      found.groupBy === null && found.totalTracks === 2 &&
        found.tracks.every((t) => r.trackKeys.includes(t.trackKey)),
      "core_fixture_search_failed",
    );
    const groups = await search({}, "artist");
    check(
      groups.groupBy === "artist" && groups.groups.length === 1 &&
        groups.groups[0].trackCount === 2,
      "core_fixture_groups_failed",
    );
    const safeGroup = (page: LibrarySearchResponse) => {
      check(
        page.groupBy === "artist" && page.groups.length === 1 &&
          page.groups[0].artistId === r.artistId,
        "core_fixture_groups_failed",
      );
      const selection = page.groups[0].selection;
      check(
        selection.kind === "filter" &&
          JSON.stringify(selection.expectedRevision) ===
            JSON.stringify(page.revision) &&
          selection.filter.membership === "active" &&
          selection.filter.search === fixtureName(r) &&
          selection.filter.artistId === r.artistId &&
          selection.filter.untagged === false &&
          selection.filter.newOnly === false,
        "core_fixture_selection_unsafe",
      );
      return {
        kind: "filter",
        filter: { ...filter, artistId: r.artistId },
        expectedRevision: page.revision,
      };
    };
    const frozenGroup = safeGroup(groups);
    const removed = await search({ membership: "removed" });
    check(removed.totalTracks === 1, "core_fixture_removed_failed");
    const fresh = await search({ newOnly: true });
    check(fresh.totalTracks === 2, "core_fixture_new_failed");
    const create = await api<{ tag: { id: string }; created: boolean }>(
      "/tags",
      { name: `  ${fixtureName(r).toUpperCase()}  ` },
    );
    check(
      create.tag.id === r.tagIds[0] && create.created === false,
      "core_tag_normalization_failed",
    );
    const add = await api<TagActionResponse>("/tag-actions", {
      selection: { kind: "tracks", trackKeys: [r.trackKeys[0]] },
      tagId: r.tagIds[0],
      action: "add",
    });
    check(add.changedCount === 1, "core_immediate_save_failed");
    const stale = await privateFetch(input.appUrl + "/api/tag-actions", {
      method: "POST",
      headers: {
        cookie: input.cookie,
        origin: input.appUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        selection: frozenGroup,
        tagId: r.tagIds[0],
        action: "add",
      }),
    });
    check(stale.status === 409, "core_filter_revision_guard_failed");
    const now = await search({}, "artist");
    check(
      now.groupBy === "artist" && now.groups[0].taggedCount === 1,
      "core_tag_durable_read_failed",
    );
    const bulk = await api<TagActionResponse>("/tag-actions", {
      selection: safeGroup(now),
      tagId: r.tagIds[0],
      action: "add",
    });
    check(
      bulk.selectedCount === 2 && bulk.changedCount === 1,
      "core_bulk_changed_only_failed",
    );
    const undo = await api<UndoTagActionResponse>(
      `/tag-actions/${bulk.actionId}/undo`,
      {},
    );
    check(
      undo.restoredCount === 1 && undo.skippedCount === 0,
      "core_bulk_undo_failed",
    );
    await api<TagActionResponse>("/tag-actions", {
      selection: { kind: "tracks", trackKeys: [r.trackKeys[2]] },
      tagId: r.tagIds[0],
      action: "add",
    });
    const archive = await search({ membership: "removed" });
    check(
      archive.groupBy === null && archive.tracks.length === 1 &&
        archive.tracks[0].tagIds.includes(r.tagIds[0]),
      "core_removed_annotation_failed",
    );
    const after = await search();
    check(
      after.groupBy === null &&
        after.tracks.find((t) => t.trackKey === r.trackKeys[0])?.tagIds
          .includes(r.tagIds[0]) &&
        after.tracks.find((t) => t.trackKey === r.trackKeys[1])?.tagIds
            .length === 0,
      "core_undo_preexisting_edge_changed",
    );
    await api("/library/acknowledge", { trackKeys: [r.trackKeys[0]] });
    check(
      (await search({ newOnly: true })).totalTracks === 1,
      "core_fixture_acknowledgement_failed",
    );
    const empty = await api<QueryPreviewResponse>("/query/preview", {
      query: { version: 1, root: { op: "tag", tagId: r.tagIds[1] } },
      cursor: null,
      limit: 100,
    });
    check(
      empty.matchedCount === 0 && empty.playableCount === 0 &&
        empty.durationMs === 0,
      "core_zero_match_preview_failed",
    );
    for (
      const root of [
        {
          op: "and",
          children: [{ op: "tag", tagId: r.tagIds[0] }, {
            op: "not",
            child: { op: "tag", tagId: r.tagIds[1] },
          }],
        },
        {
          op: "or",
          children: [{ op: "tag", tagId: r.tagIds[0] }, {
            op: "tag",
            tagId: r.tagIds[1],
          }],
        },
      ]
    ) {
      const compound = await api<QueryPreviewResponse>("/query/preview", {
        query: { version: 1, root },
        cursor: null,
        limit: 100,
      });
      check(
        compound.matchedCount === 1 && compound.playableCount === 0,
        "core_query_buckets_failed",
      );
    }
    const excluded = await api<QueryPreviewResponse>("/query/preview", {
      query: { version: 1, root: { op: "tag", tagId: r.tagIds[0] } },
      cursor: null,
      limit: 100,
    });
    check(
      excluded.matchedCount === 1 && excluded.excludedCount === 1 &&
        excluded.playableCount === 0,
      "core_unavailable_preview_failed",
    );
  }
  async function findPlaylist(id: string) {
    let cursor: string | null = null;
    do {
      const page: PlaylistListResponse = await api(
        "/playlists?limit=100" +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
      );
      check(page.cleanupBlockedBy === null, "core_cleanup_blocked");
      const p = page.playlists.find((p) => p.id === id);
      if (p) return p;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return null;
  }
  async function waitReady(r: CoreRegistry) {
    validateRegistry(r);
    return await waitForPlaylistReady(
      () => findPlaylist(r.playlistId!),
      async () => {
        const rows = await sql<PlaylistReadinessWork>(
          `select p.status,p.blocked_by as "blockedBy",o.state as "operationState",j.state as "jobState" from app.playlists p left join app.playlist_operations o on o.id=p.active_operation and o.epoch=p.epoch left join app.jobs j on j.id=o.job_id and j.epoch=p.epoch where p.id='${r.playlistId}' and p.epoch=${r.epoch};`,
        );
        check(rows.length <= 1, "core_operator_schema_failed");
        return rows[0] ?? null;
      },
    );
  }
  async function action(
    r: CoreRegistry,
    p: ManagedPlaylistDTO,
    action: string,
    retention?: string,
  ) {
    await api(`/playlists/${r.playlistId}/actions`, {
      requestId: crypto.randomUUID(),
      expectedRevision: p.revision,
      action,
      ...(retention ? { retention } : {}),
    }, 202);
    return await waitReady(r);
  }
  async function waitRemoved(r: CoreRegistry, attempts = 60) {
    for (let i = 0; i < attempts; i++) {
      const rows = await sql<{ removed: boolean }>(
        `select status='removed' and active_operation is null as removed from app.playlists where id='${r.playlistId}' and epoch=${r.epoch};`,
      );
      if (rows[0]?.removed) return;
      await sleep(5000);
    }
    throw new ProofFailure("core_removal_not_confirmed");
  }
  async function cronEvidence(boundary: string, r: CoreRegistry) {
    check(
      Number.isFinite(Date.parse(boundary)),
      "core_cron_boundary_invalid",
    );
    const since = new Date(boundary).toISOString();
    const rows = await sql<{ scheduled: boolean }>(
      `select exists(select 1 from app.cron_dispatches d join net._http_response h on h.id=d.request_id where d.dispatched_at>='${since}' and h.status_code=200 and not coalesce(h.timed_out,false) and h.error_msg is null and h.content::jsonb->>'jobsSha'='${input.head}' and (h.content::jsonb->>'completed')::integer>0) and exists(select 1 from app.playlist_operations o join app.jobs j on j.id=o.job_id join app.playlists p on p.id=o.playlist_id where p.id='${r.playlistId}' and p.epoch=${r.epoch} and p.status='removed' and o.kind='expire' and o.created_at>='${since}' and o.state='done' and j.state='done') as scheduled;`,
    );
    return rows[0]?.scheduled === true;
  }
  async function remotePlaylist(r: CoreRegistry) {
    validateRegistry(r);
    check(r.spotifyPlaylistId, "core_registered_remote_required");
    const p = await spotify({
      method: "GET",
      path: `/playlists/${r.spotifyPlaylistId}`,
    }) as SpotifyPlaylist;
    check(
      p.id === r.spotifyPlaylistId && p.ownerId === (await identity()).id,
      "core_remote_owner_mismatch",
    );
    return p;
  }
  async function publicationAcknowledged(
    r: CoreRegistry,
    kind: "create" | "regenerate",
  ) {
    validateRegistry(r);
    const rows = await sql<{ completed: boolean }>(
      `select exists(select 1 from app.playlist_operations o where o.playlist_id='${r.playlistId}' and o.epoch=${r.epoch} and o.kind='${kind}' and o.state='done') as completed;`,
    );
    // Exact-head worker completion follows a successful fixed-false PUT. This
    // proves acknowledgement under that implementation, not profile/search state.
    check(rows[0]?.completed === true, "core_publication_not_acknowledged");
  }
  async function renameDisposable(
    r: CoreRegistry,
    current: SpotifyPlaylist,
    note: string,
  ) {
    validateRegistry(r);
    check(
      r.phase === "playlist" && r.playlistId && r.spotifyPlaylistId &&
        current.id === r.spotifyPlaylistId &&
        current.collaborative === false &&
        current.name === fixtureName(r) &&
        note === `Synthetic outside note ${r.run}`,
      "core_rename_registry_required",
    );
    const description = `${note} ${current.description ?? ""}`;
    check(description.length <= 300, "core_synthetic_description_too_long");
    const token = await tokens.getAccessToken();
    let granted = false;
    for (let i = 0; i < 20; i++) {
      const slot = await pacing.acquire(500);
      if (slot.granted) {
        granted = true;
        break;
      }
      check(slot.retryAfterMs <= 10000, "core_rename_pacing_blocked");
      await sleep(Math.max(500, slot.retryAfterMs));
    }
    check(granted, "core_rename_pacing_blocked");
    const rows = await sql<{ managed: boolean }>(
      `select exists(select 1 from app.playlists p join app.account a on a.epoch=p.epoch where a.singleton and a.state='connected' and a.epoch=${r.epoch} and a.owner_fingerprint='${r.ownerFingerprint}' and p.id='${r.playlistId}' and p.spotify_id='${r.spotifyPlaylistId}' and p.status='ready' and p.active_operation is null and p.name='${
        fixtureName(r)
      }') as managed;`,
    );
    check(
      rows[0]?.managed === true &&
        await db.rpc("app_epoch_active", { p_epoch: r.epoch }),
      "core_rename_owner_changed",
    );
    // The runtime adapter intentionally cannot rename. This operator-only one-route
    // write simulates an outside edit of the exact privately registered disposable.
    const response = await privateFetch(
      `https://api.spotify.com/v1/playlists/${r.spotifyPlaylistId}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: fixtureName(r) + " renamed",
          description,
          public: false,
          collaborative: false,
        }),
      },
    );
    await assertDisposableRenameAcknowledged(response, pacing.defer);
  }
  async function ordered(r: CoreRegistry, expected: string[]) {
    const actual: (string | null)[] = [];
    let offset = 0;
    do {
      const page = await spotify({
        method: "GET",
        path: `/playlists/${r.spotifyPlaylistId}/items`,
        query: { limit: 50, offset },
      }) as SpotifyPage<SpotifyPlaylistItem>;
      actual.push(...page.items.map((t) => t.uri));
      if (page.nextOffset === null) break;
      check(
        page.nextOffset > offset && page.nextOffset <= expected.length,
        "core_remote_paging_invalid",
      );
      offset = page.nextOffset;
    } while (true);
    check(
      actual.length === expected.length &&
        actual.every((uri, i) => uri === expected[i]),
      "core_remote_order_mismatch",
    );
  }
  async function confirmRemoved(r: CoreRegistry) {
    check(r.spotifyPlaylistId, "core_cleanup_remote_identity_missing");
    const contains = await spotify({
      method: "GET",
      path: "/me/library/contains",
      query: { uris: `spotify:playlist:${r.spotifyPlaylistId}` },
    }) as boolean[];
    let offset = 0, absent = true;
    do {
      const page = await spotify({
        method: "GET",
        path: "/me/playlists",
        query: { limit: 50, offset },
      }) as SpotifyPage<SpotifyPlaylist>;
      absent &&= !page.items.some((p) => p.id === r.spotifyPlaylistId);
      if (page.nextOffset === null) break;
      check(
        page.nextOffset > offset && page.nextOffset <= 100000,
        "core_remote_paging_invalid",
      );
      offset = page.nextOffset;
    } while (true);
    check(
      contains.length === 1 && contains[0] === false && absent,
      "core_cleanup_unconfirmed",
    );
  }
  // These closures are initialized before run's first use via lazy construction below.
  function identity() {
    return getIdentity();
  }
  async function getIdentity() {
    const result = await spotify({ method: "GET", path: "/me" }) as {
      id: string;
      accountId: string;
    };
    check(
      await ownerFingerprint(result.accountId, input.bindingKey) ===
        input.ownerFingerprint,
      "core_immutable_owner_mismatch",
    );
    return result;
  }
  function spotify(request: Parameters<SpotifyClient["request"]>[0]) {
    return remote()(request);
  }
  function remote() {
    // One client/pacing dispatcher per process, initialized lazily for recovery as well.
    if (!requestSpotify) {
      let dispatched = 0;
      const client = new SpotifyClient({
        tokens,
        pacing,
        fetch: (...args) => {
          dispatched++;
          return fetch(...args);
        },
        isManagedPlaylist: async (id) => {
          const r: CoreRegistry = JSON.parse(
            await Deno.readTextFile(input.registryPath),
          );
          validateRegistry(r);
          if (
            r.epoch !== input.epoch ||
            r.ownerFingerprint !== input.ownerFingerprint ||
            r.spotifyPlaylistId !== id || r.phase !== "playlist"
          ) return false;
          const rows = await sql<{ managed: boolean }>(
            `select exists(select 1 from app.playlists p join app.account a on a.epoch=p.epoch where a.singleton and a.state='connected' and p.id='${r.playlistId}' and p.spotify_id='${id}' and p.status='ready' and p.active_operation is null) as managed;`,
          );
          return rows[0]?.managed === true;
        },
      });
      requestSpotify = pacedRequests(client, () => dispatched);
    }
    return requestSpotify;
  }
}
if (import.meta.main) {
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
    const input = JSON.parse(
      chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
    );
    console.log(JSON.stringify({ passed: true, ...await runCoreProof(input) }));
  } catch (error) {
    const blocker = error instanceof ProofFailure
      ? error.message
      : error instanceof SpotifyError
      ? `spotify_${error.kind}`
      : "core_live_proof_failed";
    console.log(JSON.stringify({ passed: false, blocker }));
    Deno.exitCode = 1;
  }
}
