import { retryAfter } from "./retry-after.ts";

// Current contracts: docs/SPOTIFY-API.md (primary references checked 2026-10-11).
// No response bodies, tokens, URLs, names, or upstream exception causes enter errors.
export const SPOTIFY_SCOPES = Object.freeze(
  [
    "user-library-read",
    "playlist-read-private",
    "playlist-modify-private",
    "playlist-modify-public",
    "user-library-modify",
  ] as const,
);

const API = "https://api.spotify.com/v1";
const ID = /^[A-Za-z0-9]{22}$/;
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
const PLAYLIST_URI = /^spotify:playlist:([A-Za-z0-9]{22})$/;
const SPACING_MS = 500;
const QUOTA_BACKOFF_MS = 6 * 60 * 60 * 1000;

export type SpotifyErrorKind =
  | "guard"
  | "authentication"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "quota"
  | "cooldown"
  | "control_unavailable"
  | "network"
  | "response"
  | "http";

export class SpotifyError extends Error {
  constructor(
    readonly kind: SpotifyErrorKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly ambiguous = false,
  ) {
    super(`Spotify request failed (${kind})`);
    this.name = "SpotifyError";
  }
}

export interface SpotifyDependencies {
  tokens: {
    // Throw SpotifyError to classify reconnect vs transient failures. Unknown
    // exceptions become control_unavailable and never expose their messages.
    getAccessToken(): Promise<string>;
    // Caller serializes refresh and persists rotations. If another request already
    // replaced rejectedToken, return the new token instead of refreshing again.
    refreshAccessToken(rejectedToken: string): Promise<string>;
  };
  pacing: {
    // Atomically grant a slot only when the shared DB spacing AND cooldown allow
    // it. Do not reserve a future slot on denial. Every web/worker caller shares
    // this gate; the adapter never silently falls back to an in-memory limiter.
    acquire(minimumIntervalMs: number): Promise<{
      granted: boolean;
      retryAfterMs: number;
    }>;
    // Atomically extend (never shorten) the shared cooldown from database time.
    defer(
      input: { retryAfterMs: number; kind: "rate_limit" | "quota" },
    ): Promise<void>;
  };
  // Consult durable, current-account managed ownership, never a client claim.
  // Caller also serializes playlist lifecycle work and checks the account epoch.
  isManagedPlaylist(id: string): Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface SpotifyPage<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface SpotifyTrack {
  id: string | null;
  uri: string | null;
  name: string;
  artists: { id: string | null; name: string }[];
  album: {
    id: string | null;
    name: string;
    releaseDate: string;
    images: { url: string; width: number | null; height: number | null }[];
  };
  durationMs: number;
  explicit: boolean;
  isLocal: boolean;
  isPlayable: boolean;
}

export interface SpotifySavedTrack {
  addedAt: string;
  track: SpotifyTrack | null;
}

export interface SpotifyPlaylistItem {
  addedAt: string | null;
  // Null/unavailable/local/episode entries retain their position. Never filter
  // these out when comparing the remote sequence with a frozen write target.
  uri: string | null;
  isLocal: boolean;
  type: "track" | "episode" | "unavailable";
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  // Canonical text: one Spotify response escape layer removed, never HTML.
  description: string | null;
  public: boolean | null;
  collaborative: boolean;
  ownerId: string;
  snapshotId: string;
  total: number;
}

export interface SpotifyRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  // Canonical relative path only. Query is separate; no caller-provided URLs.
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
}

type Operation =
  | "identity"
  | "saved"
  | "playlists"
  | "playlist"
  | "items"
  | "create"
  | "replace"
  | "append"
  | "description"
  | "contains"
  | "remove";
type Result =
  | { accountId: string; id: string }
  | SpotifyPage<SpotifySavedTrack>
  | SpotifyPage<SpotifyPlaylist>
  | SpotifyPage<SpotifyPlaylistItem>
  | SpotifyPlaylist
  | { snapshotId: string }
  | boolean[]
  | void;
