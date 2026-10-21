import {
  parseId,
  parseLibraryRevision,
  parseRevision,
  parseTrackKey,
  parseQuery,
  parseRetention,
  parseSelection,
  type LibraryStatusDTO,
  type LibrarySearchResponse,
  type TagDTO,
  type TrackDTO,
  type QueryPreviewResponse,
  type ManagedPlaylistDTO,
  type PlaylistListResponse,
  type TagActionResponse,
  type UndoTagActionResponse,
  type PlaylistMutationResponse,
  type WorkBlock,
} from "../../supabase/functions/_shared/contracts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(code);
  }
}
const messages: Record<string, string> = {
  playback_target_unavailable:
    "Spotify could not find this song or browser player. Try again or open Spotify.",
  playback_unconfirmed:
    "Spotify did not confirm whether playback started. Check Spotify before trying again.",
  playback_service_error:
    "Spotify reported a playback service error. Check Spotify before trying again.",
  playback_control_unavailable:
    "The app could not prepare playback safely. Try again later or open Spotify.",
  playback_required: "Enable playback to listen here.",
  track_unavailable: "This song is unavailable for playback.",
  playback_cooldown: "Spotify is busy. Wait before trying playback again.",
  stale_revision: "Your library changed. Refresh the results and try again.",
  unknown_tag: "A tag in this query no longer exists. Update your selection.",
  initial_sync_incomplete:
    "Your first import is still being verified. You can keep tagging while it finishes.",
  no_playable_matches: "No playable songs match this query.",
  reconnect: "Reconnect Spotify to resume this work.",
  unauthorized: "Your session expired. Reconnect Spotify to continue.",
  request_conflict:
    "This request ID belongs to a different saved action. Refresh to recover the recorded action.",
  playlist_busy:
    "This playlist is already being updated. Wait for confirmation, then try again.",
  unknown_playlist:
    "This playlist is no longer managed here. Refresh the list.",
  invalid_action:
    "This action is not available for the playlist’s current state.",
  invalid_input: "Check the entered values and try again.",
};
export function errorMessage(error: unknown) {
  return (
    (error instanceof ApiError && messages[error.code]) ||
    "This request could not be confirmed. Check your connection and try again."
  );
}
export async function api<T>(
  path: string,
  parse: (value: unknown) => T,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: signal ?? AbortSignal.timeout(20000),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const code =
      value && typeof value === "object" && "error" in value
        ? value.error
        : null;
    throw new ApiError(
      typeof code === "string" && Object.hasOwn(messages, code)
        ? code
        : "unavailable",
      response.status,
    );
  }
  return parse(value);
}
function fail(): never {
  throw new ApiError("invalid_response");
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
}
function str(value: unknown): string {
  return typeof value === "string" && value.length <= 10000 ? value : fail();
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail();
}
function bool(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail();
}
function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function rows<T>(value: unknown, parse: (v: unknown) => T, limit = 100): T[] {
  return Array.isArray(value) && value.length <= limit
    ? value.map(parse)
    : fail();
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === "string" && choices.includes(value as T)
    ? (value as T)
    : fail();
}
function time(value: unknown): string {
  const text = str(value);
  return Number.isFinite(Date.parse(text)) ? text : fail();
}
function cursor(value: unknown) {
  return nullable(value, (v) =>
    /^[A-Za-z0-9_-]{16,512}$/.test(str(v)) ? str(v) : fail(),
  );
}
function block(value: unknown): WorkBlock | null {
  return nullable(value, (v) =>
    choice(v, ["reconnect", "rateLimited", "quota", "unavailable"]),
  );
}
function spotifyLink(value: unknown): string | null {
  return nullable(value, (v) =>
    /^https:\/\/open\.spotify\.com\/(track|playlist)\/[A-Za-z0-9]+$/.test(
      str(v),
    )
      ? str(v)
      : fail(),
  );
}
export function track(value: unknown): TrackDTO {
  const v = obj(value),
    m = v.metadata === null ? null : obj(v.metadata);
  return {
    trackKey: parseTrackKey(v.trackKey),
    tagIds: rows(v.tagIds, parseId, 10000),
    metadata: m && {
      title: str(m.title),
      artists: rows(m.artists, (v) => {
        const a = obj(v);
        return { id: nullable(a.id, str), name: str(a.name) };
      }),
      album: str(m.album),
      releaseDate: nullable(m.releaseDate, str),
      durationMs: nullable(m.durationMs, count),
      explicit: nullable(m.explicit, bool),
      artworkUrl: nullable(m.artworkUrl, (v) =>
        /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(str(v))
          ? str(v)
          : fail(),
      ),
      spotifyUrl: spotifyLink(m.spotifyUrl),
      playableUri: nullable(m.playableUri, (v) =>
        /^spotify:track:[A-Za-z0-9]{22}$/.test(str(v)) ? str(v) : fail(),
      ),
      likedAt: time(m.likedAt),
      removedAt: nullable(m.removedAt, time),
      acknowledgedAt: nullable(m.acknowledgedAt, time),
    },
  };
}
export function tag(value: unknown): TagDTO {
  const v = obj(value);
  return {
    id: parseId(v.id),
    name: str(v.name),
    activeTrackCount: count(v.activeTrackCount),
    lastUsedAt: nullable(v.lastUsedAt, time),
  };
}
export function tags(value: unknown) {
  const v = obj(value);
  return {
    tags: rows(v.tags, tag),
    hasMore: bool(v.hasMore),
    revision: parseLibraryRevision(v.revision),
  };
}
export function createdTag(value: unknown) {
  const v = obj(value);
  return {
    tag: tag(v.tag),
    created: bool(v.created),
    revision: parseLibraryRevision(v.revision),
  };
}
export function libraryStatus(value: unknown): LibraryStatusDTO {
  const v = obj(value);
  return {
    revision: parseLibraryRevision(v.revision),
    initialSyncComplete: bool(v.initialSyncComplete),
    syncPhase: choice(v.syncPhase, ["idle", "importing", "verifying"]),
    importedCount: count(v.importedCount),
    reportedTotal: nullable(v.reportedTotal, count),
    activeCount: count(v.activeCount),
    untaggedCount: count(v.untaggedCount),
    newCount: count(v.newCount),
    lastCompletedAt: nullable(v.lastCompletedAt, time),
    blockedBy: block(v.blockedBy),
  };
}
export function librarySearch(value: unknown): LibrarySearchResponse {
  const v = obj(value),
    base = {
      revision: parseLibraryRevision(v.revision),
      artworkPending:
        v.artworkPending === undefined ? false : bool(v.artworkPending),
      totalTracks: count(v.totalTracks),
      nextCursor: cursor(v.nextCursor),
    };
  if (v.groupBy === null)
    return { ...base, groupBy: null, tracks: rows(v.tracks, track) };
  if (v.groupBy !== "artist") fail();
  return {
    ...base,
    groupBy: "artist",
    totalGroups: count(v.totalGroups),
    groups: rows(v.groups, (value) => {
      const g = obj(value),
        selection = parseSelection(g.selection);
      if (selection.kind !== "filter") fail();
      return {
        artistId: str(g.artistId),
        artworkUrl: parseArtworkUrl(g.artworkUrl ?? null),
        name: str(g.name),
        trackCount: count(g.trackCount),
        taggedCount: count(g.taggedCount),
        selection,
      };
    }),
  };
}
export function preview(value: unknown): QueryPreviewResponse {
  const v = obj(value),
    matchedCount = count(v.matchedCount),
    playableCount = count(v.playableCount),
    excludedCount = count(v.excludedCount);
  if (matchedCount !== playableCount + excludedCount) fail();
  return {
    query: parseQuery(v.query),
    revision: parseLibraryRevision(v.revision),
    generationReady: bool(v.generationReady),
    matchedCount,
    playableCount,
    excludedCount,
    durationMs: count(v.durationMs),
    tracks: rows(v.tracks, track),
    nextCursor: cursor(v.nextCursor),
  };
}
export function playlist(value: unknown): ManagedPlaylistDTO {
  const v = obj(value);
  return {
    id: parseId(v.id),
    revision: parseRevision(v.revision),
    name: str(v.name),
    spotifyUrl: spotifyLink(v.spotifyUrl),
    artworkUrl: parseArtworkUrl(v.artworkUrl ?? null),
    query: parseQuery(v.query),
    retention: parseRetention(v.retention),
    createdAt: time(v.createdAt),
    expiresOn: nullable(v.expiresOn, (v) =>
      /^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : fail(),
    ),
    trackCount: count(v.trackCount),
    status: choice(v.status, ["pending", "ready", "incomplete", "removing"]),
    blockedBy: block(v.blockedBy),
  };
}
export function playlists(value: unknown): PlaylistListResponse {
  const v = obj(value);
  return {
    playlists: rows(v.playlists, playlist),
    nextCursor: cursor(v.nextCursor),
    lastCleanupAt: nullable(v.lastCleanupAt, time),
    cleanupBlockedBy: block(v.cleanupBlockedBy),
  };
}
export function playlistMutation(value: unknown): PlaylistMutationResponse {
  const v = obj(value);
  return { requestId: parseId(v.requestId), playlist: playlist(v.playlist) };
}
export function tagAction(value: unknown): TagActionResponse {
  const v = obj(value);
  return {
    actionId: parseId(v.actionId),
    tag: tag(v.tag),
    changedCount: count(v.changedCount),
    selectedCount: count(v.selectedCount),
    revision: parseLibraryRevision(v.revision),
  };
}
export function undoAction(value: unknown): UndoTagActionResponse {
  const v = obj(value);
  return {
    actionId: parseId(v.actionId),
    restoredCount: count(v.restoredCount),
    skippedCount: count(v.skippedCount),
    revision: parseLibraryRevision(v.revision),
  };
}
export const blockMessage: Record<WorkBlock, string> = {
  reconnect: "Reconnect Spotify to resume.",
  rateLimited: "Spotify asked us to wait. Work will retry automatically.",
  quota:
    "Spotify’s quota is exhausted. Work is saved until the quota recovers.",
  unavailable:
    "The service is unavailable. Saved work will resume after recovery.",
};

