// Browser-safe product contracts. No runtime configuration, provider calls or DB imports.
// Parsers validate syntax only; see docs/CORE-CONTRACTS.md for transaction obligations.
export const CONTRACT_LIMITS = {
  queryDepth: 12,
  queryNodes: 128,
  builderTags: 64,
  selectedTracks: 200,
  lookupTags: 200,
  pageSize: 100,
  cursorLength: 512,
  searchLength: 200,
  tagNameLength: 80,
  playlistNameLength: 100,
} as const;

export class ContractError extends Error {
  constructor(readonly field: string) {
    // Never include a supplied value, query, tag name or provider response.
    super(`invalid_input:${field}`);
    this.name = "ContractError";
  }
}

export type TagId = string;
export type TrackKey = string;
export type Revision = string;
export type Retention = "week" | "month" | "threeMonths" | "pinned";
export type ExpiringRetention = Exclude<Retention, "pinned">;
export const DEFAULT_RETENTION: Retention = "month";

export type QueryNode =
  | { readonly op: "tag"; readonly tagId: TagId }
  | { readonly op: "and" | "or"; readonly children: readonly QueryNode[] }
  | { readonly op: "not"; readonly child: QueryNode };
export interface StoredQuery {
  readonly version: 1;
  readonly root: QueryNode;
}
export interface QueryBuilder {
  readonly all: readonly TagId[];
  readonly any: readonly TagId[];
  readonly none: readonly TagId[];
}
export interface LibraryRevision {
  readonly library: Revision;
  readonly annotations: Revision;
}

export interface LibraryFilter {
  readonly membership: "active" | "removed";
  readonly search: string;
  readonly untagged: boolean;
  readonly newOnly: boolean;
  readonly artistId: string | null;
  // Opaque cached-name identity returned by album groups/facets; null is unrestricted.
  readonly album?: string | null;
  readonly decade?: number | "unknown" | null;
  readonly latestSyncOnly?: boolean;
}
export type Selection =
  | { readonly kind: "tracks"; readonly trackKeys: readonly TrackKey[] }
  | {
    readonly kind: "filter";
    readonly filter: LibraryFilter;
    readonly expectedRevision: LibraryRevision;
  };
export interface PageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}
export interface LibrarySearchRequest extends PageRequest {
  readonly filter: LibraryFilter;
  readonly groupBy: "artist" | "album" | "decade" | null;
  readonly sort?: LibrarySort;
  readonly seed?: string | null;
}
export type LibrarySort =
  | "newest"
  | "oldest"
  | "title"
  | "artist"
  | "album"
  | "year"
  | "random";
export interface LibraryGroupDTO {
  readonly artworkUrl: string | null;
  readonly value: string;
  readonly name: string;
  readonly trackCount: number;
  readonly taggedCount: number;
  readonly selection: Extract<Selection, { kind: "filter" }>;
}
export interface LibrarySyncRequest {
  readonly reason: "app-open" | "manual";
}
export interface AcknowledgeRequest {
  readonly trackKeys: readonly TrackKey[];
}
export interface TagSearchRequest {
  readonly search: string;
  readonly limit: number;
}
export interface TagLookupRequest {
  readonly tagIds: readonly TagId[];
}
export interface CreateTagRequest {
  readonly name: string;
}
export type TagActionRequest =
  & { readonly selection: Selection }
  & (
    | { readonly action: "add" | "remove"; readonly tagId: TagId }
    | { readonly action: "add"; readonly tagName: string }
  );
export interface QueryPreviewRequest extends PageRequest {
  readonly query: StoredQuery;
}
export interface CreatePlaylistRequest {
  readonly requestId: string;
  readonly query: StoredQuery;
  readonly previewRevision: LibraryRevision;
  readonly name: string;
  readonly retention: Retention;
}
export type PlaylistActionRequest =
  & {
    readonly requestId: string;
    readonly expectedRevision: Revision;
  }
  & (
    | {
      readonly action: "extend" | "unpin";
      readonly retention: ExpiringRetention;
    }
    | { readonly action: "pin" | "regenerate" | "delete" | "retry" }
  );

