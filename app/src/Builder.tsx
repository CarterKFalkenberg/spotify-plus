import { useEffect, useRef, useState } from "react";
import {
  compileQueryBuilder,
  parseCreatePlaylist,
  type QueryBuilder,
  type QueryPreviewResponse,
  type TagDTO,
  type Retention,
  type CreatePlaylistRequest,
} from "../../supabase/functions/_shared/contracts";
import {
  api,
  preview,
  playlistMutation,
  errorMessage,
  rejectsIntent,
  ApiError,
} from "./api";
import { TagPicker } from "./TagPicker";
import { TrackSummary } from "./Library";
import { createIntentKey as intentKey } from "./intents";
function readIntent(): CreatePlaylistRequest | null {
  try {
    const raw = sessionStorage.getItem(intentKey);
    return raw ? parseCreatePlaylist(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function RetentionPicker({
  value,
  onChange,
  pinned = true,
  disabled = false,
  label = "Keep this playlist",
}: {
  value: Retention;
  onChange: (v: Retention) => void;
  pinned?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Retention)}
      >
        <option value="week">1 week</option>
        <option value="month">1 calendar month</option>
        <option value="threeMonths">3 calendar months</option>
        {pinned && <option value="pinned">Pinned — never expires</option>}
      </select>
    </label>
  );
}
export function Builder({
  initialComplete,
  refresh,
  onCreated,
}: {
  initialComplete: boolean;
  refresh: number;
  onCreated: () => void;
}) {
  const [buckets, setBuckets] = useState<
    Record<keyof QueryBuilder, readonly TagDTO[]>
  >({ all: [], any: [], none: [] });
  const [result, setResult] = useState<{
    key: string;
    refresh: number;
    value: QueryPreviewResponse;
  } | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [retention, setRetention] = useState<Retention>("month");
  const [busy, setBusy] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [paging, setPaging] = useState(false);
  const [pending, setPending] = useState<CreatePlaylistRequest | null>(
    readIntent,
  );
  const [submitted, setSubmitted] = useState(false);
  const version = useRef(0);
  const query = (() => {
    try {
      return compileQueryBuilder({
        all: buckets.all.map((t) => t.id),
        any: buckets.any.map((t) => t.id),
        none: buckets.none.map((t) => t.id),
      });
    } catch {
      return null;
    }
  })();
  const key = query ? JSON.stringify(query) : "";
  const queryRef = useRef(key);
  queryRef.current = key;
  const defaultName =
    [...buckets.all, ...buckets.any].map((t) => t.name).join(" + ") ||
    (buckets.none.length
      ? `Without ${buckets.none.map((t) => t.name).join(", ")}`
      : "My playlist");
  function edit(bucket: keyof QueryBuilder, items: readonly TagDTO[]) {
    version.current++;
    setResult(null);
    setError("");
    setSubmitted(false);
    setBuckets((v) => ({ ...v, [bucket]: items }));
  }
  useEffect(() => {
    const controller = new AbortController(),
      current = ++version.current;
    setResult(null);
    if (!key || pending) return () => controller.abort();
    const timer = setTimeout(() => {
      void api(
        "/query/preview",
        preview,
        { query: JSON.parse(key), cursor: null, limit: 50 },
        controller.signal,
      )
        .then((value) => {
          if (
            current === version.current &&
            JSON.stringify(value.query) === key
          ) {
            setResult({ key, refresh, value });
            setError("");
          } else if (current === version.current)
            setError(
              "The preview did not match your query. Update your tags and try again.",
            );
        })
        .catch((error) => {
          if (!controller.signal.aborted && current === version.current)
            setError(errorMessage(error));
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, refresh, pending, previewAttempt]);
  const matched =
    result?.key === key && result.refresh === refresh ? result.value : null;
  const canCreate =
    matched &&
    initialComplete &&
    matched.generationReady &&
    matched.playableCount > 0;
  async function create() {
    if (busy || (!pending && !canCreate)) return;
    setBusy(true);
    setError("");
    try {
      const intent =
        pending ??
        parseCreatePlaylist({
          requestId: crypto.randomUUID(),
          query,
          previewRevision: matched!.revision,
          name: name.trim() || defaultName,
          retention,
        });
      // Persist the exact intent before transmission. An ambiguous reply must retry
      // this UUID and body, even if the user reloads while the job is being accepted.
      sessionStorage.setItem(intentKey, JSON.stringify(intent));
      setPending(intent);
      const response = await api("/playlists", playlistMutation, intent);
      if (response.requestId !== intent.requestId)
        throw new Error("unconfirmed_intent");
      sessionStorage.removeItem(intentKey);
      setPending(null);
      setSubmitted(true);
      onCreated();
    } catch (error) {
      if (rejectsIntent(error)) {
        sessionStorage.removeItem(intentKey);
        setPending(null);
        setResult(null);
      }
      setReconnect(
        error instanceof ApiError &&
          (error.status === 401 ||
            error.code === "reconnect" ||
            error.code === "unauthorized"),
      );
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="builder" aria-labelledby="builder-title">
      <div className="section-heading">
        <div>
          <div className="eyebrow">SOMETHING FOR RIGHT NOW</div>
          <h2 id="builder-title">Make a playlist</h2>
        </div>
        <span className="pill">Private by default</span>
      </div>
      <p className="section-intro">
        Start with a feeling. Add your tags, see what fits, and take it to
        Spotify.
      </p>
      {pending ? (
        <div className="notice">
          <h3>Creation awaiting confirmation</h3>
          <p>
            “{pending.name}” may already be queued. Retry the saved request to
            find out safely.
          </p>
          <button disabled={busy} onClick={() => void create()}>
            {busy ? "Checking…" : "Retry saved create request"}
          </button>
        </div>
      ) : (
        <>
          <div className="query-buckets">
            {(["all", "any", "none"] as const).map((bucket, index) => (
              <div className="query-bucket" key={bucket}>
                <div className="bucket-heading">
                  <span className="bucket-number">0{index + 1}</span>
                  <h3>
                    {bucket === "all"
                      ? "All of"
                      : bucket === "any"
                        ? "Any of"
                        : "None of"}
                  </h3>
                  <small>
                    {bucket === "all"
                      ? "Every tag"
                      : bucket === "any"
                        ? "At least one"
                        : "Leave these out"}
                  </small>
                </div>
                <div className="chips">
                  {buckets[bucket].map((tag) => (
                    <button
                      className="chip"
                      key={tag.id}
                      aria-label={`Remove ${tag.name} from ${bucket}`}
                      onClick={() =>
                        edit(
                          bucket,
                          buckets[bucket].filter((t) => t.id !== tag.id),
                        )
                      }
                    >
                      {tag.name} ×
                    </button>
                  ))}
                </div>
                <TagPicker
                  label={`Add ${bucket === "all" ? "All of" : bucket === "any" ? "Any of" : "None of"} tag`}
                  onChoose={(tag) => {
                    if (!buckets[bucket].some((t) => t.id === tag.id))
                      edit(bucket, [...buckets[bucket], tag]);
                  }}
                />
              </div>
            ))}
          </div>
          <div className="preview-panel" aria-live="polite">
            {!key ? (
              <div className="empty-state">
                <h3>Your next playlist starts here</h3>
                <p>Add at least one tag to see the songs that fit.</p>
              </div>
            ) : !matched && !error ? (
              <p role="status">Finding matching songs…</p>
            ) : (
              matched && (
                <>
                  <div className="preview-heading">
                    <div>
                      <strong>{matched.playableCount} songs</strong>
                      <span>
                        {Math.floor(matched.durationMs / 3600000)}h{" "}
                        {Math.floor(matched.durationMs / 60000) % 60}m · from
                        your cached library
                      </span>
                    </div>
                    <span className="preview-label">PREVIEW</span>
                  </div>
                  {matched.excludedCount > 0 && (
                    <p className="notice">
                      {matched.excludedCount} unavailable{" "}
                      {matched.excludedCount === 1 ? "song is" : "songs are"}{" "}
                      excluded from this playlist ({matched.matchedCount} total
                      matches).
                    </p>
                  )}
                  {matched.matchedCount === 0 && (
                    <p className="empty-state">
                      No songs have this combination of tags. Try removing a
                      requirement.
                    </p>
                  )}
                  <div className="preview-tracks">
                    {matched.tracks.map((track) => (
                      <TrackSummary key={track.trackKey} track={track} />
                    ))}
                  </div>
                  {matched.nextCursor && (
                    <button
                      disabled={paging}
                      onClick={async () => {
                        const capturedKey = key,
                          capturedVersion = version.current;
                        setPaging(true);
                        try {
                          const next = await api("/query/preview", preview, {
                            query,
                            cursor: matched.nextCursor,
                            limit: 50,
                          });
                          if (
                            capturedKey !== queryRef.current ||
                            capturedVersion !== version.current
                          )
                            return;
                          if (
                            JSON.stringify(next.query) !== capturedKey ||
                            JSON.stringify(next.revision) !==
                              JSON.stringify(matched.revision)
                          )
                            throw new Error("stale_page");
                          setResult({
                            key: capturedKey,
                            refresh,
                            value: {
                              ...next,
                              tracks: [...matched.tracks, ...next.tracks],
                            },
                          });
                        } catch (error) {
                          if (capturedVersion === version.current) {
                            setResult(null);
                            setError(errorMessage(error));
                          }
                        } finally {
                          setPaging(false);
                        }
                      }}
                    >
                      {paging ? "Loading…" : "More preview songs"}
                    </button>
                  )}
                </>
              )
            )}
          </div>
          {!initialComplete && (
            <p className="notice">
              Your first import is still being verified. Browse and tag now;
              playlist creation unlocks after the complete library is ready.
            </p>
          )}
          <form
            className="create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label>
              Playlist name
              <input
                value={name}
                placeholder={defaultName}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <RetentionPicker value={retention} onChange={setRetention} />
            <button className="primary" disabled={!canCreate || busy}>
              {busy ? "Requesting…" : "Create playlist →"}
            </button>
          </form>
          <p className="disclosure">
            We ask Spotify to hide the playlist from your profile and search.
            Anyone with its link can still access it. Spotify acknowledges the
            request; hiding cannot be independently verified. The query and
            expiry date appear in Spotify’s description. Playlists are
            snapshots. Regenerate replaces manual track edits; expiry removes
            the playlist from Your Library. Pin it to keep it.
          </p>
        </>
      )}
      {error && (
        <div role="alert" className="notice">
          {error}{" "}
          {reconnect && <a href="/auth/spotify/start">Reconnect Spotify</a>}
          {!pending && key && (
            <button
              disabled={busy || paging}
              onClick={() => {
                version.current++;
                setResult(null);
                setError("");
                setPreviewAttempt((value) => value + 1);
              }}
            >
              Retry preview
            </button>
          )}
        </div>
      )}
      {submitted && (
        <p role="status" className="notice">
          Playlist request accepted. Follow its progress in Your playlists; it
          is ready only after Spotify confirms the contents.
        </p>
      )}
    </section>
  );
}
