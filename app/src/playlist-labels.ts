import type {
  TagDTO,
  QueryNode,
} from "../../supabase/functions/_shared/contracts";
import { ApiError, lookupTags } from "./api";

export function queryTagIds(node: QueryNode): string[] {
  return node.op === "tag"
    ? [node.tagId]
    : node.op === "not"
      ? queryTagIds(node.child)
      : node.children.flatMap(queryTagIds);
}

// The owner lookup deliberately rejects an entire batch on a deleted identity.
// Isolate those leaves for display only; never rewrite the stored query. Bound
// additional reads even for a pathological query with many deleted identities.
export async function resolvePlaylistLabels(
  ids: readonly string[],
  signal: AbortSignal,
) {
  const unique = [...new Set(ids)].sort();
  const tags: TagDTO[] = [];
  const missing: string[] = [];
  const unavailable: string[] = [];
  const rejected: string[][] = [];
  let remaining = 32;
  async function resolve(batch: string[], isolate: boolean): Promise<void> {
    signal.throwIfAborted();
    if (isolate && remaining-- <= 0) {
      unavailable.push(...batch);
      return;
    }
    try {
      tags.push(...(await lookupTags(batch, signal)));
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "unknown_tag")
        throw error;
      if (batch.length === 1) missing.push(batch[0]!);
      else if (!isolate) rejected.push(batch);
      else {
        const middle = Math.ceil(batch.length / 2);
        await resolve(batch.slice(0, middle), true);
        await resolve(batch.slice(middle), true);
      }
    }
  }
  for (let start = 0; start < unique.length; start += 200)
    await resolve(unique.slice(start, start + 200), false);
  for (const batch of rejected) {
    const middle = Math.ceil(batch.length / 2);
    await resolve(batch.slice(0, middle), true);
    await resolve(batch.slice(middle), true);
  }
  return { tags, missing, unavailable };
}

export function expiryDays(expiresOn: string, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // Compare calendar dates, not elapsed hours across daylight-saving changes.
  return Math.round((Date.parse(expiresOn) - Date.parse(today)) / 86_400_000);
}