// Only the stable annotation identity and assignments survive metadata purge.
export interface TrackAnnotationDTO {
  readonly trackKey: TrackKey;
  readonly tagIds: readonly TagId[];
}
export interface TrackMetadataDTO {
  readonly title: string;
  readonly artists: readonly {
    readonly id: string | null;
    readonly name: string;
  }[];
  readonly album: string;
  readonly releaseDate: string | null;
  readonly durationMs: number | null;
  readonly explicit: boolean | null;
  readonly artworkUrl: string | null;
  readonly spotifyUrl: string | null;
  readonly playableUri: string | null;
  readonly likedAt: string;
  readonly removedAt: string | null;
  readonly acknowledgedAt: string | null;
}
export interface TrackDTO extends TrackAnnotationDTO {
  readonly metadata: TrackMetadataDTO | null;
}
export interface TagDTO {
  readonly id: TagId;
  readonly name: string;
  readonly activeTrackCount: number;
  readonly lastUsedAt: string | null;
}
export type WorkBlock = "reconnect" | "rateLimited" | "quota" | "unavailable";
export interface LibraryStatusDTO {
  readonly sourcesRevision?: string;
  readonly revision: LibraryRevision;
  readonly initialSyncComplete: boolean;
  readonly syncPhase: "idle" | "importing" | "verifying";
  readonly importedCount: number;
  readonly reportedTotal: number | null;
  readonly activeCount: number;
  readonly untaggedCount: number;
  readonly newCount: number;
  readonly lastCompletedAt: string | null;
  readonly blockedBy: WorkBlock | null;
}
export interface ArtistGroupDTO {
  readonly artworkUrl: string | null;
  readonly artistId: string;
  readonly name: string;
  readonly trackCount: number;
  readonly taggedCount: number;
  readonly selection: Extract<Selection, { kind: "filter" }>;
}
export type LibrarySearchResponse =
  & {
    readonly artworkPending: boolean;
    readonly revision: LibraryRevision;
    readonly totalTracks: number;
    readonly nextCursor: string | null;
  }
  & (
    | { readonly groupBy: null; readonly tracks: readonly TrackDTO[] }
    | {
      readonly groupBy: "artist";
      readonly groups: readonly ArtistGroupDTO[];
      readonly totalGroups: number;
    }
    | {
      readonly groupBy: "album" | "decade";
      readonly groups: readonly LibraryGroupDTO[];
      readonly totalGroups: number;
    }
  );
export interface AcknowledgeResponse {
  readonly changedCount: number;
  readonly revision: LibraryRevision;
}
export interface TagSearchResponse {
  readonly tags: readonly TagDTO[];
  readonly hasMore: boolean;
  readonly revision: LibraryRevision;
}
export interface TagLookupResponse {
  readonly tags: readonly TagDTO[];
  readonly revision: LibraryRevision;
}
export interface CreateTagResponse {
  readonly tag: TagDTO;
  readonly created: boolean;
  readonly revision: LibraryRevision;
}
export interface TagActionResponse {
  readonly tag: TagDTO;
  readonly actionId: string;
  readonly selectedCount: number;
  readonly changedCount: number;
  readonly revision: LibraryRevision;
}
export interface UndoTagActionResponse {
  readonly actionId: string;
  readonly restoredCount: number;
  readonly skippedCount: number;
  readonly revision: LibraryRevision;
}
export interface QueryPreviewResponse {
  readonly query: StoredQuery;
  readonly revision: LibraryRevision;
  readonly generationReady: boolean;
  readonly matchedCount: number;
  readonly playableCount: number;
  readonly excludedCount: number;
  readonly durationMs: number;
  readonly tracks: readonly TrackDTO[];
  readonly nextCursor: string | null;
}
export interface ManagedPlaylistDTO {
  readonly artworkUrl: string | null;
  readonly id: string;
  readonly revision: Revision;
  readonly name: string;
  readonly spotifyUrl: string | null;
  readonly query: StoredQuery;
  readonly retention: Retention;
  readonly createdAt: string;
  readonly expiresOn: string | null;
  readonly trackCount: number;
  // Ready verifies content/disclosure plus an acknowledged publication command;
  // it does not independently verify hiding via Spotify's public readback.
  readonly status: "pending" | "ready" | "incomplete" | "removing";
  readonly blockedBy: WorkBlock | null;
}
export interface PlaylistListResponse {
  readonly playlists: readonly ManagedPlaylistDTO[];
  readonly nextCursor: string | null;
  readonly lastCleanupAt: string | null;
  readonly cleanupBlockedBy: WorkBlock | null;
}
export interface PlaylistMutationResponse {
  readonly requestId: string;
  readonly playlist: ManagedPlaylistDTO;
}

