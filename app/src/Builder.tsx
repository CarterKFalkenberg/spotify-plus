import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  compileQueryBuilder,
  CONTRACT_LIMITS,
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
  poolEmpty = false,
  onSources,
  refresh,
  onCreated,
  onViewPlaylists,
  onTagLibrary,
}: {
  initialComplete: boolean;
  poolEmpty?: boolean;
  onSources?: () => void;
  refresh: number;
  onCreated: () => void;
  onViewPlaylists: () => void;
  onTagLibrary: () => void;
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
  const [name, setName] = useState<string | null>(null);
  const [retention, setRetention] = useState<Retention>("month");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [refinements, setRefinements] = useState(false);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const stageMounted = useRef(false);
  useLayoutEffect(() => {
    if (stageMounted.current) stageHeading.current?.focus();
    else stageMounted.current = true;
  }, [step]);
  function go(next: 0 | 1 | 2) {
    setStep(next);
  }
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
  const suggestedName =
    [...buckets.all, ...buckets.any].map((t) => t.name).join(" + ") ||
    (buckets.none.length
      ? `Without ${buckets.none.map((t) => t.name).join(", ")}`
      : "My playlist");
  const defaultName = [...suggestedName.normalize("NFC")]
    .slice(0, CONTRACT_LIMITS.playlistNameLength)
    .join("")
    .trimEnd();
  function edit(bucket: keyof QueryBuilder, items: readonly TagDTO[]) {
    version.current++;
    setResult(null);
    setError("");
    setSubmitted(false);
    setStep(0);
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
          name: name?.trim() || defaultName,
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
        setStep(0);
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
      {poolEmpty && (
        <p className="notice">
          Your enabled song pool is empty.{" "}
          <button onClick={onSources}>Choose Sources</button>
        </p>
      )}
      <div className="section-heading">
        <div>
          <h2 id="builder-title">Make a playlist</h2>
        </div>
        <span className="pill information">
          Request hidden from profile &amp; search
        </span>
      </div>
      <p className="section-intro">
        Your tags become a playlist. Choose a mood, check the songs, and decide
        how long to keep it.
      </p>
      {!pending && !submitted && (
        <>
          <ol className="builder-steps" aria-label="Playlist progress">
            {["Choose tags", "Review songs", "Name & keep"].map(
              (label, index) => (
                <li
                  key={label}
                  aria-current={step === index ? "step" : undefined}
                >
                  <span>{index + 1}</span>
                  {label}
                </li>
              ),
            )}
          </ol>
          <h3
            className="builder-stage-title sr-only"
            tabIndex={-1}
            ref={stageHeading}
          >
            {
              [
                "What do you want to hear?",
                "Does this sound right?",
                "Make it yours",
              ][step]
            }
          </h3>
        </>
      )}
      {!key && !pending && (
        <p className="builder-start">
          Need tags first?{" "}
          <button className="text-button" onClick={onTagLibrary}>
            Tag your library →
          </button>
        </p>
      )}
      {submitted && (
        <div role="status" className="notice creation-confirmation">
          <strong>Playlist request accepted.</strong>
          <p>
            Spotify is preparing the playlist. It is ready only after Spotify
            confirms the contents.
          </p>
          <button className="primary" onClick={onViewPlaylists}>
            View playlist progress →
          </button>
          <button
            onClick={() => {
              if (pending || busy) return;
              version.current++;
              setBuckets({ all: [], any: [], none: [] });
              setName(null);
              setRetention("month");
              setResult(null);
              setError("");
              setSubmitted(false);
              setRefinements(false);
              go(0);
            }}
          >
            Make another playlist
          </button>
        </div>
      )}
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
          <div className="builder-layout" hidden={submitted}>
            <div className="query-feedback" role="status" aria-live="polite">
              {!key ? (
                <strong>Add a tag to start</strong>
              ) : !matched && !error ? (
                <strong>Finding matching songs…</strong>
              ) : matched ? (
                <>
                  <strong>
                    {matched.playableCount}{" "}
                    {matched.playableCount === 1 ? "song" : "songs"}{" "}
                    <span>
                      · {Math.floor(matched.durationMs / 3600000)}h{" "}
                      {Math.floor(matched.durationMs / 60000) % 60}m
                    </span>
                  </strong>
                  {matched.playableCount === 0 && (
                    <p>
                      No playable songs match. Try fewer All of tags or remove
                      an exclusion.
                    </p>
                  )}
                  {matched.excludedCount > 0 && step !== 1 && (
                    <small>
                      {matched.excludedCount} unavailable{" "}
                      {matched.excludedCount === 1
                        ? "song excluded"
                        : "songs excluded"}
                    </small>
                  )}
                </>
              ) : (
                <strong>Preview needs attention</strong>
              )}
              {!initialComplete ? (
                <p className="builder-readiness">
                  Your enabled sources are still being imported and verified.
                  You can choose tags and review songs now; playlist creation
                  unlocks when the complete library is ready.
                </p>
              ) : matched && !matched.generationReady ? (
                <p className="builder-readiness">
                  Library verification is still in progress. You can review
                  these songs; playlist creation unlocks when verification
                  finishes.
                </p>
              ) : null}
            </div>
            <div
              className="query-composer builder-stage"
              data-step="choose"
              hidden={step !== 0 || submitted}
            >
              <p className="composer-title">
                Start with tags every song should have. Refine the match if you
                need to.
              </p>
              <div className="query-buckets">
                {(["all", "any", "none"] as const).map((bucket) => (
                  <div
                    className="query-bucket"
                    key={bucket}
                    hidden={bucket !== "all" && !refinements}
                  >
                    <div className="bucket-heading">
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
                <button
                  className="text-button refine-query"
                  aria-expanded={refinements}
                  onClick={() => setRefinements(!refinements)}
                >
                  {refinements
                    ? "Hide refinements"
                    : "Refine with Any of / None of"}
                  {!refinements && buckets.any.length + buckets.none.length > 0
                    ? ` · ${buckets.any.length + buckets.none.length} tags`
                    : ""}
                </button>
              </div>
            </div>
            <section
              className="preview-panel builder-stage"
              data-step="review"
              hidden={step !== 1 || submitted}
              id="playlist-preview"
            >
              <h3 className="sr-only">Review matching songs</h3>
              {!key ? (
                <div className="empty-state">
                  <h3>Choose your first tag</h3>
                  <p>
                    Add at least one tag to see the songs that fit. No tags yet?
                    Start by tagging a few songs or a whole artist.
                  </p>
                </div>
              ) : !matched && !error ? (
                <p role="status">Finding matching songs…</p>
              ) : (
                matched && (
                  <>
                    <div className="preview-heading">
                      <div>
                        <span>Matching songs · newest added first</span>
                      </div>
                      <span className="preview-label">Preview</span>
                    </div>
                    {matched.excludedCount > 0 && (
                      <p className="notice">
                        {matched.excludedCount} unavailable{" "}
                        {matched.excludedCount === 1 ? "song is" : "songs are"}{" "}
                        excluded from this playlist ({matched.matchedCount}{" "}
                        total matches).
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
            </section>
            <div
              className="playlist-setup builder-stage"
              data-step="details"
              hidden={step !== 2 || submitted}
            >
              <div className="create-heading">
                <h3>Playlist details</h3>
              </div>
              <form
                id="create-playlist-form"
                className="create-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
              >
                <label>
                  Playlist name
                  <input
                    value={name ?? defaultName}
                    placeholder={defaultName}
                    maxLength={CONTRACT_LIMITS.playlistNameLength}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <RetentionPicker value={retention} onChange={setRetention} />
              </form>
              <p className="disclosure creation-summary">
                {retention === "pinned"
                  ? "Pinned: stays until you remove it."
                  : "Removed from your Spotify library after the selected retention. Pin it later to keep it."}{" "}
                Anyone with the Spotify link can access it.
              </p>
              <details className="creation-disclosure">
                <summary>Spotify visibility &amp; playlist details</summary>
                <p className="disclosure">
                  We ask Spotify to hide the playlist from your profile and
                  search. Anyone with its link can still access it. Spotify
                  acknowledges the request; hiding cannot be independently
                  verified. The query and expiry date appear in Spotify’s
                  description. Playlists are snapshots. Regenerate replaces
                  manual track edits; expiry removes the playlist from Your
                  Library. Pin it to keep it.
                </p>
              </details>
            </div>
          </div>
          {!submitted && (
            <div className="builder-navigation">
              <button
                disabled={step === 0 || busy}
                onClick={() => go(step === 2 ? 1 : 0)}
              >
                ← Back
              </button>
              {step < 2 ? (
                <button
                  key="continue"
                  type="button"
                  className="primary"
                  disabled={busy || (step === 0 ? !key : !canCreate)}
                  onClick={(event) => {
                    event.preventDefault();
                    go(step === 0 ? 1 : 2);
                  }}
                >
                  {step === 0 ? "Review songs →" : "Playlist details →"}
                </button>
              ) : (
                <button
                  className="primary"
                  key="create"
                  type="submit"
                  form="create-playlist-form"
                  disabled={!canCreate || busy}
                >
                  {busy ? "Requesting…" : "Create playlist →"}
                </button>
              )}
            </div>
          )}
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
    </section>
  );
}