interface Prepared {
  operation: Operation;
  method: SpotifyRequest["method"];
  url: string;
  body?: string;
  managedIds: string[];
  uriCount: number;
  offset: number;
  limit: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const validId = (value: unknown): value is string =>
  text(value) && ID.test(value);
function requireGuard(ok: unknown): asserts ok {
  if (!ok) throw new SpotifyError("guard");
}
function requireSchema(ok: unknown): asserts ok {
  if (!ok) throw new SpotifyError("response");
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  requireGuard(Object.keys(value).every((key) => allowed.includes(key)));
}

// Build a detached serialized request before the first await, so mutation of a
// caller's array/body while ownership is checked cannot bypass the boundary.
function prepare(input: SpotifyRequest): Prepared {
  try {
    input = structuredClone(input);
  } catch {
    throw new SpotifyError("guard");
  }
  requireGuard(record(input));
  keys(input as unknown as Record<string, unknown>, [
    "method",
    "path",
    "query",
    "body",
  ]);
  const { method, path } = input;
  requireGuard(["GET", "POST", "PUT", "DELETE"].includes(method));
  requireGuard(text(path) && /^\/[A-Za-z0-9/]+$/.test(path));
  const query = input.query ?? {};
  requireGuard(record(query));
  const params = new URLSearchParams();
  const body = input.body;
  let operation: Operation;
  let managedIds: string[] = [];
  let uriCount = 0;
  let offset = 0;
  let limit = 50;
  let serialized: string | undefined;
  const match = /^\/playlists\/([A-Za-z0-9]{22})(\/items)?$/.exec(path);

  if (method === "GET") {
    requireGuard(body === undefined);
    if (path === "/me") operation = "identity";
    else if (path === "/me/tracks") operation = "saved";
    else if (path === "/me/playlists") operation = "playlists";
    else if (path === "/me/library/contains") operation = "contains";
    else if (match) operation = match[2] ? "items" : "playlist";
    else throw new SpotifyError("guard");
    if (["saved", "playlists", "items"].includes(operation)) {
      keys(query, ["offset", "limit"]);
      const requestedOffset = query.offset ?? 0;
      const requestedLimit = query.limit ?? 50;
      requireGuard(
        integer(requestedOffset) && integer(requestedLimit) &&
          requestedLimit >= 1 && requestedLimit <= 50,
      );
      offset = requestedOffset;
      limit = requestedLimit;
      requireGuard(operation !== "playlists" || offset <= 100_000);
      params.set("offset", String(offset));
      params.set("limit", String(limit));
    } else if (operation !== "contains") keys(query, []);
  } else if (method === "POST" && path === "/me/playlists") {
    operation = "create";
    keys(query, []);
    requireGuard(record(body));
    keys(body, ["name", "description", "public", "collaborative"]);
    requireGuard(text(body.name) && body.name.trim().length > 0);
    requireGuard(
      text(body.description) && body.public === false &&
        body.collaborative === false,
    );
    serialized = JSON.stringify({
      name: body.name,
      description: body.description,
      public: false,
      collaborative: false,
    });
  } else if (match && (method === "POST" || method === "PUT")) {
    keys(query, []);
    requireGuard(record(body));
    managedIds = [match[1]];
    if (match[2]) {
      operation = method === "POST" ? "append" : "replace";
      keys(body, ["uris"]);
      requireGuard(Array.isArray(body.uris) && body.uris.length <= 100);
      requireGuard(operation === "replace" || body.uris.length > 0);
      requireGuard(
        Array.from(body.uris).every((uri) => text(uri) && TRACK_URI.test(uri)),
      );
      serialized = JSON.stringify({ uris: [...body.uris] });
    } else {
      requireGuard(method === "PUT");
      operation = "description";
      keys(body, ["description"]);
      const describing = Object.hasOwn(body, "description");
      requireGuard(!describing || text(body.description));
      // Callers can only supply description text. Always retain the app's
      // unpublished/noncollaborative policy on the provider metadata write.
      serialized = JSON.stringify({
        ...(describing ? { description: body.description } : {}),
        public: false,
        collaborative: false,
      });
    }
  } else if (method === "DELETE" && path === "/me/library") {
    operation = "remove";
    requireGuard(body === undefined);
  } else throw new SpotifyError("guard");

  if (operation === "contains" || operation === "remove") {
    keys(query, ["uris"]);
    requireGuard(text(query.uris));
    const uris = query.uris.split(",");
    requireGuard(uris.length >= 1 && uris.length <= 40);
    requireGuard(uris.every((uri) => PLAYLIST_URI.test(uri)));
    uriCount = uris.length;
    if (operation === "remove") {
      managedIds = [...new Set(uris.map((uri) => uri.slice(17)))];
    }
    params.set("uris", uris.join(","));
  }
  const search = params.toString();
  return {
    operation,
    method,
    url: API + path + (search ? `?${search}` : ""),
    body: serialized,
    managedIds,
    uriCount,
    offset,
    limit,
  };
}

export class SpotifyClient {
  readonly #dependencies: SpotifyDependencies;
  readonly #timeoutMs: number;