function invalid(field: string): never {
  throw new ContractError(field);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(field);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" || !property.enumerable || !("value" in property)
    ) {
      invalid(field);
    }
  }
  return value as Record<string, unknown>;
}
function fields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) =>
      !required.includes(key) && !optional.includes(key)
    )
  ) invalid(field);
}
function shape(value: unknown, keys: readonly string[], field: string) {
  const object = record(value, field);
  fields(object, keys, [], field);
  return object;
}
function list(value: unknown, maximum: number, field: string): unknown[] {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) invalid(field);
  // JSON arrays are dense data properties, with no custom or symbol properties.
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(field);
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property?.enumerable || !("value" in property)) invalid(field);
  }
  return value;
}
function choice<T extends string>(
  value: unknown,
  options: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    invalid(field);
  }
  return value as T;
}
function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || value.length > maximum * 8) invalid(field);
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (
    [...normalized].length > maximum || /[\p{Cc}\p{Cs}]/u.test(normalized)
  ) invalid(field);
  return normalized;
}
function name(value: unknown, maximum: number, field: string): string {
  const normalized = text(value, maximum, field);
  if (!normalized) invalid(field);
  return normalized;
}
export function parseId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) invalid("id");
  return value.toLowerCase();
}
export function parseTrackKey(value: unknown): TrackKey {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    invalid("trackKey");
  }
  return value;
}
export function parseRevision(value: unknown): Revision {
  if (
    typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    (value.length === 19 && value > "9223372036854775807")
  ) invalid("revision");
  return value;
}
export function parseLibraryRevision(value: unknown): LibraryRevision {
  const object = shape(value, ["library", "annotations"], "revision");
  return {
    library: parseRevision(object.library),
    annotations: parseRevision(object.annotations),
  };
}
export function parseRetention(value: unknown): Retention {
  return choice(value, ["week", "month", "threeMonths", "pinned"], "retention");
}

export function parseQuery(value: unknown): StoredQuery {
  const query = shape(value, ["version", "root"], "query");
  if (query.version !== 1) invalid("query.version");
  let nodes = 0;
  function visit(value: unknown, depth: number): QueryNode {
    if (
      ++nodes > CONTRACT_LIMITS.queryNodes || depth > CONTRACT_LIMITS.queryDepth
    ) {
      invalid("query.complexity");
    }
    const node = record(value, "query.node");
    switch (node.op) {
      case "tag":
        fields(node, ["op", "tagId"], [], "query.tag");
        return { op: "tag", tagId: parseId(node.tagId) };
      case "and":
      case "or": {
        fields(node, ["op", "children"], [], "query.children");
        const children = list(
          node.children,
          CONTRACT_LIMITS.queryNodes,
          "query.children",
        );
        if (!children.length) invalid("query.children");
        return {
          op: node.op,
          children: children.map((child) => visit(child, depth + 1)),
        };
      }
      case "not":
        fields(node, ["op", "child"], [], "query.not");
        return { op: "not", child: visit(node.child, depth + 1) };
      default:
        return invalid("query.op");
    }
  }
  return { version: 1, root: visit(query.root, 1) };
}
export function compileQueryBuilder(value: unknown): StoredQuery {
  const builder = shape(value, ["all", "any", "none"], "builder");
  let count = 0;
  function bucket(value: unknown): QueryNode[] {
    const entries = list(value, CONTRACT_LIMITS.builderTags, "builder.tags");
    count += entries.length;
    if (count > CONTRACT_LIMITS.builderTags) invalid("builder.tags");
    return [...new Set(entries.map(parseId))].map((tagId) => ({
      op: "tag",
      tagId,
    }));
  }
  const all = bucket(builder.all),
    any = bucket(builder.any),
    none = bucket(builder.none);
  const children: QueryNode[] = [...all];
  if (any.length) children.push({ op: "or", children: any });
  if (none.length) {
    children.push({ op: "not", child: { op: "or", children: none } });
  }
  if (!children.length) invalid("builder.empty");
  return parseQuery({ version: 1, root: { op: "and", children } });
}
// Pure truth semantics for validated queries. Does not check tag existence or membership.
export function queryMatchesTags(
  query: StoredQuery,
  tagIds: ReadonlySet<TagId>,
): boolean {
  function matches(node: QueryNode): boolean {
    switch (node.op) {
      case "tag":
        return tagIds.has(node.tagId);
      case "and":
        return node.children.every(matches);
      case "or":
        return node.children.some(matches);
      case "not":
        return !matches(node.child);
    }
  }
  return matches(query.root);
}

