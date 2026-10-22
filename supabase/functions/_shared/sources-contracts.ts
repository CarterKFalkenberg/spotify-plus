import { ContractError, type LibraryRevision } from "./contracts.ts";
export interface SourceDTO {
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
export interface SourcesDTO {
  collaborativeConsentRequired: boolean;
  items: SourceDTO[];
  total: number;
  enabledCount: number;
  uniqueTrackCount: number;
  importing: boolean;
  revision: LibraryRevision;
}
export function sourceSelection(
  value: unknown,
): { ids: string[]; enabled: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("selection");
  }
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["ids", "enabled"].includes(k)) ||
    typeof v.enabled !== "boolean" || !Array.isArray(v.ids) ||
    v.ids.length < 1 || v.ids.length > 10000 ||
    v.ids.some((id) =>
      typeof id !== "string" || !/^(liked|[A-Za-z0-9]{22})$/.test(id)
    )
  ) throw new ContractError("selection");
  return { ids: [...new Set(v.ids as string[])], enabled: v.enabled };
}
export function sourcesList(url: URL) {
  if (
    [...url.searchParams.keys()].some((k) =>
      !["search", "offset", "limit"].includes(k) ||
      url.searchParams.getAll(k).length !== 1
    )
  ) throw new ContractError("parameters");
  const search = url.searchParams.get("search") ?? "";
  const offset = url.searchParams.get("offset") ?? "0";
  const limit = url.searchParams.get("limit") ?? "50";
  if (
    search.length > 200 || !/^\d{1,9}$/.test(offset) ||
    !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100
  ) throw new ContractError("parameters");
  return { search, offset: Number(offset), limit: Number(limit) };
}
export function emptySourceRequest(value: unknown) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length
  ) throw new ContractError("parameters");
}