  constructor(dependencies: SpotifyDependencies) {
    this.#dependencies = dependencies;
    this.#timeoutMs = dependencies.timeoutMs ?? 15_000;
    requireGuard(
      integer(this.#timeoutMs) && this.#timeoutMs > 0 &&
        this.#timeoutMs <= 30_000,
    );
  }

  // This narrow escape hatch is guarded at runtime too, including calls from JS
  // or untyped job payloads. It returns only the normalized product data below.
  async request(input: SpotifyRequest): Promise<Result> {
    const request = prepare(input);
    for (const id of request.managedIds) {
      let managed: boolean;
      try {
        managed = await this.#dependencies.isManagedPlaylist(id);
      } catch {
        throw new SpotifyError("control_unavailable");
      }
      requireGuard(managed === true);
    }
    let token = await this.#token();
    // Only the read-only unauthorized response is retried, at most once. POST
    // create/append are never replayed, including after timeouts or bad JSON.
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.#acquire();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response | undefined;
      const write = request.method !== "GET";
      try {
        response = await (this.#dependencies.fetch ?? fetch)(request.url, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(request.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: request.body,
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status === 401 && !write && attempt === 0) {
          await response.body?.cancel();
          // Clear the fetch timer before waiting for serialized token refresh.
          clearTimeout(timeout);
          token = await this.#token(token);
          continue;
        }
        if (response.status === 429) {
          let quota = false;
          try {
            const data: unknown = await response.json();
            quota = record(data) && record(data.error) &&
              data.error.reason === "QUOTA_EXCEEDED";
          } catch { /* Unreadable bodies still require backoff. */ }
          const kind = quota ? "quota" : "rate_limit";
          const delay = Math.max(
            quota ? QUOTA_BACKOFF_MS : 1_000,
            retryAfter(
              response.headers.get("Retry-After"),
              (this.#dependencies.now ?? Date.now)(),
            ) ?? 30_000,
          );
          try {
            await this.#dependencies.pacing.defer({
              retryAfterMs: delay,
              kind,
            });
          } catch {
            throw new SpotifyError("control_unavailable", 429, delay);
          }
          throw new SpotifyError(kind, 429, delay);
        }
        if (!response.ok) {
          await response.body?.cancel();
          const kind = response.status === 401
            ? "authentication"
            : response.status === 403
            ? "forbidden"
            : response.status === 404
            ? "not_found"
            : "http";
          throw new SpotifyError(
            kind,
            response.status,
            null,
            write &&
              (response.status >= 500 || response.status === 408 ||
                response.status < 400),
          );
        }
        const empty = request.operation === "description" ||
          request.operation === "remove";
        const status =
          request.operation === "create" || request.operation === "append"
            ? 201
            : 200;
        requireSchema(
          response.status === status || (empty && response.status === 204),
        );
        if (empty) {
          await response.body?.cancel();
          return;
        }
        const data: unknown = await response.json();
        return normalize(data, request);
      } catch (error) {
        if (error instanceof SpotifyError) {
          // A successful write with an invalid/truncated response is ambiguous,
          // even if its JSON was syntactically valid but failed schema checks.
          if (error.kind === "response") {
            throw new SpotifyError(
              "response",
              response?.status ?? null,
              null,
              write,
            );
          }
          throw error;
        }
        throw new SpotifyError(
          response?.ok ? "response" : "network",
          response?.status ?? null,
          null,
          write,
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new SpotifyError("authentication", 401);
  }

  async #token(rejectedToken?: string): Promise<string> {
    try {
      const token = rejectedToken === undefined
        ? await this.#dependencies.tokens.getAccessToken()
        : await this.#dependencies.tokens.refreshAccessToken(rejectedToken);
      if (!text(token) || !token || /\s/.test(token)) {
        throw new SpotifyError("authentication");
      }
      return token;
    } catch (error) {
      if (error instanceof SpotifyError) {
        throw new SpotifyError(error.kind, error.status, error.retryAfterMs);
      }
      throw new SpotifyError("control_unavailable");
    }
  }

  async #acquire() {
    let permit;
    try {
      permit = await this.#dependencies.pacing.acquire(SPACING_MS);
    } catch {
      throw new SpotifyError("control_unavailable");
    }
    if (
      !record(permit) || typeof permit.granted !== "boolean" ||
      !integer(permit.retryAfterMs)
    ) {
      throw new SpotifyError("control_unavailable");
    }
    if (!permit.granted) {
      throw new SpotifyError(
        "cooldown",
        null,
        Math.max(SPACING_MS, permit.retryAfterMs),
      );
    }
    if (permit.retryAfterMs !== 0) {
      throw new SpotifyError("control_unavailable");
    }
  }

