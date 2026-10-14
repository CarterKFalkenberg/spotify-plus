import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  PlaylistListResponse,
  ManagedPlaylistDTO,
  Retention,
  PlaylistActionRequest,
  QueryNode,
  parsePlaylistAction,
  parseId,
} from "../../supabase/functions/_shared/contracts";
import {
  api,
  playlists,
  playlistMutation,
  blockMessage,
  errorMessage,
  rejectsIntent,
  ApiError,
} from "./api";
import { RetentionPicker } from "./Builder";
import { useVisiblePolling } from "./useVisiblePolling";
import {
  expiryDays,
  queryTagIds,
  resolvePlaylistLabels,
} from "./playlist-labels";
function date(value: string) {
  return new Date(
    value.length === 10 ? `${value}T12:00:00Z` : value,
  ).toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "America/New_York",
  });
}
function expiryText(value: string | null) {
  if (value === null) return "Pinned · never expires";
  const days = expiryDays(value);
  if (days < 0) return "Expired — will be removed";
  const countdown =
    days === 0
      ? "Expires today"
      : `Expires in ${days} ${days === 1 ? "day" : "days"}`;
  return `${countdown} · Keep through ${date(value)}`;
}
import { playlistIntentKey as intentKey } from "./intents";
function readIntents(): Map<string, PlaylistActionRequest> {
  try {
    const raw = sessionStorage.getItem(intentKey);
    return new Map(
      raw
        ? JSON.parse(raw).map(([id, intent]: [string, unknown]) => [
            parseId(id),
            parsePlaylistAction(intent),
          ])
        : [],
    );
  } catch {
    return new Map();
  }
}
export function Playlists({
  refresh,
  active = true,
  vocabularyRefresh = "0",
}: {
  refresh: number;
  active?: boolean;
  vocabularyRefresh?: string;
}) {
  const [data, setData] = useState<PlaylistListResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ManagedPlaylistDTO | null>(null);
  const [period, setPeriod] = useState<Retention>("month");
  const lookupConflict = useRef<string | null>(null);
  const resolvedTags = useRef<string | null>(null);
  const [tagError, setTagError] = useState("");
  const [tagRetry, setTagRetry] = useState(0);
  const [missingTags, setMissingTags] = useState<string[]>([]);
  const [unavailableTags, setUnavailableTags] = useState<string[]>([]);
  const [tagNames, setTagNames] = useState<Record<string, string>>({});
  const intents = useRef(readIntents());
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirm]);
  const tagIdsKey = JSON.stringify(
    [
      ...new Set(
        data?.playlists.flatMap((item) => queryTagIds(item.query.root)) ?? [],
      ),
    ].sort(),
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const tagIds: string[] = JSON.parse(tagIdsKey);
    const key = JSON.stringify([tagIds, vocabularyRefresh]);
    if (resolvedTags.current === key) return;
    void resolvePlaylistLabels(tagIds, controller.signal)
      .then((resolved) => {
        if (!controller.signal.aborted) {
          resolvedTags.current = key;
          setTagError("");
          setMissingTags(resolved.missing);
          setUnavailableTags(resolved.unavailable);
          setTagNames(
            Object.fromEntries(resolved.tags.map((tag) => [tag.id, tag.name])),
          );
          if (resolved.missing.length || resolved.unavailable.length) {
            const queryKey = tagIdsKey;
            if (lookupConflict.current !== queryKey) {
              lookupConflict.current = queryKey;
              setAttempt((value) => value + 1);
            }
          }
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setTagError(errorMessage(error));
        }
      });
    return () => controller.abort();
  }, [tagIdsKey, active, vocabularyRefresh, attempt, tagRetry]);
  useVisiblePolling({
    enabled: active,
    refreshKey: JSON.stringify([refresh, cursor, attempt]),
    load: (signal) =>
      api(
        `/playlists?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        playlists,
        undefined,
        signal,
      ),
    receive: (next) => {
      setData(next);
      setError("");
      if (tagError) setTagRetry((value) => value + 1);
    },
    working: (next) =>
      next.playlists.some(
        (item) =>
          !item.blockedBy &&
          (item.status === "pending" || item.status === "removing"),
      ),
    onError: (error) => setError(errorMessage(error)),
  });
  function renderQuery(node: QueryNode): ReactNode {
    if (node.op === "tag")
      return (
        <span className="chip">
          {missingTags.includes(node.tagId)
            ? "Deleted tag"
            : unavailableTags.includes(node.tagId)
              ? "Unavailable tag"
              : (tagNames[node.tagId] ??
                (tagError ? "Unavailable tag" : "Resolving query tags…"))}
        </span>
      );
    if (node.op === "not") return <>NOT {renderQuery(node.child)}</>;
    return (
      <>
        (
        {node.children.map((child, index) => (
          <Fragment key={index}>
            {index > 0 && (node.op === "and" ? " + " : " OR ")}
            {renderQuery(child)}
          </Fragment>
        ))}
        )
      </>
    );
  }
  async function act(
    item: ManagedPlaylistDTO,
    action: PlaylistActionRequest["action"],
  ) {
    if (busy) return;
    setBusy(item.id);
    setError("");
    try {
      const intent =
        intents.current.get(item.id) ??
        ({
          requestId: crypto.randomUUID(),
          expectedRevision: item.revision,
          action,
          ...(action === "extend" || action === "unpin"
            ? { retention: period as "week" | "month" | "threeMonths" }
            : {}),
        } as PlaylistActionRequest);
      intents.current.set(item.id, intent);
      sessionStorage.setItem(intentKey, JSON.stringify([...intents.current]));
      const result = await api(
        `/playlists/${item.id}/actions`,
        playlistMutation,
        intent,
      );
      if (result.requestId !== intent.requestId)
        throw new Error("unconfirmed_intent");
      intents.current.delete(item.id);
      sessionStorage.setItem(intentKey, JSON.stringify([...intents.current]));
      setConfirm(null);
      setAttempt((v) => v + 1);
    } catch (error) {
      if (rejectsIntent(error)) {
        intents.current.delete(item.id);
        sessionStorage.setItem(intentKey, JSON.stringify([...intents.current]));
      }
      setReconnect(
        error instanceof ApiError &&
          (error.status === 401 ||
            error.code === "reconnect" ||
            error.code === "unauthorized"),
      );
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  const stale =
    !data?.lastCleanupAt ||
    Date.now() - Date.parse(data.lastCleanupAt) > 86400000;
  return (
    <section aria-labelledby="playlists-title">
      <div className="section-heading">
        <div>
          <div className="eyebrow">READY FOR THE MOMENT</div>
          <h2 id="playlists-title">Your playlists</h2>
        </div>
        <button
          className="compact"
          onClick={() => {
            resolvedTags.current = null;
            setCursor(null);
            setAttempt((v) => v + 1);
          }}
        >
          Refresh playlists
        </button>
      </div>
      <p className={stale || data?.cleanupBlockedBy ? "notice" : "muted"}>
        Last successful cleanup:{" "}
        {data?.lastCleanupAt ? date(data.lastCleanupAt) : "not yet confirmed"}.
        {stale &&
          " Cleanup may be delayed; free hosting can pause. Overdue work resumes when service recovers."}
        {data?.cleanupBlockedBy && ` ${blockMessage[data.cleanupBlockedBy]}`}
      </p>
      {tagError && (
        <p role="alert" className="notice">
          {tagError} Refresh playlists to resolve the current query tags.
        </p>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}{" "}
          {reconnect && <a href="/auth/spotify/start">Reconnect Spotify</a>}
        </p>
      )}
      {!data && !error && <p role="status">Loading playlists…</p>}
      {data?.playlists.length === 0 && (
        <div className="empty-state">
          <h3>A little less clutter</h3>
          <p>
            Playlists you create here will appear here, with their expiry date
            and a way to keep the good ones.
          </p>
        </div>
      )}
      <div className="playlist-grid">
        {data?.playlists.map((item) => (
          <article className="playlist-card" key={item.id}>
            <div className="playlist-card-top">
              <span className={`pill ${item.status}`}>
                {item.status === "ready"
                  ? "Ready"
                  : item.status === "incomplete"
                    ? "Incomplete — retry"
                    : item.status === "removing"
                      ? "Removal awaiting confirmation"
                      : "Queued / working"}
              </span>
              <span className="muted">
                {item.trackCount} songs
                {item.status !== "ready" ? " targeted" : ""}
              </span>
            </div>
            <h3>{item.name}</h3>
            <p className="query-summary">{renderQuery(item.query.root)}</p>
            {queryTagIds(item.query.root).some(
              (id) => missingTags.includes(id) || unavailableTags.includes(id),
            ) && (
              <p className="notice">
                A query tag is deleted or its label is unavailable. Refresh
                playlists to retry label lookup. Deleted tags must be replaced
                before regeneration.
              </p>
            )}
            <p className="expiry">{expiryText(item.expiresOn)}</p>
            <p className="muted">Created {date(item.createdAt)}</p>
            {item.blockedBy && (
              <p className="notice">{blockMessage[item.blockedBy]}</p>
            )}
            <div className="playlist-actions">
              {item.spotifyUrl && (
                <a
                  className="button"
                  href={item.spotifyUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Spotify ↗
                </a>
              )}
              {intents.current.has(item.id) ? (
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void act(item, intents.current.get(item.id)!.action)
                  }
                >
                  Retry unconfirmed action
                </button>
              ) : (
                <>
                  {item.status === "incomplete" && (
                    <button
                      disabled={!!busy}
                      onClick={() => void act(item, "retry")}
                    >
                      Retry
                    </button>
                  )}
                  {item.status === "ready" && (
                    <>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          void act(
                            item,
                            item.retention === "pinned" ? "unpin" : "pin",
                          )
                        }
                      >
                        {item.retention === "pinned" ? "Unpin" : "Pin"}
                      </button>
                      {item.retention !== "pinned" && (
                        <button
                          disabled={!!busy}
                          onClick={() => void act(item, "extend")}
                        >
                          Extend
                        </button>
                      )}
                      <button
                        disabled={
                          !!busy ||
                          queryTagIds(item.query.root).some((id) =>
                            missingTags.includes(id),
                          )
                        }
                        onClick={() => void act(item, "regenerate")}
                      >
                        Regenerate
                      </button>
                    </>
                  )}
                  {(item.status === "ready" ||
                    item.status === "incomplete") && (
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => setConfirm(item)}
                    >
                      Delete now
                    </button>
                  )}
                </>
              )}
            </div>
          </article>
        ))}
      </div>
      {!!data?.playlists.length && (
        <div className="extension-setting">
          <RetentionPicker
            pinned={false}
            label="Extend / Unpin for"
            value={period}
            onChange={setPeriod}
          />
          <p className="muted">
            Extend resets the clock; Unpin starts a new one. Regenerate uses the
            existing retention and keeps your current Spotify name.
          </p>
        </div>
      )}
      {data?.nextCursor && (
        <button onClick={() => setCursor(data.nextCursor)}>
          More playlists
        </button>
      )}
      {cursor && (
        <button onClick={() => setCursor(null)}>First playlists</button>
      )}
      <dialog
        ref={dialog}
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setConfirm(null);
        }}
        className="dialog"
      >
        <h2>Remove this playlist from Your Library?</h2>
        <p>
          “{confirm?.name}” will be removed from your Spotify library. Its
          Spotify URL or other followers may remain. Your Liked Songs are never
          changed.
        </p>
        <div className="dialog-actions">
          <button autoFocus disabled={!!busy} onClick={() => setConfirm(null)}>
            Keep playlist
          </button>
          <button
            className="danger"
            disabled={!!busy}
            onClick={() => confirm && void act(confirm, "delete")}
          >
            Confirm removal
          </button>
        </div>
      </dialog>
    </section>
  );
}
