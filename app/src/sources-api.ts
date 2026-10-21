import {
  parseLibraryRevision,
  type LibraryRevision,
} from "../../supabase/functions/_shared/contracts";
import { api, ApiError, parseArtworkUrl } from "./api";
export interface Source {
  id: string;
  kind: "liked" | "playlist";
  name: string;
  artworkUrl: string | null;
  spotifyUrl: string | null;
  enabled: boolean;
  available: boolean;
  managed: boolean;
  trackCount: number;
  uniqueCount: number;
  importedCount: number;
  skippedCount: number;
  syncStatus: "pending" | "syncing" | "complete" | "error" | "disabled";
  lastSyncedAt: string | null;
  errorCode: string | null;
}
export interface SourcesPage {
  items: Source[];
  total: number;
  enabledCount: number;
  uniqueTrackCount: number;
  importing: boolean;
  collaborativeConsentRequired: boolean;
  revision: LibraryRevision;
}
function fail(): never {
  throw new ApiError("invalid_response");
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
}
function str(v: unknown) {
  return typeof v === "string" && v.length <= 10000 ? v : fail();
}
function count(v: unknown) {
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail();
}
function bool(v: unknown) {
  return typeof v === "boolean" ? v : fail();
}
export function sourceId(v: unknown) {
  return v === "liked" || /^[A-Za-z0-9]{22}$/.test(str(v)) ? str(v) : fail();
}
export function sourcesPage(value: unknown): SourcesPage {
  const v = obj(value);
  if (!Array.isArray(v.items) || v.items.length > 100) fail();
  const items = v.items.map((raw): Source => {
    const s = obj(raw);
    if (
      !["liked", "playlist"].includes(str(s.kind)) ||
      !["pending", "syncing", "complete", "error", "disabled"].includes(
        str(s.syncStatus),
      )
    )
      fail();
    const date = s.lastSyncedAt === null ? null : str(s.lastSyncedAt);
    if (date !== null && !Number.isFinite(Date.parse(date))) fail();
    const link = s.spotifyUrl === null ? null : str(s.spotifyUrl);
    if (
      link !== null &&
      !/^https:\/\/open\.spotify\.com\/(playlist\/[A-Za-z0-9]{22}|collection\/tracks)$/.test(
        link,
      )
    )
      fail();
    return {
      id: sourceId(s.id),
      kind: s.kind as Source["kind"],
      name: str(s.name),
      artworkUrl: parseArtworkUrl(s.artworkUrl),
      spotifyUrl: link,
      enabled: bool(s.enabled),
      available: bool(s.available),
      managed: bool(s.managed),
      trackCount: count(s.trackCount),
      uniqueCount: count(s.uniqueCount),
      importedCount: count(s.importedCount),
      skippedCount: count(s.skippedCount),
      syncStatus: s.syncStatus as Source["syncStatus"],
      lastSyncedAt: date,
      errorCode: s.errorCode === null ? null : str(s.errorCode),
    };
  });
  if (new Set(items.map((s) => s.id)).size !== items.length) fail();
  return {
    items,
    total: count(v.total),
    enabledCount: count(v.enabledCount),
    uniqueTrackCount: count(v.uniqueTrackCount),
    importing: bool(v.importing),
    collaborativeConsentRequired:
      v.collaborativeConsentRequired === undefined
        ? false
        : bool(v.collaborativeConsentRequired),
    revision: parseLibraryRevision(v.revision),
  };
}
export function sourceMutation(value: unknown) {
  const v = obj(value);
  return { revision: parseLibraryRevision(v.revision) };
}
export function readSources(
  search: string,
  offset: number,
  signal?: AbortSignal,
) {
  return api(
    `/sources?${new URLSearchParams({ search, offset: String(offset), limit: "50" })}`,
    sourcesPage,
    undefined,
    signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : undefined,
  );
}
/** Enumerate bounded pages, then perform one atomic explicit selection mutation. */
export async function matchingSourceIds(
  search: string,
  signal: AbortSignal,
): Promise<string[]> {
  const ids = new Set<string>();
  let revision: string | undefined;
  for (let offset = 0; offset < 10000; offset += 50) {
    const page = await readSources(search, offset, signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (
      page.total > 10000 ||
      (revision !== undefined && revision !== page.revision.library)
    )
      throw new ApiError("stale_revision");
    revision = page.revision.library;
    for (const source of page.items) if (source.available) ids.add(source.id);
    if (offset + page.items.length >= page.total) return [...ids];
    if (page.items.length !== 50) fail();
  }
  throw new ApiError("stale_revision");
}

export function sourceConsent(value: unknown) {
  const url = new URL(str(obj(value).url));
  if (
    url.origin !== "https://accounts.spotify.com" ||
    url.pathname !== "/authorize" ||
    url.username ||
    url.password
  )
    fail();
  return url.href;
}