  getCurrentUser() {
    return this.request({ method: "GET", path: "/me" }) as Promise<
      { accountId: string; id: string }
    >;
  }
  getSavedTracksPage(query: { offset?: number; limit?: number } = {}) {
    return this.request({
      method: "GET",
      path: "/me/tracks",
      query,
    }) as Promise<SpotifyPage<SpotifySavedTrack>>;
  }
  getCurrentUserPlaylistsPage(query: { offset?: number; limit?: number } = {}) {
    return this.request({
      method: "GET",
      path: "/me/playlists",
      query,
    }) as Promise<SpotifyPage<SpotifyPlaylist>>;
  }
  getPlaylist(id: string) {
    return this.request({ method: "GET", path: `/playlists/${id}` }) as Promise<
      SpotifyPlaylist
    >;
  }
  getPlaylistItemsPage(
    id: string,
    query: { offset?: number; limit?: number } = {},
  ) {
    return this.request({
      method: "GET",
      path: `/playlists/${id}/items`,
      query,
    }) as Promise<SpotifyPage<SpotifyPlaylistItem>>;
  }
  createPrivatePlaylist(input: { name: string; description: string }) {
    return this.request({
      method: "POST",
      path: "/me/playlists",
      body: {
        name: input.name,
        description: input.description,
        public: false,
        collaborative: false,
      },
    }) as Promise<SpotifyPlaylist>;
  }
  replacePlaylistItems(id: string, uris: readonly string[]) {
    return this.request({
      method: "PUT",
      path: `/playlists/${id}/items`,
      body: { uris },
    }) as Promise<{ snapshotId: string }>;
  }
  appendPlaylistItems(id: string, uris: readonly string[]) {
    return this.request({
      method: "POST",
      path: `/playlists/${id}/items`,
      body: { uris },
    }) as Promise<{ snapshotId: string }>;
  }
  updatePlaylistDescription(id: string, description: string) {
    return this.request({
      method: "PUT",
      path: `/playlists/${id}`,
      body: { description },
    }) as Promise<void>;
  }
  ensurePlaylistUnpublished(id: string) {
    // Publication-only command: omit description so even null text survives.
    // prepare() adds only fixed false fields after managed ownership checks.
    return this.request({
      method: "PUT",
      path: `/playlists/${id}`,
      body: {},
    }) as Promise<void>;
  }
  containsPlaylists(ids: readonly string[]) {
    requireGuard(Array.isArray(ids) && ids.every(validId));
    return this.request({
      method: "GET",
      path: "/me/library/contains",
      query: { uris: ids.map((id) => `spotify:playlist:${id}`).join(",") },
    }) as Promise<boolean[]>;
  }
  removeManagedPlaylists(ids: readonly string[]) {
    requireGuard(Array.isArray(ids) && ids.every(validId));
    return this.request({
      method: "DELETE",
      path: "/me/library",
      query: { uris: ids.map((id) => `spotify:playlist:${id}`).join(",") },
    }) as Promise<void>;
  }
}

function normalize(data: unknown, request: Prepared): Result {
  if (request.operation === "contains") {
    requireSchema(
      Array.isArray(data) && data.length === request.uriCount &&
        data.every((v) => typeof v === "boolean"),
    );
    return data;
  }
  requireSchema(record(data));
  if (request.operation === "identity") {
    requireSchema(
      text(data.account_id) && data.account_id.length > 0 && text(data.id) &&
        data.id.length > 0,
    );
    return { accountId: data.account_id, id: data.id };
  }
  if (request.operation === "create" || request.operation === "playlist") {
    const playlist = normalizePlaylist(data);
    if (request.operation === "create") {
      requireSchema(
        playlist.public === false && playlist.collaborative === false,
      );
    }
    return playlist;
  }
  if (request.operation === "replace" || request.operation === "append") {
    requireSchema(text(data.snapshot_id) && data.snapshot_id.length > 0);
    return { snapshotId: data.snapshot_id };
  }
  requireSchema(
    Array.isArray(data.items) && integer(data.total) && integer(data.offset) &&
      integer(data.limit),
  );
  // Live newly-created playlists can return limit:0 despite a positive request.
  // Accept only the observed empty first/terminal items page, never a library
  // page or a nonempty/out-of-range response. Preserve the returned limit.
  const emptyPlaylistPage = request.operation === "items" &&
    data.limit === 0 && data.total === 0 && data.offset === 0 &&
    data.items.length === 0 && data.next === null;
  requireSchema(
    data.offset === request.offset &&
      (data.limit === request.limit || emptyPlaylistPage) &&
      data.items.length <= data.limit,
  );
  requireSchema(data.next === null || text(data.next));
  // Do not follow an upstream URL with our credentials. Derive and validate the
  // next offset while requiring next to remain on this same endpoint.
  let nextOffset: number | null = null;
  if (data.next !== null) {
    const next = new URL(data.next);
    const current = new URL(request.url);
    const offset = next.searchParams.get("offset");
    requireSchema(
      next.origin === current.origin && next.pathname === current.pathname &&
        !next.username && !next.password && !next.hash,
    );
    requireSchema(offset !== null && /^\d+$/.test(offset));
    nextOffset = Number(offset);
    requireSchema(
      integer(nextOffset) && nextOffset === data.offset + data.items.length &&
        nextOffset > data.offset,
    );
  }
  const page = {
    total: data.total,
    offset: data.offset,
    limit: data.limit,
    nextOffset,
  };
  if (request.operation === "saved") {
    return {
      ...page,
      items: data.items.map((item: unknown) => {
        requireSchema(record(item) && validTimestamp(item.added_at));
        requireSchema(Object.hasOwn(item, "track"));
        return {
          addedAt: item.added_at,
          track: item.track === null ? null : normalizeTrack(item.track),
        };
      }),
    };
  }
  if (request.operation === "playlists") {
    return { ...page, items: data.items.map(normalizePlaylist) };
  }
  return { ...page, items: data.items.map(normalizePlaylistItem) };
}

// Spotify can HTML-escape playlist descriptions in responses, including the
// slash in our closing marker. Decode exactly once at the transport boundary:
// an owner's literal "&amp;" arrives as "&amp;amp;" and must stay "&amp;".
// This is text normalization, not HTML rendering or recursive entity expansion.
function decodePlaylistDescription(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(
    /&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|amp|lt|gt|quot|apos);/g,
    (reference, entity: string) => {
      if (!entity.startsWith("#")) return named[entity];
      const hex = entity[1].toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Leave malformed/non-scalar references intact rather than losing notes.
      if (
        code === 0 || code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) return reference;
      return String.fromCodePoint(code);
    },
  );
}

