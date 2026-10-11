import { useEffect, useState } from "react";
import type {
  Selection,
  LibraryRevision,
  TagDTO,
} from "../../supabase/functions/_shared/contracts";
import { errorMessage } from "./api";
import { loadBulkTags } from "./selection-tags";
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
  const [data, setData] = useState<Awaited<
      ReturnType<typeof loadBulkTags>
    > | null>(null),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    setCursor(null);
  }, [selection, revision, refresh]);
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError("");
    async function load() {
      const v = await loadBulkTags(
        search,
        cursor,
        selection,
        revision,
        c.signal,
      );
      if (!c.signal.aborted) setData(v);
    }
    const timer = setTimeout(
      () =>
        void load().catch((e) => {
          if (!c.signal.aborted) setError(errorMessage(e));
        }),
      150,
    );
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [selection, revision, refresh, search, cursor, retry]);
  return (
    <div className="bulk-states">
      <label>
        Find selection tags
        <input
          type="search"
          value={search}
          maxLength={200}
          onChange={(e) => {
            setSearch(e.target.value);
            setCursor(null);
          }}
          placeholder="Search the whole vocabulary…"
        />
      </label>
      {data && (
        <>
          <small>
            {data.selectedCount === null
              ? "No matching vocabulary yet. Create a tag below to begin."
              : `${data.selectedCount} songs · Add fills missing tags; Remove explicitly clears.`}
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
      {data?.nextCursor && (
        <button className="compact" onClick={() => setCursor(data.nextCursor)}>
          More selection tags
        </button>
      )}
      {cursor && (
        <button className="compact" onClick={() => setCursor(null)}>
          First selection tags
        </button>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="compact"
            onClick={() => {
              setCursor(null);
              setRetry((v) => v + 1);
            }}
          >
            Retry selection tags
          </button>
        </p>
      )}
    </div>
  );
}