export function parseLibraryFilter(value: unknown): LibraryFilter {
  const filter = record(value, "filter");
  fields(
    filter,
    [
      "membership",
      "search",
      "untagged",
      "newOnly",
      "artistId",
    ],
    ["album", "decade", "latestSyncOnly"],
    "filter",
  );
  const membership = choice(
    filter.membership,
    ["active", "removed"],
    "filter.membership",
  );
  if (
    typeof filter.untagged !== "boolean" || typeof filter.newOnly !== "boolean"
  ) {
    invalid("filter.flags");
  }
  if (membership === "removed" && filter.newOnly) invalid("filter.newOnly");
  if (
    filter.artistId !== null &&
    (typeof filter.artistId !== "string" ||
      !/^[A-Za-z0-9]{22}$/.test(filter.artistId))
  ) invalid("filter.artistId");
  if (
    Object.hasOwn(filter, "latestSyncOnly") &&
    typeof filter.latestSyncOnly !== "boolean"
  ) invalid("filter.latestSyncOnly");
  if (membership === "removed" && filter.latestSyncOnly) {
    invalid("filter.latestSyncOnly");
  }
  if (
    Object.hasOwn(filter, "decade") && filter.decade !== null &&
    filter.decade !== "unknown" &&
    (typeof filter.decade !== "number" || !Number.isInteger(filter.decade) ||
      filter.decade < 0 || filter.decade > 9990 || filter.decade % 10 !== 0)
  ) invalid("filter.decade");
  if (
    Object.hasOwn(filter, "album") && filter.album !== null &&
    (typeof filter.album !== "string" ||
      !/^album:[0-9a-f]{64}$/.test(filter.album))
  ) invalid("filter.album");
  return {
    ...(Object.hasOwn(filter, "album")
      ? {
        album: filter.album as string | null,
      }
      : {}),
    ...(Object.hasOwn(filter, "decade")
      ? { decade: filter.decade as number | "unknown" | null }
      : {}),
    ...(Object.hasOwn(filter, "latestSyncOnly")
      ? { latestSyncOnly: filter.latestSyncOnly as boolean }
      : {}),
    membership,
    search: text(filter.search, CONTRACT_LIMITS.searchLength, "filter.search"),
    untagged: filter.untagged,
    newOnly: filter.newOnly,
    artistId: filter.artistId,
  };
}
function trackKeys(value: unknown): TrackKey[] {
  const keys = list(value, CONTRACT_LIMITS.selectedTracks, "trackKeys").map(
    parseTrackKey,
  );
  if (!keys.length || new Set(keys).size !== keys.length) invalid("trackKeys");
  return keys;
}
export function parseSelection(value: unknown): Selection {
  const selection = record(value, "selection");
  if (selection.kind === "tracks") {
    fields(selection, ["kind", "trackKeys"], [], "selection");
    return { kind: "tracks", trackKeys: trackKeys(selection.trackKeys) };
  }
  if (selection.kind === "filter") {
    fields(selection, ["kind", "filter", "expectedRevision"], [], "selection");
    return {
      kind: "filter",
      filter: parseLibraryFilter(selection.filter),
      expectedRevision: parseLibraryRevision(selection.expectedRevision),
    };
  }
  return invalid("selection.kind");
}
function pageSize(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 1 ||
    value > CONTRACT_LIMITS.pageSize
  ) {
    invalid("limit");
  }
  return value;
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,512}$/.test(value)) {
    invalid("cursor");
  }
  return value;
}
export function parsePageRequest(value: unknown): PageRequest {
  const page = shape(value, ["cursor", "limit"], "page");
  return { cursor: cursor(page.cursor), limit: pageSize(page.limit) };
}
export function parseLibrarySearch(value: unknown): LibrarySearchRequest {
  const request = record(value, "librarySearch");
  fields(
    request,
    ["filter", "cursor", "limit", "groupBy"],
    ["sort", "seed"],
    "librarySearch",
  );
  const groupBy = request.groupBy === null
    ? null
    : choice(request.groupBy, ["artist", "album", "decade"], "groupBy");
  const sort = Object.hasOwn(request, "sort")
    ? choice(request.sort, [
      "newest",
      "oldest",
      "title",
      "artist",
      "album",
      "year",
      "random",
    ], "sort")
    : "newest";
  const seed = Object.hasOwn(request, "seed") && request.seed !== null
    ? parseId(request.seed)
    : null;
  if ((sort === "random") !== (seed !== null)) invalid("seed");
  return {
    filter: parseLibraryFilter(request.filter),
    cursor: cursor(request.cursor),
    limit: pageSize(request.limit),
    groupBy,
    ...(Object.hasOwn(request, "sort") ? { sort } : {}),
    ...(Object.hasOwn(request, "seed") ? { seed } : {}),
  };
}
export function parseLibrarySync(value: unknown): LibrarySyncRequest {
  const request = shape(value, ["reason"], "librarySync");
  return { reason: choice(request.reason, ["app-open", "manual"], "reason") };
}
export function parseAcknowledge(value: unknown): AcknowledgeRequest {
  const request = shape(value, ["trackKeys"], "acknowledge");
  return { trackKeys: trackKeys(request.trackKeys) };
}
export function parseTagSearch(value: unknown): TagSearchRequest {
  const request = record(value, "tagSearch");
  fields(request, [], ["search", "limit"], "tagSearch");
  return {
    search: Object.hasOwn(request, "search")
      ? text(request.search, CONTRACT_LIMITS.searchLength, "search")
      : "",
    limit: Object.hasOwn(request, "limit") ? pageSize(request.limit) : 20,
  };
}
export function parseCreateTag(value: unknown): CreateTagRequest {
  const request = shape(value, ["name"], "createTag");
  return { name: name(request.name, CONTRACT_LIMITS.tagNameLength, "name") };
}
export function parseTagLookup(value: unknown): TagLookupRequest {
  const request = shape(value, ["tagIds"], "tagLookup");
  const ids = list(request.tagIds, CONTRACT_LIMITS.lookupTags, "tagIds").map(
    parseId,
  );
  if (!ids.length || new Set(ids).size !== ids.length) invalid("tagIds");
  return { tagIds: ids };
}
export function parseTagAction(value: unknown): TagActionRequest {
  const request = record(value, "tagAction");
  const action = choice(request.action, ["add", "remove"], "action");
  if (action === "add" && Object.hasOwn(request, "tagName")) {
    fields(request, ["selection", "tagName", "action"], [], "tagAction");
    return {
      selection: parseSelection(request.selection),
      tagName: name(request.tagName, CONTRACT_LIMITS.tagNameLength, "tagName"),
      action,
    };
  }
  fields(request, ["selection", "tagId", "action"], [], "tagAction");
  return {
    selection: parseSelection(request.selection),
    tagId: parseId(request.tagId),
    action,
  };
}
export function parseUndoTagAction(value: unknown): Record<string, never> {
  shape(value, [], "undoTagAction");
  return {};
}
export function parseQueryPreview(value: unknown): QueryPreviewRequest {
  const request = shape(value, ["query", "cursor", "limit"], "queryPreview");
  return {
    query: parseQuery(request.query),
    cursor: cursor(request.cursor),
    limit: pageSize(request.limit),
  };
}
export function parseCreatePlaylist(value: unknown): CreatePlaylistRequest {
  const request = shape(value, [
    "requestId",
    "query",
    "previewRevision",
    "name",
    "retention",
  ], "createPlaylist");
  return {
    requestId: parseId(request.requestId),
    query: parseQuery(request.query),
    previewRevision: parseLibraryRevision(request.previewRevision),
    name: name(request.name, CONTRACT_LIMITS.playlistNameLength, "name"),
    retention: parseRetention(request.retention),
  };
}
export function parsePlaylistAction(value: unknown): PlaylistActionRequest {
  const request = record(value, "playlistAction");
  const action = choice(request.action, [
    "extend",
    "unpin",
    "pin",
    "regenerate",
    "delete",
    "retry",
  ], "action");
  const timed = action === "extend" || action === "unpin";
  fields(
    request,
    timed
      ? ["requestId", "expectedRevision", "action", "retention"]
      : ["requestId", "expectedRevision", "action"],
    [],
    "playlistAction",
  );
  const base = {
    requestId: parseId(request.requestId),
    expectedRevision: parseRevision(request.expectedRevision),
  };
  if (timed) {
    return {
      ...base,
      action,
      retention: choice(
        request.retention,
        ["week", "month", "threeMonths"],
        "retention",
      ),
    };
  }
  return { ...base, action };
}

