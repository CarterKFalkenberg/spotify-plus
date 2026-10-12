import type { QueryNode, Retention, StoredQuery } from "./contracts.ts";

export const PLAYLIST_ZONE = "America/New_York";
// An application budget, not a claim about an undocumented Spotify maximum.
export const DESCRIPTION_LIMIT = 300;

export class PlaylistError extends Error {
  constructor(
    readonly kind:
      | "creation_unknown"
      | "duplicate_marker"
      | "description_capacity"
      | "remote_changed"
      | "removal_unconfirmed"
      | "lease_lost"
      | "invalid_work",
  ) {
    super(`playlist_${kind}`);
  }
}

export function localDate(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLAYLIST_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Use calendar fields, never elapsed milliseconds, across DST and month ends.
export function expiryDate(now: number, retention: Retention): string | null {
  if (retention === "pinned") return null;
  const [year, month, day] = localDate(now).split("-").map(Number);
  if (retention === "week") {
    return new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(
      0,
      10,
    );
  }
  const monthOffset = retention === "month" ? 1 : 3;
  const lastDay = new Date(Date.UTC(year, month + monthOffset, 0)).getUTCDate();
  return new Date(
    Date.UTC(year, month - 1 + monthOffset, Math.min(day, lastDay)),
  )
    .toISOString().slice(0, 10);
}

export function creationMarker(id: string): string {
  return `[Tagger:${id}]`;
}

export function renderQuery(
  query: StoredQuery,
  labels: Readonly<Record<string, string>>,
): string {
  function node(value: QueryNode): string {
    if (value.op === "tag") {
      return JSON.stringify(labels[value.tagId] ?? "Deleted tag");
    }
    if (value.op === "not") return `NOT ${node(value.child)}`;
    return `(${
      value.children.map(node).join(value.op === "and" ? " AND " : " OR ")
    })`;
  }
  return node(query.root);
}

export function playlistDescription(
  id: string,
  queryText: string,
  expiresOn: string | null,
  current: string | null,
): string {
  const start = creationMarker(id);
  const end = "[/Tagger]";
  // Only our exact block is replaceable. Outside canonical text survives exactly;
  // Spotify response escape bytes are normalized by the adapter, not here.
  const existing = current ?? "";
  const from = existing.indexOf(start);
  const to = from < 0 ? -1 : existing.indexOf(end, from + start.length);
  const prefix = from >= 0 && to >= 0 ? existing.slice(0, from) : existing;
  const suffix = from >= 0 && to >= 0 ? existing.slice(to + end.length) : "";
  // Add only a space when framing notes without our block. Existing outside
  // whitespace (including any owner-supplied newline) still survives exactly.
  const separator = from >= 0 && to >= 0 || !prefix ? "" : " ";
  const expiry = expiresOn === null
    ? "Pinned; never expires."
    : `Valid through ${expiresOn} (New York); then removed from Your Library.`;
  const head = `${start} Snapshot: `;
  const tail = `. ${expiry} Regenerate overwrites manual edits. ${end}`;
  const capacity = DESCRIPTION_LIMIT -
    [...(prefix + suffix + separator + head + tail)].length;
  if (capacity < 1) throw new PlaylistError("description_capacity");
  // Accepted tag strings may contain our framing verbatim. Escape only their
  // display representation; the stored query/tag text stays intact.
  const safeQuery = queryText.replaceAll("[", "\\u005b").replaceAll(
    "]",
    "\\u005d",
  );
  const text = [...safeQuery];
  const compact = text.length <= capacity
    ? safeQuery
    : text.slice(0, Math.max(0, capacity - 1)).join("") + "…";
  return prefix + separator + head + compact + tail + suffix;
}

export function verifiedPrefix(
  target: readonly string[],
  remote: readonly (string | null)[],
): boolean {
  return remote.length <= target.length &&
    remote.every((uri, i) => uri === target[i]);
}
