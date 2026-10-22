import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { CollectionArtwork } from "./Library";
import {
  matchingSourceIds,
  readSources,
  sourceMutation,
  sourceConsent,
  type SourcesPage,
  type Source,
} from "./sources-api";
import { useVisiblePolling } from "./useVisiblePolling";
export function Sources({
  active,
  refresh,
  onChanged,
  onSync,
}: {
  active: boolean;
  refresh: number;
  onChanged: () => void;
  onSync: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<SourcesPage | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const activeRef = useRef(active);
  activeRef.current = active;
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
      setData(null);
    }, 200);
    return () => clearTimeout(timer);
  }, [search, query]);
  useVisiblePolling({
    enabled: active && !busy,
    refreshKey: JSON.stringify([query, offset, attempt, refresh]),
    load: (signal) => readSources(query, offset, signal),
    receive: (next) => {
      setData(next);
      if (offset >= next.total && offset > 0) {
        setOffset(0);
        setData(null);
      }
    },
    working: (next) =>
      next.importing ||
      next.items.some(
        (s) => s.enabled && ["pending", "syncing"].includes(s.syncStatus),
      ),
    onError: (e) => setError(errorMessage(e)),
  });
  async function select(enabled: boolean, id?: string) {
    if (busy) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const ids = id ? [id] : await matchingSourceIds(query, controller.signal);
      if (ids.length) {
        await api(
          "/sources/selection",
          sourceMutation,
          { ids, enabled },
          AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        );
        if (controller.signal.aborted) return;
        onChanged();
      }
      setFeedback(
        ids.length
          ? `Sources ${enabled ? "enabled" : "disabled"}. Your tags stay saved.`
          : "No accessible sources match this search.",
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        onChanged();
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setAttempt((v) => v + 1);
      }
    }
  }
  async function sync() {
    if (busy) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      await api(
        "/sources/sync",
        sourceMutation,
        {},
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      if (!controller.signal.aborted) {
        setFeedback("Sync requested. Imports continue if you close this page.");
        onSync();
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setAttempt((v) => v + 1);
      }
    }
  }
  async function enableCollaborative() {
    if (busy) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError("");
    try {
      const url = await api(
        "/sources/enable",
        sourceConsent,
        {},
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      if (!controller.signal.aborted && activeRef.current)
        window.location.assign(url);
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function state(source: Source) {
    if (!source.available) return "Unavailable in Spotify · last known count";
    if (source.syncStatus === "error")
      return "Sync interrupted · retry available";
    if (source.syncStatus === "syncing")
      return `${source.importedCount.toLocaleString()} imported · syncing`;
    if (source.syncStatus === "pending") return "Waiting to sync";
    if (!source.enabled) return "Off · excluded from your song pool";
    return "Up to date";
  }
  return (
    <section
      className="sources"
      aria-labelledby="sources-title"
      aria-busy={busy}
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">YOUR SONG POOL</p>
          <h2 id="sources-title">Sources</h2>
          <p className="muted">Choose the music you want to tag.</p>
        </div>
        <button disabled={busy} onClick={() => void sync()}>
          Sync sources
        </button>
      </div>
      <p className="sources-explainer">
        Liked Songs and your Spotify playlists feed one library, queue and
        playlist builder. Turning a source off keeps your tags and changes only
        this app.
      </p>
      {data && (
        <div className="source-pool" role="status">
          <strong>
            {data.uniqueTrackCount.toLocaleString()}{" "}
            <span>unique songs enabled</span>
          </strong>
          <span>
            {data.enabledCount} sources on · Songs in several sources count once
            here.
          </span>
          {data.importing && (
            <p>
              Importing new sources. Browse and tag while songs arrive; playlist
              generation resumes after the import is verified.
            </p>
          )}
        </div>
      )}
      {data?.collaborativeConsentRequired && (
        <div className="notice">
          <p>
            Collaborative playlists need optional Spotify read permission. Your
            current sources and tags stay available.
          </p>
          <button disabled={busy} onClick={() => void enableCollaborative()}>
            Enable collaborative playlists
          </button>
        </div>
      )}
      <div className="source-toolbar">
        <label>
          Search sources
          <input
            type="search"
            disabled={busy}
            maxLength={200}
            placeholder="Find a playlist"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setFeedback("");
            }}
          />
        </label>
        <div>
          <button
            className="compact"
            disabled={busy || search !== query || !data?.total}
            onClick={() => void select(true)}
          >
            Select all{query ? " matching" : ""}
          </button>
          <button
            className="compact"
            disabled={busy || search !== query || !data?.total}
            onClick={() => void select(false)}
          >
            Deselect all{query ? " matching" : ""}
          </button>
        </div>
      </div>
      <p className="muted source-scope">
        All/none applies to every accessible source
        {query ? " matching your search" : ""}, across all pages. App-generated
        playlists start off; you can enable them explicitly.
      </p>
      {busy && (
        <p role="status" className="muted">
          Updating sources…
        </p>
      )}
      {feedback && (
        <p className="notice" role="status">
          {feedback}
        </p>
      )}
      {error && (
        <div className="notice" role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setAttempt((v) => v + 1);
              setError("");
            }}
          >
            Retry sources
          </button>
        </div>
      )}
      {!data && !error && <p role="status">Loading sources…</p>}
      {data && (
        <>
          <div className="source-page-count">
            {data.total
              ? `${offset + 1}–${offset + data.items.length} of ${data.total} sources`
              : "No sources match this search"}
          </div>
          <div className="source-list">
            {data.items.map((source) => (
              <article
                className={`source-row ${!source.enabled ? "source-off" : ""}`}
                key={source.id}
              >
                <CollectionArtwork url={source.artworkUrl} kind="playlist" />
                <div className="source-identity">
                  <h3>{source.name}</h3>
                  <p>
                    {source.kind === "liked"
                      ? "Liked Songs"
                      : source.managed
                        ? "App-generated playlist"
                        : "Spotify playlist"}{" "}
                    ·{" "}
                    {source.lastSyncedAt !== null || source.importedCount > 0
                      ? `${source.uniqueCount.toLocaleString()} ${source.uniqueCount === 1 ? "song" : "songs"}${source.lastSyncedAt === null ? " imported so far" : ""}`
                      : `${source.trackCount.toLocaleString()} items reported`}
                  </p>
                  <p className="source-status">{state(source)}</p>
                  <small>
                    {source.lastSyncedAt
                      ? `Last synced ${new Date(source.lastSyncedAt).toLocaleString()}`
                      : "Not yet synced"}
                    {source.skippedCount > 0
                      ? ` · ${source.skippedCount} local or non-song items skipped`
                      : ""}
                  </small>
                  {source.spotifyUrl && (
                    <a
                      href={source.spotifyUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Spotify ↗
                    </a>
                  )}
                  {source.syncStatus === "error" && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void sync()}
                    >
                      Retry sync
                    </button>
                  )}
                </div>
                <label className="source-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={source.enabled}
                    disabled={busy || search !== query}
                    aria-label={`Include ${source.name}`}
                    onChange={(e) => void select(e.target.checked, source.id)}
                  />
                  <span>{source.enabled ? "On" : "Off"}</span>
                </label>
              </article>
            ))}
          </div>
          <nav className="source-pagination" aria-label="Sources pages">
            <button
              disabled={busy || offset === 0}
              onClick={() => {
                setOffset(Math.max(0, offset - 50));
                setData(null);
              }}
            >
              ← Previous
            </button>
            <button
              disabled={busy || offset + data.items.length >= data.total}
              onClick={() => {
                setOffset(offset + 50);
                setData(null);
              }}
            >
              Next →
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
