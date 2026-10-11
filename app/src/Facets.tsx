import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { facets, facetFilter, type Facet, type FastFilter } from "./fast-api";
export function Facets({
  filter,
  onChange,
}: {
  filter: FastFilter;
  onChange: (f: FastFilter) => void;
}) {
  return (
    <div className="facet-row">
      {(["artist", "album", "decade"] as const).map((f) => (
        <FacetSelect key={f} facet={f} filter={filter} onChange={onChange} />
      ))}
    </div>
  );
}
function FacetSelect({
  facet,
  filter,
  onChange,
}: {
  facet: Facet;
  filter: FastFilter;
  onChange: (f: FastFilter) => void;
}) {
  const [options, setOptions] = useState<ReturnType<typeof facets>["options"]>(
      [],
    ),
    [cursor, setCursor] = useState<string | null>(null),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    setOptions([]);
    setCursor(null);
  }, [filter]);
  useEffect(() => {
    const c = new AbortController();
    void api(
      "/library/facets",
      facets,
      { filter, facet, cursor, limit: 100 },
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) {
          setOptions((old) => (cursor ? [...old, ...v.options] : v.options));
          setNext(v.nextCursor);
          setError("");
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [filter, facet, cursor]);
  const value =
    facet === "artist"
      ? filter.artistId
      : facet === "album"
        ? filter.album
        : filter.decade;
  return (
    <label>
      {facet[0]?.toUpperCase()}
      {facet.slice(1)}
      <select
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
        <button className="compact" onClick={() => setCursor(next)}>
          More {facet}s
        </button>
      )}
      {error && (
        <span role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setCursor(null);
              onChange({ ...filter });
            }}
          >
            Retry facets
          </button>
        </span>
      )}
    </label>
  );
}
