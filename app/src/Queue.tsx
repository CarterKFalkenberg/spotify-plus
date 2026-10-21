import { useEffect, useRef, useState } from "react";
import type {
  TrackDTO,
  TagDTO,
  LibraryStatusDTO,
  Selection,
} from "../../supabase/functions/_shared/contracts";
import {
  api,
  ApiError,
  tagAction,
  undoAction,
  errorMessage,
  lookupTags,
} from "./api";
import {
  search,
  vocabulary,
  sameRevision,
  acknowledged,
  type FastFilter,
  type Sort,
} from "./fast-api";
import { emptyFilter, TrackSummary } from "./Library";
import { QueuePlayback } from "./QueuePlayback";
import { TagPicker } from "./TagPicker";
import {
  queueShortcut,
  skipToTail,
  quickSlots,
  refreshQuickRank,
  preserveCurrent,
  ownedPatchRevision,
  restoredQueueTags,
} from "./tagging";
export function Queue({
  refresh,
  active,
  playbackAllowed,
  status,
  source,
  onChanged,
  onArtist,
}: {
  refresh: number;
  active: boolean;
  playbackAllowed: boolean;
  status: LibraryStatusDTO | null;
  source: FastFilter | Selection | null;
  onChanged: () => void;
  onArtist: (id: string) => void;
}) {
  const [mode, setMode] = useState("newest");
  const [rows, setRows] = useState<TrackDTO[]>([]),
    [index, setIndex] = useState(0);
  const [frequent, setFrequent] = useState<readonly (TagDTO | undefined)[]>([]),
    [pinned, setPinned] = useState<Record<number, TagDTO>>({});
  const [known, setKnown] = useState<readonly TagDTO[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [help, setHelp] = useState(false),
    [sheet, setSheet] = useState(false),
    [pinSlot, setPinSlot] = useState<number | null>(null);
  const [editingSlots, setEditingSlots] = useState(false);
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width:640px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width:640px)");
    const update = () => {
      setMobile(media.matches);
      setSheet(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const hasCurrent = !!rows[index];
  const [actions, setActions] = useState<
    {
      id: string;
      key: string;
      tagId: string;
      kind: "add" | "remove";
      changed: boolean;
      tagName: string;
    }[]
  >([]);
  const [tagged, setTagged] = useState(new Set<string>());
  const seed = useRef(crypto.randomUUID()),
    container = useRef<HTMLDivElement>(null),
    touch = useRef<{ x: number; y: number } | null>(null);
  const sheetElement = useRef<HTMLDialogElement | null>(null);
  const originatingCard = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!active) setSheet(false);
  }, [active]);
  useEffect(() => {
    const element = sheetElement.current;
    if (!element || !hasCurrent || !active) return;
    const modal = mobile && sheet;
    const oldOverflow = document.body.style.overflow;
    if (modal) {
      document.body.style.overflow = "hidden";
      element.showModal();
    } else if (!mobile) element.show();
    return () => {
      element.close();
      if (modal) {
        document.body.style.overflow = oldOverflow;
        originatingCard.current?.focus();
      }
    };
  }, [sheet, mobile, hasCurrent, active]);
  useEffect(() => {
    if (!hasCurrent) setSheet(false);
  }, [hasCurrent]);
  const syncedRevision = useRef<LibraryStatusDTO["revision"] | null>(null);
  const queueKeys = useRef(new Set<string>());
  const [retry, setRetry] = useState(0);
  const helpDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (help) helpDialog.current?.showModal();
    else helpDialog.current?.close();
  }, [help]);
  const current = rows[index];
  const lastAction = actions.at(-1);
  const feedbackTarget =
    lastAction?.key === current?.trackKey
      ? "this song"
      : "the previously edited song";
  const savedFeedback = lastAction
    ? lastAction.changed
      ? `${lastAction.kind === "add" ? "Added" : "Removed"} “${lastAction.tagName}” ${lastAction.kind === "add" ? "to" : "from"} ${feedbackTarget} · Saved`
      : `“${lastAction.tagName}” ${lastAction.kind === "add" ? "is already on" : "was already removed from"} ${feedbackTarget}`
    : "";

  const rowsRef = useRef(rows),
    indexRef = useRef(index),
    generation = useRef(0);
  rowsRef.current = rows;
  indexRef.current = index;
  const slots = quickSlots(frequent, pinned);
  useEffect(() => {
    const c = new AbortController();
    void api(
      "/tags/vocabulary",
      vocabulary,
      { search: "", sort: "mostUsed", cursor: null, limit: 30 },
      c.signal,
    )
      .then((v) => setFrequent((old) => refreshQuickRank(old, v.tags)))
      .catch((e) => {
        if (!c.signal.aborted) setError(errorMessage(e));
      });
    return () => c.abort();
  }, [refresh]);
  // Pins retain identities, while global vocabulary edits update their labels.
  useEffect(() => {
    const ids = [
      ...new Set(
        [
          ...Object.values(pinned),
          ...frequent.filter((t): t is TagDTO => !!t),
        ].map((t) => t.id),
      ),
    ];
    if (!ids.length) return;
    const c = new AbortController();
    async function resolve() {
      let live: TagDTO[];
      try {
        live = await lookupTags(ids, c.signal);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "unknown_tag")) throw e;
        const individually = await Promise.all(
          ids.map(async (id) => {
            try {
              return (await lookupTags([id], c.signal))[0] ?? null;
            } catch (e) {
              if (e instanceof ApiError && e.code === "unknown_tag")
                return null;
              throw e;
            }
          }),
        );
        live = individually.filter((t): t is TagDTO => t !== null);
      }
      if (!c.signal.aborted) {
        setFrequent((old) =>
          old.map((tag) =>
            tag && ids.includes(tag.id)
              ? live.find((t) => t.id === tag.id)
              : tag,
          ),
        );
        setPinned((old) =>
          Object.fromEntries(
            Object.entries(old).flatMap(([slot, t]) => {
              if (!ids.includes(t.id)) return [[slot, t]];
              const fresh = live.find((v) => v.id === t.id);
              return fresh ? [[slot, fresh]] : [];
            }),
          ),
        );
      }
    }
    void resolve().catch((e) => {
      if (!c.signal.aborted) setError(errorMessage(e));
    });
    return () => c.abort();
  }, [refresh]);
  useEffect(() => {
    const c = new AbortController();
    const ownGeneration = ++generation.current;
    setLoading(true);
    setError("");
    setIndex(0);
    setRows([]);
    queueKeys.current = new Set();
    const filter: FastFilter = (source && !("kind" in source)
      ? source
      : source?.kind === "filter"
        ? source.filter
        : null) ?? {
      ...emptyFilter,
      untagged:
        source && "kind" in source && source.kind === "tracks"
          ? false
          : mode !== "latest",
      latestSyncOnly: mode === "latest",
    };
    const sort: Sort =
      mode === "oldest" ? "oldest" : mode === "random" ? "random" : "newest";
    async function load() {
      let cursor: string | null = null;
      const all: TrackDTO[] = [];
      let revision: LibraryStatusDTO["revision"] | null = null;
      do {
        const v: ReturnType<typeof search> = await api(
          "/library/search",
          search,
          {
            filter,
            groupBy: null,
            sort,
            seed: sort === "random" ? seed.current : null,
            cursor,
            limit: 100,
          },
          c.signal,
        );
        if (v.groupBy !== null) throw Error();
        if (
          source &&
          "kind" in source &&
          source.kind === "filter" &&
          !sameRevision(source.expectedRevision, v.revision)
        )
          throw new ApiError("stale_revision", 409);
        revision = v.revision;
        all.push(
          ...v.tracks.filter(
            (t) =>
              !source ||
              !("kind" in source) ||
              source.kind !== "tracks" ||
              source.trackKeys.includes(t.trackKey),
          ),
        );
        cursor = v.nextCursor;
      } while (cursor && !c.signal.aborted);
      if (!c.signal.aborted && ownGeneration === generation.current) {
        syncedRevision.current = revision;
        setRows(all);
        queueKeys.current = new Set(all.map((t) => t.trackKey));
        setLoading(false);
      }
    }
    void load().catch((e) => {
      if (!c.signal.aborted) {
        setError(errorMessage(e));
        setLoading(false);
      }
    });
    return () => c.abort();
  }, [mode, source, retry]);
  // Membership refresh does not reorder the session snapshot or pull in new songs.
  useEffect(() => {
    if (
      !active ||
      !queueKeys.current.size ||
      (status &&
        syncedRevision.current &&
        sameRevision(status.revision, syncedRevision.current))
    )
      return;
    const c = new AbortController();
    const ownGeneration = generation.current,
      keys = new Set(queueKeys.current);
    async function update() {
      let cursor: string | null = null;
      const live = new Map<string, TrackDTO>();
      do {
        const v: ReturnType<typeof search> = await api(
          "/library/search",
          search,
          { filter: emptyFilter, groupBy: null, cursor, limit: 100 },
          c.signal,
        );
        if (v.groupBy !== null) throw Error();
        for (const t of v.tracks)
          if (keys.has(t.trackKey)) live.set(t.trackKey, t);
        cursor = v.nextCursor;
      } while (cursor && !c.signal.aborted);
      if (!c.signal.aborted && ownGeneration === generation.current) {
        if (status) syncedRevision.current = status.revision;
        const next = preserveCurrent(rowsRef.current, indexRef.current, live);
        setRows(next.rows);
        setIndex(next.index);
      }
    }
    void update().catch((e) => {
      if (!c.signal.aborted) setError(errorMessage(e));
    });
    return () => c.abort();
  }, [
    status?.revision.library,
    status?.revision.annotations,
    active,
    mode,
    source,
    retry,
  ]);
  useEffect(() => {
    const c = new AbortController();
    setKnown([]);
    if (current)
      void lookupTags(current.tagIds, c.signal)
        .then(setKnown)
        .catch((e) => {
          if (!c.signal.aborted) setError(errorMessage(e));
        });
    return () => c.abort();
  }, [current]);
  useEffect(() => {
    if (active && !mobile && !editingSlots && pinSlot === null)
      container.current
        ?.querySelector<HTMLInputElement>(".tag-picker input")
        ?.focus();
  }, [active, index, current?.trackKey, mobile, editingSlots, pinSlot]);
  useEffect(() => {
    if (index >= rows.length) setIndex(Math.max(0, rows.length - 1));
  }, [index, rows.length]);
  async function mutate(tag: TagDTO | string, kind: "add" | "remove" = "add") {
    if (!current || busy) return;
    setBusy(true);
    setError("");
    const key = current.trackKey,
      before = current.tagIds;
    const coveredBefore = syncedRevision.current;
    try {
      const v = await api("/tag-actions", tagAction, {
        selection: { kind: "tracks", trackKeys: [key] } satisfies Selection,
        ...(typeof tag === "string" ? { tagName: tag } : { tagId: tag.id }),
        action: kind,
      });
      if (typeof tag !== "string" && syncedRevision.current === coveredBefore)
        syncedRevision.current = ownedPatchRevision(
          coveredBefore,
          v.revision,
          v.changedCount > 0,
        );
      setRows((old) =>
        old.map((t) =>
          t.trackKey === key
            ? {
                ...t,
                tagIds:
                  kind === "add"
                    ? [...new Set([...t.tagIds, v.tag.id])]
                    : t.tagIds.filter((id) => id !== v.tag.id),
              }
            : t,
        ),
      );
      if (kind === "add" && before.length === 0 && v.changedCount)
        setTagged((old) => new Set([...old, key]));
      setActions((old) => [
        ...old,
        {
          id: v.actionId,
          key,
          tagId: v.tag.id,
          kind,
          changed: v.changedCount > 0,
          tagName: v.tag.name,
        },
      ]);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    const a = actions.at(-1);
    if (!a || busy) return;
    setBusy(true);
    try {
      const v = await api(`/tag-actions/${a.id}/undo`, undoAction, {});
      setActions((old) => old.slice(0, -1));
      setError(
        v.skippedCount
          ? `Restored ${v.restoredCount}; ${v.skippedCount} later edits were preserved.`
          : "",
      );
      const live = rowsRef.current.find((t) => t.trackKey === a.key);
      if (live) {
        const tagIds = restoredQueueTags(live.tagIds, a, v);
        if (tagIds !== live.tagIds) {
          setRows((old) =>
            old.map((t) =>
              t.trackKey === a.key
                ? { ...t, tagIds: restoredQueueTags(t.tagIds, a, v) }
                : t,
            ),
          );
          if (tagIds.length === 0)
            setTagged((old) => new Set([...old].filter((k) => k !== a.key)));
        }
      }
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function markReviewed() {
    if (!current || busy) return;
    setBusy(true);
    setError("");
    const key = current.trackKey;
    const coveredBefore = syncedRevision.current;
    try {
      const v = await api("/library/acknowledge", acknowledged, {
        trackKeys: [key],
      });
      if (syncedRevision.current === coveredBefore)
        syncedRevision.current = ownedPatchRevision(
          coveredBefore,
          v.revision,
          v.changedCount > 0,
        );
      setRows((old) =>
        old.map((t) =>
          t.trackKey === key && t.metadata
            ? {
                ...t,
                metadata: {
                  ...t.metadata,
                  acknowledgedAt: new Date().toISOString(),
                },
              }
            : t,
        ),
      );
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function advance(delta: number) {
    setIndex((i) => Math.min(Math.max(0, i + delta), rows.length - 1));
  }
  function skip() {
    setRows((old) => skipToTail(old, index));
    setIndex((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }
  async function removeLast() {
    const a = [...actions]
      .reverse()
      .find(
        (a) => a.key === current?.trackKey && current.tagIds.includes(a.tagId),
      );
    const t = known.find((t) => t.id === a?.tagId);
    if (t) await mutate(t, "remove");
  }
  return (
    <section
      aria-labelledby="queue-title"
      ref={container}
      onKeyDown={(e) => {
        if (
          !active ||
          help ||
          pinSlot !== null ||
          matchMedia("(max-width:640px)").matches ||
          busy
        )
          return;
        const el = e.target as HTMLElement;
        const editable = el.matches(
          'input,textarea,select,[contenteditable="true"]',
        );
        const action = queueShortcut(
          e.nativeEvent,
          editable,
          el instanceof HTMLInputElement ? el.value : "",
        );
        if (!action) return;
        e.preventDefault();
        if (action.startsWith("slot:")) {
          const t = slots[Number(action.slice(5)) - 1];
          if (t) void mutate(t).catch(() => {});
        } else if (action === "next") advance(1);
        else if (action === "previous") advance(-1);
        else if (action === "skip") skip();
        else if (action === "undo") void undo();
        else if (action === "remove") void removeLast().catch(() => {});
        else if (action === "help") setHelp(true);
        else if (action === "open" && current?.metadata?.spotifyUrl)
          window.open(
            current.metadata.spotifyUrl,
            "_blank",
            "noopener,noreferrer",
          );
        else if (action === "artist" && current?.metadata?.artists[0]?.id)
          onArtist(current.metadata.artists[0].id);
      }}
    >
      <div className="section-heading">
        <div>
          <h2 id="queue-title">Tagging queue</h2>
        </div>
        <span role="status">
          {tagged.size} tagged this session ·{" "}
          {status ? status.activeCount - status.untaggedCount : 0} songs tagged
        </span>
        <details className="queue-settings desktop-bulk">
          <summary>Queue settings</summary>
          <div>
            {" "}
            <label className="desktop-bulk queue-order">
              Queue order
              <select
                value={source ? "filter" : mode}
                onChange={(e) => {
                  seed.current = crypto.randomUUID();
                  setMode(e.target.value);
                }}
                disabled={!!source}
              >
                <option value="newest">Untagged · newest liked first</option>
                <option value="oldest">Untagged · oldest first</option>
                <option value="latest">New since last completed sync</option>
                <option value="random">Untagged · random</option>
                {source && (
                  <option value="filter">Sent from library filter</option>
                )}
              </select>
            </label>
            <p className="muted">
              Quick tags use your frequent tags. Pin a session’s shortcuts from
              Edit quick tags beside the slots.
            </p>
          </div>
        </details>
      </div>
      {error && !sheet && (
        <p role="alert" className="notice">
          {error}{" "}
          <button
            onClick={() => {
              setRetry((v) => v + 1);
            }}
          >
            Refresh queue
          </button>
        </p>
      )}
      {loading && <p role="status">Preparing your queue…</p>}
      {!loading && !current && (
        <div className="empty-state">
          <h3>No songs waiting in this queue</h3>
          <p>
            Tags are useful at any pace. Browse your library or check new
            arrivals after a sync.
          </p>
        </div>
      )}
      <div className="mobile-only mobile-cards">
        {rows.map((t, i) => (
          <button
            key={t.trackKey}
            className="mobile-track"
            onClick={(event) => {
              originatingCard.current = event.currentTarget;
              setIndex(i);
              setSheet(true);
            }}
          >
            <TrackSummary track={t} link={false} />
            <span>{t.tagIds.length} tags · Tap to tag</span>
          </button>
        ))}
      </div>
      {current && (
        <dialog
          className={`queue-card ${sheet ? "sheet-open" : ""}`}
          ref={sheetElement}
          aria-label={mobile ? "Tag song" : "Current song"}
          onCancel={() => setSheet(false)}
          onTouchStart={(e) => {
            if ((e.target as HTMLElement).closest("input,button,a")) {
              touch.current = null;
              return;
            }
            const p = e.touches[0];
            if (p) touch.current = { x: p.clientX, y: p.clientY };
          }}
          onTouchEnd={(e) => {
            const p = e.changedTouches[0],
              start = touch.current;
            touch.current = null;
            if (
              p &&
              start &&
              Math.abs(p.clientX - start.x) > 70 &&
              Math.abs(p.clientY - start.y) < 50
            )
              advance(p.clientX < start.x ? 1 : -1);
          }}
        >
          <button
            className="mobile-only compact"
            onClick={() => setSheet(false)}
          >
            Close song sheet
          </button>
          {error && sheet && (
            <div role="alert" className="notice">
              {error}{" "}
              <button onClick={() => setRetry((v) => v + 1)}>
                Refresh queue
              </button>
            </div>
          )}
          <div className="queue-identity">
            <TrackSummary track={current} link={false} />
            <p className="queue-details">
              {current.metadata?.releaseDate?.slice(0, 4) ?? "Year unavailable"}{" "}
              ·{" "}
              {current.metadata?.durationMs === null
                ? "Duration unavailable"
                : `${Math.floor((current.metadata?.durationMs ?? 0) / 60000)}:${String(Math.floor(((current.metadata?.durationMs ?? 0) % 60000) / 1000)).padStart(2, "0")}`}{" "}
              · Liked{" "}
              {current.metadata
                ? new Date(current.metadata.likedAt).toLocaleDateString()
                : ""}
            </p>
            <QueuePlayback
              key={current.trackKey}
              trackKey={current.trackKey}
              available={
                !!current.metadata?.playableUri && !!current.metadata.durationMs
              }
              active={active && playbackAllowed && (!mobile || sheet)}
            />
            {current.metadata?.spotifyUrl && (
              <a
                className="queue-spotify"
                href={current.metadata.spotifyUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open in Spotify ↗
              </a>
            )}
          </div>
          <div className="tagging-desk">
            <div className="current-tags-heading">
              Current tags <span>Saved as you tag</span>
            </div>
            <div className="chips current-tags">
              {known.length === 0 && <span className="muted">No tags yet</span>}
              {known.map((t) => (
                <button
                  className="chip"
                  key={t.id}
                  disabled={busy}
                  onClick={() => void mutate(t, "remove").catch(() => {})}
                  aria-label={`Remove ${t.name} from current song`}
                >
                  {t.name} ×
                </button>
              ))}
            </div>
            <TagPicker
              label="Tag current song"
              showEmptySuggestions={false}
              autoFocus={active && !matchMedia("(max-width:640px)").matches}
              refresh={refresh}
              disabled={busy}
              onCreate={mutate}
              onChoose={mutate}
            />
            <div className="quick-tags-heading">
              <strong>
                Quick tags{" "}
                <small className="desktop-bulk">
                  Press 1–9 on an empty input
                </small>
              </strong>
              <button
                className="compact desktop-bulk"
                aria-expanded={editingSlots}
                onClick={() => {
                  setEditingSlots((v) => !v);
                  setPinSlot(null);
                }}
              >
                {editingSlots ? "Done editing quick tags" : "Edit quick tags"}
              </button>
            </div>
            <div className="quick-slots" aria-label="Quick tags">
              {slots.map((t, i) => (
                <div key={i} className={!t ? "empty-slot" : undefined}>
                  <button
                    className="chip"
                    disabled={!t || busy}
                    onClick={() => t && void mutate(t).catch(() => {})}
                  >
                    <kbd>{i + 1}</kbd> {t?.name ?? "Empty slot"}
                  </button>
                  {editingSlots && (
                    <button
                      className="compact desktop-bulk"
                      aria-label={`Set or pin slot ${i + 1}`}
                      onClick={() => setPinSlot(i)}
                    >
                      {" "}
                      {pinned[i] ? "Pinned" : "Pin"}
                    </button>
                  )}
                </div>
              ))}
            </div>
            {pinSlot !== null && (
              <div className="notice">
                <TagPicker
                  label={`Choose tag for slot ${pinSlot + 1}`}
                  onChoose={(t) => {
                    setPinned((old) => ({ ...old, [pinSlot]: t }));
                    setPinSlot(null);
                  }}
                />
                <button
                  onClick={() => {
                    setPinned((old) => {
                      const next = { ...old };
                      delete next[pinSlot];
                      return next;
                    });
                    setPinSlot(null);
                  }}
                >
                  Unpin slot
                </button>
                <button onClick={() => setPinSlot(null)}>Cancel</button>
              </div>
            )}
          </div>
          <div className="queue-actions">
            <button
              className="queue-previous"
              disabled={index === 0 || busy}
              onClick={() => advance(-1)}
            >
              ← Previous
            </button>
            <button
              className="primary queue-next"
              disabled={busy || index === rows.length - 1}
              onClick={() => advance(1)}
            >
              Next →
            </button>
            <button className="queue-skip" disabled={busy} onClick={skip}>
              Skip · requeue
            </button>
          </div>
          <details className="queue-tool-disclosure">
            <summary>Song actions &amp; shortcuts</summary>
            <div className="queue-tools">
              {current.metadata?.acknowledgedAt === null && (
                <button disabled={busy} onClick={() => void markReviewed()}>
                  Mark arrival reviewed
                </button>
              )}

              <button
                className="desktop-bulk"
                disabled={!current.metadata?.artists[0]?.id}
                onClick={() =>
                  current.metadata?.artists[0]?.id &&
                  onArtist(current.metadata.artists[0].id)
                }
              >
                Browse this artist
              </button>
              <button
                className="desktop-bulk"
                disabled={busy}
                onClick={() => void removeLast().catch(() => {})}
              >
                Remove last-applied tag
              </button>
              <button className="desktop-bulk" onClick={() => setHelp(true)}>
                Hotkey help
              </button>
            </div>
          </details>
          {!!actions.length && (
            <div role="status" className="queue-feedback">
              {savedFeedback}
              <button disabled={busy} onClick={() => void undo()}>
                Undo last action
              </button>
            </div>
          )}
        </dialog>
      )}
      <dialog
        ref={helpDialog}
        className="dialog"
        aria-labelledby="hotkey-title"
        onCancel={() => setHelp(false)}
      >
        <h3 id="hotkey-title">Keep your hands on the keyboard</h3>
        <p>
          Enter applies the selected established match. Empty input: 1–9 quick
          tags; ← / → previous / next. Alt/Option + S skips, Z undoes, R removes
          your last-applied tag, O opens Spotify, A browses this artist, H opens
          help. Bare letters work outside text fields. Typing and IME
          composition always remain text.
        </p>
        <button onClick={() => setHelp(false)}>Close help</button>
      </dialog>
    </section>
  );
}
