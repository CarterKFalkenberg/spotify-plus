import type {
  ReviewDTO,
  ReviewDestinationDTO,
  ReviewDestinationsDTO,
  ReviewOperationDTO,
  ReviewCommand,
  ReviewInput,
} from "../../supabase/functions/_shared/review-contracts";
import {
  parseId,
  parseTrackKey,
} from "../../supabase/functions/_shared/contracts";
import { ApiError, parseArtworkUrl, track } from "./api";
function fail(): never {
  throw new ApiError("invalid_response");
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
}
function str(v: unknown): string {
  return typeof v === "string" && v.length <= 10000 ? v : fail();
}
function bool(v: unknown): boolean {
  return typeof v === "boolean" ? v : fail();
}
function count(v: unknown): number {
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail();
}
function revision(v: unknown) {
  return /^\d{1,18}$/.test(str(v)) ? str(v) : fail();
}
function playlistId(v: unknown) {
  return /^[A-Za-z0-9]{22}$/.test(str(v)) ? str(v) : fail();
}
function choice<T extends string>(v: unknown, options: T[]): T {
  return options.includes(v as T) ? (v as T) : fail();
}
function rows<T>(v: unknown, parse: (v: unknown) => T): T[] {
  return Array.isArray(v) && v.length <= 10000 ? v.map(parse) : fail();
}
function nullable<T>(v: unknown, parse: (v: unknown) => T): T | null {
  return v === null ? null : parse(v);
}
function destination(raw: unknown): ReviewDestinationDTO {
  const v = obj(raw),
    id = playlistId(v.id);
  if (v.spotifyUrl !== `https://open.spotify.com/playlist/${id}`) fail();
  return {
    id,
    name: str(v.name),
    artworkUrl: parseArtworkUrl(v.artworkUrl),
    spotifyUrl: str(v.spotifyUrl),
    configured: bool(v.configured),
    available: bool(v.available),
    membership: choice(v.membership, [
      "unknown",
      "checking",
      "present",
      "absent",
      "unavailable",
    ]),
    errorCode: nullable(v.errorCode, str),
  };
}
function destinations(v: unknown) {
  const result = rows(v, destination);
  if (new Set(result.map((d) => d.id)).size !== result.length) fail();
  return result;
}
function operation(raw: unknown): ReviewOperationDTO {
  const v = obj(raw);
  const result = {
    id: parseId(v.id),
    trackKey: parseTrackKey(v.trackKey),
    kind: choice(v.kind, ["done", "discard"]),
    status: choice(v.status, [
      "queued",
      "adding",
      "unliking",
      "completed",
      "undoing",
      "undone",
      "needs_attention",
    ]),
    errorCode: nullable(v.errorCode, str),
    completedDestinations: count(v.completedDestinations),
    totalDestinations: count(v.totalDestinations),
    reversalIncomplete: bool(v.reversalIncomplete),
  } as ReviewOperationDTO;
  if (result.completedDestinations > result.totalDestinations) fail();
  return result;
}
export function reviewDestinations(raw: unknown): ReviewDestinationsDTO {
  const v = obj(raw);
  return {
    revision: revision(v.revision),
    items: destinations(v.items),
    discoveryStatus: choice(v.discoveryStatus, [
      "pending",
      "ready",
      "unavailable",
    ]),
  };
}
export function review(raw: unknown): ReviewDTO {
  const v = obj(raw);
  return {
    sessionId: parseId(v.sessionId),
    revision: revision(v.revision),
    remaining: count(v.remaining),
    skipped: count(v.skipped),
    current: nullable(v.current, track),
    destinations: destinations(v.destinations),
    draft: nullable(v.draft, (raw) => {
      const d = obj(raw),
        ids = rows(d.destinationIds, playlistId);
      if (new Set(ids).size !== ids.length) fail();
      return {
        trackKey: parseTrackKey(d.trackKey),
        destinationIds: ids,
        revision: revision(d.revision),
      };
    }),
    operation: nullable(v.operation, operation),
    undo: nullable(v.undo, operation),
    syncStatus: choice(v.syncStatus, ["pending", "ready", "unavailable"]),
    discoveryStatus: choice(v.discoveryStatus, [
      "pending",
      "ready",
      "unavailable",
    ]),
  };
}
export async function reviewRequest<T>(
  path: string,
  parse: (v: unknown) => T,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/review${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true,
        }),
    signal: signal ?? AbortSignal.timeout(20000),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new ApiError(
      typeof obj(value).error === "string"
        ? str(obj(value).error)
        : "unavailable",
      response.status,
    );
  return parse(value);
}
export function reviewCommand(command: ReviewCommand, input: ReviewInput) {
  return reviewRequest(`/${command}`, review, input);
}
export function reviewWorking(value: ReviewDTO) {
  return (
    value.syncStatus === "pending" ||
    value.discoveryStatus === "pending" ||
    value.destinations.some(
      (d) => d.membership === "unknown" || d.membership === "checking",
    ) ||
    (!!value.operation &&
      ["queued", "adding", "unliking", "undoing"].includes(
        value.operation.status,
      ))
  );
}