export interface TagVocabularyRequest extends PageRequest {
  readonly search: string;
  readonly sort: "name" | "mostUsed" | "lastUsed" | "unused";
}
export function parseTagVocabulary(value: unknown): TagVocabularyRequest {
  const r = shape(value, ["search", "sort", "cursor", "limit"], "vocabulary");
  return {
    search: text(r.search, CONTRACT_LIMITS.searchLength, "search"),
    sort: choice(r.sort, ["name", "mostUsed", "lastUsed", "unused"], "sort"),
    ...parsePageRequest({ cursor: r.cursor, limit: r.limit }),
  };
}
export function parseTagSelection(value: unknown) {
  const r = shape(
    value,
    ["selection", "tagIds", "expectedRevision"],
    "tagSelection",
  );
  return {
    selection: parseSelection(r.selection),
    tagIds: parseTagLookup({ tagIds: r.tagIds }).tagIds,
    expectedRevision: parseLibraryRevision(r.expectedRevision),
  };
}
export type TagManageIntent =
  | { readonly action: "rename"; readonly tagId: TagId; readonly name: string }
  | {
    readonly action: "merge";
    readonly sourceIds: readonly TagId[];
    readonly targetId: TagId;
  }
  | { readonly action: "delete"; readonly tagId: TagId };