function normalizePlaylist(value: unknown): SpotifyPlaylist {
  requireSchema(record(value) && validId(value.id) && text(value.name));
  requireSchema(value.description === null || text(value.description));
  requireSchema(value.public === null || typeof value.public === "boolean");
  requireSchema(
    typeof value.collaborative === "boolean" && record(value.owner) &&
      text(value.owner.id),
  );
  requireSchema(text(value.snapshot_id) && value.snapshot_id.length > 0);
  // Current `items` takes precedence, including null/malformed values; do not
  // mask a changed current contract with a stale deprecated `tracks` field.
  const collection = Object.hasOwn(value, "items") ? value.items : value.tracks;
  requireSchema(record(collection) && integer(collection.total));
  return {
    id: value.id,
    name: value.name,
    description: value.description === null
      ? null
      : decodePlaylistDescription(value.description),
    public: value.public,
    collaborative: value.collaborative,
    ownerId: value.owner.id,
    snapshotId: value.snapshot_id,
    total: collection.total,
  };
}

function normalizePlaylistItem(value: unknown): SpotifyPlaylistItem {
  requireSchema(record(value));
  requireSchema(value.added_at === null || validTimestamp(value.added_at));
  requireSchema(typeof value.is_local === "boolean");
  requireSchema(Object.hasOwn(value, "item") || Object.hasOwn(value, "track"));
  const item = Object.hasOwn(value, "item") ? value.item : value.track;
  if (item === null) {
    return {
      addedAt: value.added_at,
      uri: null,
      isLocal: value.is_local,
      type: "unavailable",
    };
  }
  requireSchema(record(item) && text(item.type));
  const type = item.type === "track" || item.type === "episode"
    ? item.type
    : "unavailable";
  const isLocal = value.is_local || item.is_local === true;
  const uri = !isLocal && type !== "unavailable" && text(item.uri) &&
      new RegExp(`^spotify:${type}:[A-Za-z0-9]{22}$`).test(item.uri)
    ? item.uri
    : null;
  return { addedAt: value.added_at, uri, isLocal, type };
}

