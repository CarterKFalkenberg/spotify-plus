/** Only empty, non-composing input consumes numeric slots or navigation keys. */
export function queueShortcut(
  event: {
    key: string;
    code?: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    isComposing: boolean;
  },
  editable: boolean,
  text: string,
): string | null {
  if (event.isComposing || event.repeat || event.ctrlKey || event.metaKey)
    return null;
  if (!event.altKey && !event.shiftKey && (!editable || text === "")) {
    if (/^[1-9]$/.test(event.key)) return `slot:${event.key}`;
    if (event.key === "ArrowRight") return "next";
    if (event.key === "ArrowLeft") return "previous";
  }
  if (editable && !event.altKey) return null;
  if (event.shiftKey && event.key !== "?") return null;
  return (
    (
      {
        s: "skip",
        z: "undo",
        r: "remove",
        o: "open",
        a: "artist",
        "?": "help",
        h: "help",
      } as Record<string, string>
    )[
      (event.altKey && /^Key[A-Z]$/.test(event.code ?? "")
        ? event.code!.slice(3)
        : event.key
      ).toLowerCase()
    ] ?? null
  );
}
export function rangeSelection(
  keys: readonly string[],
  selected: readonly string[],
  anchor: string | null,
  key: string,
  shift: boolean,
  checked: boolean,
): string[] {
  const from = anchor === null ? -1 : keys.indexOf(anchor),
    to = keys.indexOf(key);
  const targets =
    shift && from >= 0 && to >= 0
      ? keys.slice(Math.min(from, to), Math.max(from, to) + 1)
      : [key];
  return checked
    ? [...new Set([...selected, ...targets])]
    : selected.filter((x) => !targets.includes(x));
}
export function skipToTail<T>(rows: readonly T[], index: number): T[] {
  const result = [...rows],
    item = result.splice(index, 1)[0];
  if (item !== undefined) result.push(item);
  return result;
}
/** Keep session number-key assignments while filling previously uninitialized slots. */
export function refreshQuickRank<T extends { id: string }>(
  previous: readonly (T | undefined)[],
  fresh: readonly T[],
): (T | undefined)[] {
  const existing = new Set(previous.flatMap((tag) => (tag ? [tag.id] : [])));
  return [
    ...previous.map((tag) =>
      tag ? (fresh.find((next) => next.id === tag.id) ?? tag) : undefined,
    ),
    ...fresh.filter((tag) => !existing.has(tag.id)),
  ].slice(0, 30);
}

export function quickSlots<T extends { id: string }>(
  ranked: readonly (T | undefined)[],
  pins: Record<number, T>,
  size = 9,
): (T | undefined)[] {
  const unpinned = ranked.filter(
    (t) => !t || !Object.values(pins).some((p) => p.id === t.id),
  );
  let next = 0;
  return Array.from({ length: size }, (_, i) => pins[i] ?? unpinned[next++]);
}
export function preserveCurrent<T extends { trackKey: string }>(
  old: readonly T[],
  index: number,
  live: Map<string, T>,
) {
  const key = old[index]?.trackKey;
  const rows = old
    .filter((t) => live.has(t.trackKey))
    .map((t) => live.get(t.trackKey)!);
  const retained = rows.findIndex((t) => t.trackKey === key);
  return {
    rows,
    index:
      retained >= 0 ? retained : Math.max(0, Math.min(index, rows.length - 1)),
  };
}
/** Existing-ID assignment and acknowledgement RPCs each advance annotations
 * exactly once iff they change rows. A greater jump includes unrelated edits;
 * a different library revision includes membership changes. Neither is covered
 * by patching a single song. Name-based creation can add another revision and
 * deliberately does not use this optimization. */
export function ownedPatchRevision(
  previous: { library: string; annotations: string } | null,
  result: { library: string; annotations: string },
  changed: boolean,
) {
  if (!previous || previous.library !== result.library) return previous;
  return BigInt(result.annotations) ===
    BigInt(previous.annotations) + (changed ? 1n : 0n)
    ? result
    : previous;
}

/** Undo restores one changed edge, never a stale snapshot of the song's tags. */
export function restoredQueueTags(
  current: readonly string[],
  action: { tagId: string; kind: "add" | "remove"; changed: boolean },
  result: { restoredCount: number; skippedCount: number },
): readonly string[] {
  if (
    !action.changed ||
    result.restoredCount !== 1 ||
    result.skippedCount !== 0
  )
    return current;
  return action.kind === "add"
    ? current.filter((id) => id !== action.tagId)
    : [...new Set([...current, action.tagId])];
}

export function normalizedTagName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Groups follow first appearance in ranked results; rank within each is retained.
 * Prefixes are display conventions only, with no effect on tag identity. */
export function groupedTagOptions<T extends { id: string; name: string }>(
  ranked: readonly T[],
): { tag: T; heading: string | null }[] {
  const groups = new Map<string, { label: string | null; tags: T[] }>();
  for (const tag of ranked) {
    const colon = tag.name.indexOf(":");
    const label = colon >= 0 ? tag.name.slice(0, colon) : null;
    const key =
      label === null ? `tag:${tag.id}` : `prefix:${normalizedTagName(label)}`;
    const group = groups.get(key);
    if (group) group.tags.push(tag);
    else groups.set(key, { label, tags: [tag] });
  }
  return [...groups.values()].flatMap(({ label, tags }) =>
    tags.map((tag, index) => ({
      tag,
      heading:
        label !== null && tags.length > 1 && index === 0 ? `${label}:` : null,
    })),
  );
}
