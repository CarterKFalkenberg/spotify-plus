import { useEffect, useRef, useState } from "react";
import type {
  PlaylistListResponse,
  ManagedPlaylistDTO,
  Retention,
  PlaylistActionRequest,
  QueryNode,
} from "../../supabase/functions/_shared/contracts";
import {
  api,
  playlists,
  playlistMutation,
  tags,
  blockMessage,
  errorMessage,
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
export function Playlists({ refresh }: { refresh: number }) {
  const [data, setData] = useState<PlaylistListResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ManagedPlaylistDTO | null>(null);
  const [period, setPeriod] = useState<Retention>("month");
  const [tagNames, setTagNames] = useState<Record<string, string>>({});
  const intents = useRef(new Map<string, PlaylistActionRequest>());
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirm) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirm]);
  useEffect(() => {
    const controller = new AbortController();
    void api("/tags?limit=100", tags, undefined, controller.signal)
      .then((v) =>
        setTagNames(Object.fromEntries(v.tags.map((t) => [t.id, t.name]))),
      )
      .catch(() => {});
    return () => controller.abort();
  }, [refresh]);
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
  function renderQuery(node: QueryNode): string {
    return node.op === "tag"
      ? (tagNames[node.tagId] ?? "Tag")
      : node.op === "not"
        ? `NOT ${renderQuery(node.child)}`
        : `(${node.children.map(renderQuery).join(node.op === "and" ? " + " : " OR ")})`;
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
      const result = await api(
        `/playlists/${item.id}/actions`,
        playlistMutation,
        intent,
      );
      if (result.requestId !== intent.requestId)
        throw new Error("unconfirmed_intent");
      intents.current.delete(item.id);
      setConfirm(null);
      setAttempt((v) => v + 1);
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 401, 403, 409].includes(error.status)
      )
        intents.current.delete(item.id);
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
      {error && (
        <p role="alert" className="notice">
          {error}
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