/** Resolve known IDs, never enumerate or guess vocabulary names. */
export async function lookupTags(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<TagDTO[]> {
  const unique = [...new Set(ids.map(parseId))];
  const result: TagDTO[] = [];
  for (let start = 0; start < unique.length; start += 200) {
    const batch = unique.slice(start, start + 200);
    const response = await api(
      "/tags/lookup",
      (value) => {
        const v = obj(value);
        const resolved = rows(v.tags, tag, 200);
        parseLibraryRevision(v.revision);
        if (
          resolved.length !== batch.length ||
          resolved.some((item, index) => item.id !== batch[index])
        )
          fail();
        return resolved;
      },
      { tagIds: batch },
      signal,
    );
    result.push(...response);
  }
  return result;
}

// Auth/origin failures occur before replay lookup and cannot resolve an earlier
// accepted-but-lost response. Only transactional validation rejections do so.
export function rejectsIntent(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    [
      "stale_revision",
      "unknown_tag",
      "initial_sync_incomplete",
      "no_playable_matches",
      "playlist_busy",
      "unknown_playlist",
      "invalid_action",
    ].includes(error.code)
  );
}

export function parseArtworkUrl(value: unknown): string | null {
  if (value === null) return null;
  const raw = str(value);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  if (
    raw.length > 4096 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  )
    return fail();
  return url.href;
}