function validTimestamp(value: unknown): value is string {
  return text(value) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function normalizeTrack(value: unknown): SpotifyTrack {
  requireSchema(record(value));
  requireSchema(value.type === "track");
  requireSchema(
    value.is_playable === undefined || typeof value.is_playable === "boolean",
  );
  requireSchema(value.id === null || validId(value.id));
  requireSchema(
    text(value.name) && Array.isArray(value.artists) && record(value.album),
  );
  requireSchema(
    integer(value.duration_ms) && typeof value.explicit === "boolean" &&
      typeof value.is_local === "boolean",
  );
  requireSchema(
    text(value.album.name) && text(value.album.release_date) &&
      Array.isArray(value.album.images),
  );
  requireSchema(value.album.id === null || validId(value.album.id));
  const uri = !value.is_local && text(value.uri) && TRACK_URI.test(value.uri)
    ? value.uri
    : null;
  return {
    id: value.id,
    uri,
    name: value.name,
    artists: value.artists.map((artist: unknown) => {
      requireSchema(
        record(artist) && (artist.id === null || validId(artist.id)) &&
          text(artist.name),
      );
      return { id: artist.id, name: artist.name };
    }),
    album: {
      id: value.album.id,
      name: value.album.name,
      releaseDate: value.album.release_date,
      images: value.album.images.map((image: unknown) => {
        requireSchema(record(image) && text(image.url));
        requireSchema(
          (image.width === null || integer(image.width)) &&
            (image.height === null || integer(image.height)),
        );
        const url = new URL(image.url);
        requireSchema(
          url.protocol === "https:" && !url.username && !url.password,
        );
        return { url: url.href, width: image.width, height: image.height };
      }),
    },
    durationMs: value.duration_ms,
    explicit: value.explicit,
    isLocal: value.is_local,
    isPlayable: uri !== null && value.is_playable !== false &&
      !record(value.restrictions),
  };
}