export function parseTagManage(
  value: unknown,
  commit = false,
): TagManageIntent & {
  readonly expectedRevision: LibraryRevision;
  readonly confirmedAssignmentCount?: number;
} {
  const r = record(value, "tagManage");
  const action = choice(r.action, ["rename", "merge", "delete"], "action");
  fields(
    r,
    action === "rename"
      ? ["action", "tagId", "name", "expectedRevision"]
      : action === "merge"
      ? ["action", "sourceIds", "targetId", "expectedRevision"]
      : ["action", "tagId", "expectedRevision"],
    commit && action === "delete" ? ["confirmedAssignmentCount"] : [],
    "tagManage",
  );
  const expectedRevision = parseLibraryRevision(r.expectedRevision);
  if (action === "rename") {
    return {
      action,
      tagId: parseId(r.tagId),
      name: name(r.name, CONTRACT_LIMITS.tagNameLength, "name"),
      expectedRevision,
    };
  }
  if (action === "merge") {
    const sourceIds = parseTagLookup({ tagIds: r.sourceIds }).tagIds,
      targetId = parseId(r.targetId);
    if (sourceIds.includes(targetId)) invalid("sourceIds");
    return { action, sourceIds, targetId, expectedRevision };
  }
  if (
    commit &&
    (typeof r.confirmedAssignmentCount !== "number" ||
      !Number.isSafeInteger(r.confirmedAssignmentCount) ||
      r.confirmedAssignmentCount < 0)
  ) invalid("confirmedAssignmentCount");
  return {
    action,
    tagId: parseId(r.tagId),
    expectedRevision,
    ...(commit
      ? { confirmedAssignmentCount: r.confirmedAssignmentCount as number }
      : {}),
  };
}
export interface TagManagePreviewResponse {
  readonly revision: LibraryRevision;
  readonly assignmentCount: number;
  readonly activeTrackCount: number;
  readonly unionCount: number;
  readonly collisionTag: TagDTO | null;
}
export interface TagManageResponse extends TagManagePreviewResponse {
  readonly actionId: string | null;
  readonly changedCount: number;
  readonly tag: TagDTO | null;
}
export interface TagSelectionResponse {
  readonly revision: LibraryRevision;
  readonly selectedCount: number;
  readonly tags: readonly {
    readonly tag: TagDTO;
    readonly assignedCount: number;
    readonly state: "all" | "some" | "none";
  }[];
}
export interface TagVocabularyResponse extends TagSearchResponse {
  readonly nextCursor: string | null;
}

export interface LibraryFacetsRequest extends PageRequest {
  readonly filter: LibraryFilter;
  readonly facet: "artist" | "album" | "decade";
}
export function parseLibraryFacets(value: unknown): LibraryFacetsRequest {
  const r = shape(value, ["filter", "facet", "cursor", "limit"], "facets");
  return {
    filter: parseLibraryFilter(r.filter),
    facet: choice(r.facet, ["artist", "album", "decade"], "facet"),
    ...parsePageRequest({ cursor: r.cursor, limit: r.limit }),
  };
}
export interface LibraryFacetsResponse {
  readonly revision: LibraryRevision;
  readonly facet: "artist" | "album" | "decade";
  readonly options: readonly {
    readonly value: string;
    readonly name: string;
    readonly trackCount: number;
  }[];
  readonly totalOptions: number;
  readonly nextCursor: string | null;
}
