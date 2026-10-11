import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { facets, facetFilter, type Facet, type FastFilter } from "./fast-api";
export function Facets({
  filter,
  refresh,
  onChange,
}: {
  filter: FastFilter;
  refresh: number;
  onChange: (f: FastFilter) => void;
}) {
  return (
    <div className="facet-row">
      {(["artist", "album", "decade"] as const).map((f) => (
        <FacetSelect
          key={f}
          facet={f}
          filter={filter}
          refresh={refresh}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
function FacetSelect({
  facet,
  filter,
  refresh,
  onChange,
}: {
  facet: Facet;
  filter: FastFilter;
  refresh: number;
  onChange: (f: FastFilter) => void;
}) {
  const [page, setPage] = useState<{ context: string; cursor: string } | null>(
    null,
  );
  const [data, setData] = useState<{
    context: string;
    options: ReturnType<typeof facets>["options"];
    nextCursor: string | null;
  } | null>(null);
  const [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const context = JSON.stringify([filter, refresh, retry]);
  const cursor = page?.context === context ? page.cursor : null;
  const options = data?.context === context ? data.options : [],
    next = data?.context === context ? data.nextCursor : null;
  useEffect(() => {
    const c = new AbortController();
    setError("");
    void loadFacetOptions(filter, facet, page, refresh, retry, c.signal)
      .then((v) => {
        if (!c.signal.aborted) {
          setData((old) => ({
            context,
            options:
              cursor && old?.context === context
                ? [...old.options, ...v.options]
                : v.options,
            nextCursor: v.nextCursor,
          }));
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [filter, facet, cursor, refresh, retry]);
  const value =
    facet === "artist"
      ? filter.artistId
      : facet === "album"
        ? filter.album
        : filter.decade;
  return (
    <label>
      {`${facet[0]?.toUpperCase()}${facet.slice(1)}`}
      <select
        aria-label={`${facet[0]?.toUpperCase()}${facet.slice(1)}`}
        value={value ?? ""}
        onChange={(e) =>
          onChange(facetFilter(filter, facet, e.target.value || null))
        }
      >
        <option value="">All {facet}s</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.name} · {o.trackCount}
          </option>
        ))}
      </select>
      {next && (
        <button
          className="compact"
          onClick={() => setPage({ context, cursor: next })}
        >
          More {facet}s
        </button>
      )}
      {error && (
        <span role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setPage(null);
              setRetry((v) => v + 1);
            }}
          >
            Retry facets
          </button>
        </span>
      )}
    </label>
  );
}

export async function loadFacetOptions(
  filter: FastFilter,
  facet: Facet,
  page: { context: string; cursor: string } | null,
  refresh: number,
  retry: number,
  signal: AbortSignal,
) {
  const context = JSON.stringify([filter, refresh, retry]);
  const result = await api(
    "/library/facets",
    facets,
    {
      filter,
      facet,
      cursor: page?.context === context ? page.cursor : null,
      limit: 100,
    },
    signal,
  );
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return result;
}
