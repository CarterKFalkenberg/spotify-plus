import { useEffect, useState } from "react";
import type {
  Selection,
  LibraryRevision,
  TagDTO,
} from "../../supabase/functions/_shared/contracts";
import { api, tags, errorMessage } from "./api";
import { tagSelection } from "./fast-api";
export function BulkTags({
  selection,
  revision,
  refresh,
  busy,
  onMutate,
}: {
  selection: Selection;
  revision: LibraryRevision;
  refresh: number;
  busy: boolean;
  onMutate: (tag: TagDTO, kind: "add" | "remove") => Promise<void>;
}) {
  const [data, setData] = useState<ReturnType<typeof tagSelection> | null>(
      null,
    ),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError("");
    async function load() {
      const vocab = await api(
        "/tags?search=&limit=100",
        tags,
        undefined,
        c.signal,
      );
      const v = await api(
        "/tags/selection",
        tagSelection,
        {
          selection,
          tagIds: vocab.tags.map((t) => t.id),
          expectedRevision:
            selection.kind === "filter" ? selection.expectedRevision : revision,
        },
        c.signal,
      );
      if (!c.signal.aborted) setData(v);
    }
    void load().catch((e) => {
      if (!c.signal.aborted) setError(errorMessage(e));
    });
    return () => c.abort();
  }, [selection, revision, refresh]);
  return (
    <div className="bulk-states">
      {data && (
        <>
          <small>
            {data.selectedCount} songs · Add fills missing tags; Remove
            explicitly clears.
          </small>
          <div className="chips">
            {data.tags.map((t) => (
              <div className="tri-tag" key={t.tag.id}>
                <button
                  className="chip"
                  disabled={busy}
                  aria-label={`Add ${t.tag.name}: ${t.state} (${t.assignedCount} of ${data.selectedCount})`}
                  onClick={() => void onMutate(t.tag, "add").catch(() => {})}
                >
                  {t.state === "all" ? "✓" : t.state === "some" ? "−" : "○"}{" "}
                  {t.tag.name} · {t.assignedCount}
                </button>
                <button
                  className="compact"
                  disabled={busy || t.state === "none"}
                  aria-label={`Clear ${t.tag.name} from selection`}
                  onClick={() => void onMutate(t.tag, "remove").catch(() => {})}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
