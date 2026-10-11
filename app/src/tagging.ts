/** Only empty, non-composing input consumes numeric slots or navigation keys. */
export function queueShortcut(
  event: {
    key: string;
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
    )[event.key.toLowerCase()] ?? null
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
