import { useEffect, useRef, useState } from "react";
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
  lookupTags,
  blockMessage,
  errorMessage,
  rejectsIntent,
  ApiError,
} from "./api";
import { RetentionPicker } from "./Builder";
function date(value: string) {
  return new Date(
    value.length === 10 ? `${value}T12:00:00Z` : value,
  ).toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "America/New_York",
  });
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
export function Playlists({ refresh }: { refresh: number }) {
  const [data, setData] = useState<PlaylistListResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ManagedPlaylistDTO | null>(null);
  const [period, setPeriod] = useState<Retention>("month");
  const lookupConflict = useRef<string | null>(null);
  const [tagError, setTagError] = useState("");
  const [tagNames, setTagNames] = useState<Record<string, string>>({});
  const intents = useRef(readIntents());
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirm]);
  useEffect(() => {
    const controller = new AbortController();
    function ids(node: QueryNode): string[] {
      return node.op === "tag"
        ? [node.tagId]
        : node.op === "not"
          ? ids(node.child)
          : node.children.flatMap(ids);
    }
    void lookupTags(
      data?.playlists.flatMap((item) => ids(item.query.root)) ?? [],
      controller.signal,
    )
      .then((resolved) => {
        if (!controller.signal.aborted) {
          setTagError("");
          setTagNames(
            Object.fromEntries(resolved.map((tag) => [tag.id, tag.name])),
          );
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setTagNames({});
          setTagError(errorMessage(error));
          if (error instanceof ApiError && error.code === "unknown_tag") {
            const key = JSON.stringify(
              data?.playlists.map((item) => item.query),
            );
            if (lookupConflict.current !== key) {
              lookupConflict.current = key;
              setCursor(null);
              setAttempt((value) => value + 1);
            }
          }
        }
      });
    return () => controller.abort();
  }, [data]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await api(
          `/playlists?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          playlists,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setData(next);
        setError("");
        timer = setTimeout(() => void load(), 5000);
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, cursor, attempt]);
  function renderQuery(node: QueryNode): string | null {
    if (node.op === "tag") return tagNames[node.tagId] ?? null;
    if (node.op === "not") {
      const child = renderQuery(node.child);
      return child === null ? null : `NOT ${child}`;
    }
    const children = node.children.map(renderQuery);
    return children.some((child) => child === null)
      ? null
      : `(${children.join(node.op === "and" ? " + " : " OR ")})`;
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
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
            <p className="query-summary">
              {renderQuery(item.query.root) || "Resolving query tags…"}
            </p>
            <p className="expiry">
              {item.expiresOn === null
                ? "Pinned · never expires"
                : item.expiresOn < today
                  ? "Expired — will be removed"
                  : `Keep through ${date(item.expiresOn)}`}
            </p>
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
                        disabled={!!busy}
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
