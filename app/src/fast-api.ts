import {
  parseLibraryRevision,
  parseId,
  parseTrackKey,
  type LibrarySort,
  parseSelection,
  type LibraryFilter,
  type LibraryRevision,
  type TagDTO,
  type TrackDTO,
} from "../../supabase/functions/_shared/contracts";
import { ApiError, parseArtworkUrl, tag, track } from "./api";
export type FastFilter = LibraryFilter;
export type Sort = LibrarySort;
export type Facet = "artist" | "album" | "decade";
export type Group = {
  artworkUrl: string | null;
  value: string;
  name: string;
  trackCount: number;
  taggedCount: number;
  selection: Extract<ReturnType<typeof parseSelection>, { kind: "filter" }>;
};
export type Search = {
  artworkPending: boolean;
  revision: LibraryRevision;
  totalTracks: number;
  nextCursor: string | null;
} & (
  | { groupBy: null; tracks: readonly TrackDTO[] }
  | { groupBy: Facet; groups: readonly Group[]; totalGroups: number }
);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError("invalid_response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 10000)
    throw new ApiError("invalid_response");
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new ApiError("invalid_response");
  return value as T;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ApiError("invalid_response");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ApiError("invalid_response");
  return value;
}
function array<T>(value: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 200)
    throw new ApiError("invalid_response");
  return value.map(parse);
}
function cursor(value: unknown): string | null {
  if (value === null) return null;
  const s = string(value);
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(s))
    throw new ApiError("invalid_response");
  return s;
}
export function search(value: unknown): Search {
  const v = object(value),
    base = {
      revision: parseLibraryRevision(v.revision),
      artworkPending:
        v.artworkPending === undefined ? false : boolean(v.artworkPending),
      totalTracks: count(v.totalTracks),
      nextCursor: cursor(v.nextCursor),
    };
  if (v.groupBy === null)
    return { ...base, groupBy: null, tracks: array(v.tracks, track) };
  const groupBy = choice(v.groupBy, ["artist", "album", "decade"]);
  return {
    ...base,
    groupBy,
    totalGroups: count(v.totalGroups),
    groups: array(v.groups, (x) => {
      const g = object(x),
        selection = parseSelection(g.selection);
      if (selection.kind !== "filter") throw new ApiError("invalid_response");
      return {
        value: string(g.value ?? g.artistId),
        artworkUrl: parseArtworkUrl(g.artworkUrl ?? null),
        name: string(g.name),
        trackCount: count(g.trackCount),
        taggedCount: count(g.taggedCount),
        selection,
      };
    }),
  };
}
export function facets(value: unknown) {
  const v = object(value);
  return {
    revision: parseLibraryRevision(v.revision),
    options: array(v.options, (x) => {
      const o = object(x);
      return {
        value: string(o.value),
        name: string(o.name),
        trackCount: count(o.trackCount),
      };
    }),
    nextCursor: cursor(v.nextCursor),
    totalOptions: count(v.totalOptions),
  };
}
export function vocabulary(value: unknown) {
  const v = object(value);
  return {
    tags: array(v.tags, tag),
    revision: parseLibraryRevision(v.revision),
    nextCursor: cursor(v.nextCursor),
  };
}
export function tagSelection(value: unknown) {
  const v = object(value);
  return {
    revision: parseLibraryRevision(v.revision),
    selectedCount: count(v.selectedCount),
    tags: array(v.tags, (x) => {
      const t = object(x);
      const state = choice(t.state, ["all", "some", "none"]);
      return {
        tag: tag(t.tag),
        assignedCount: count(t.assignedCount),
        state,
      };
    }),
  };
}
export type ManageIntent =
  | { action: "rename"; tagId: string; name: string }
  | { action: "merge"; sourceIds: string[]; targetId: string }
  | { action: "delete"; tagId: string };
export function managePreview(value: unknown) {
  const v = object(value);
  return {
    revision: parseLibraryRevision(v.revision),
    assignmentCount: count(v.assignmentCount),
    activeTrackCount: count(v.activeTrackCount),
    unionCount: count(v.unionCount),
    collisionTag: v.collisionTag === null ? null : tag(v.collisionTag),
  };
}
export function manage(value: unknown) {
  const v = object(value);
  return {
    ...managePreview(v),
    actionId: v.actionId === null ? null : parseId(v.actionId),
    changedCount: count(v.changedCount),
    tag: v.tag === null ? null : tag(v.tag),
  };
}
export function sameRevision(a: LibraryRevision, b: LibraryRevision) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function facetFilter(
  filter: FastFilter,
  facet: Facet,
  value: string | null,
): FastFilter {
  return {
    ...filter,
    ...(facet === "artist"
      ? { artistId: value }
      : facet === "album"
        ? { album: value }
        : {
            decade:
              value === null
                ? null
                : value === "unknown"
                  ? "unknown"
                  : Number(value),
          }),
  };
}
export function acknowledged(value: unknown) {
  const v = object(value);
  return {
    revision: parseLibraryRevision(v.revision),
    changedCount: count(v.changedCount),
  };
}

export type QueueEntry = { key: string; track: TrackDTO };
export function queueTracks(value: unknown) {
  const v = object(value);
  const entries = array(v.entries, (item): QueueEntry => {
    const entry = object(item);
    return { key: parseTrackKey(entry.key), track: track(entry.track) };
  });
  if (
    entries.length > 100 ||
    new Set(entries.map((e) => e.key)).size !== entries.length ||
    entries.some(
      (e) => !e.track.metadata || e.track.metadata.removedAt !== null,
    )
  )
    throw new ApiError("invalid_response");
  return { revision: parseLibraryRevision(v.revision), entries };
}
export function queueSnapshot(value: unknown) {
  const v = object(value);
  if (!Array.isArray(v.trackKeys) || v.trackKeys.length > 100000)
    throw new ApiError("invalid_response");
  const trackKeys = v.trackKeys.map(parseTrackKey);
  if (new Set(trackKeys).size !== trackKeys.length)
    throw new ApiError("invalid_response");
  const result = queueTracks(value);
  if (result.entries.some((entry) => !trackKeys.includes(entry.key)))
    throw new ApiError("invalid_response");
  return { ...result, trackKeys };
}
