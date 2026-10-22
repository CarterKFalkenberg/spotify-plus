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
  trackAddedAt,
} from "./api";
import {
  queueSnapshot,
  queueTracks,
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
  ownedPatchRevision,
  restoredQueueTags,
} from "./tagging";
export function Queue({
  refresh,
  poolVersion = 0,
  onSources,
  active,
  playbackAllowed,
  status,
  source,
  onChanged,
  onArtist,
}: {
  refresh: number;
  poolVersion?: number;
  onSources?: () => void;
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
  const [order, setOrder] = useState<string[]>([]);
  const identities = useRef(new Map<string, string>());
  const hydrated = useRef(new Map<string, LibraryStatusDTO["revision"]>());
  const initialized = useRef(false);
  const [frequent, setFrequent] = useState<readonly (TagDTO | undefined)[]>([]),
    [pinned, setPinned] = useState<Record<number, TagDTO>>({});
  const [known, setKnown] = useState<readonly TagDTO[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [checkingEligibility, setCheckingEligibility] = useState(false);
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
  const current = rows.find(
    (t) => t.trackKey === identities.current.get(order[index] ?? ""),
  );
  const hasCurrent = !!current;
  const showQueueDialog = hasCurrent || (mobile && sheet && order.length > 0);
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
    if (!element || !showQueueDialog || !active) return;
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
  }, [sheet, mobile, showQueueDialog, active]);
  useEffect(() => {
    if (!order.length) setSheet(false);
  }, [order.length]);
  const syncedRevision = useRef<LibraryStatusDTO["revision"] | null>(null);
  const [retry, setRetry] = useState(0);
  const helpDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (help) helpDialog.current?.showModal();
    else helpDialog.current?.close();
  }, [help]);
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
    orderRef = useRef(order),
    indexRef = useRef(index),
    generation = useRef(0);
  rowsRef.current = rows;
  orderRef.current = order;
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
  // Session order is a lightweight opaque manifest. Only a nearby metadata
  // window is requested; tag writes cannot invalidate a frozen search cursor.
  useEffect(() => {
    generation.current++;
    initialized.current = false;
    identities.current.clear();
    hydrated.current.clear();
    syncedRevision.current = null;
    setOrder([]);
    setRows([]);
    setIndex(0);
    setError("");
    setCheckingEligibility(false);
  }, [mode, source, retry, poolVersion]);
  useEffect(() => {
    if (!active || initialized.current) return;
    const c = new AbortController();
    const ownGeneration = generation.current;
    setLoading(true);
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
    void api(
      "/library/queue",
      queueSnapshot,
      {
        filter,
        sort,
        seed: sort === "random" ? seed.current : null,
        ...(source && "kind" in source ? { selection: source } : {}),
      },
      c.signal,
    )
      .then((v) => {
        if (c.signal.aborted || ownGeneration !== generation.current) return;
        initialized.current = true;
        syncedRevision.current = v.revision;
        identities.current = new Map(
          v.entries.map((e) => [e.key, e.track.trackKey]),
        );
        hydrated.current = new Map(v.entries.map((e) => [e.key, v.revision]));
        setOrder(v.trackKeys);
        setRows(v.entries.map((e) => e.track));
        setLoading(false);
      })
      .catch((e) => {
        if (!c.signal.aborted && ownGeneration === generation.current) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });
    return () => c.abort();
  }, [mode, source, retry, poolVersion, active]);
  const currentRevision = hydrated.current.get(order[index] ?? "");
  const eligibilityPending =
    checkingEligibility ||
    (!!current &&
      (!status ||
        !currentRevision ||
        BigInt(currentRevision.library) < BigInt(status.revision.library)));
  useEffect(() => {
    if (!active || !initialized.current || busy || !order.length) return;
    const nearby = order.slice(Math.max(0, index - 10), index + 41);
    // Unknown status cannot prove cached metadata stale. Keep interaction
    // fail-closed above, but wait for authoritative status before revalidation.
    const stale = nearby.filter((key) => {
      const revision = hydrated.current.get(key);
      return (
        revision &&
        status &&
        (BigInt(revision.library) < BigInt(status.revision.library) ||
          BigInt(revision.annotations) < BigInt(status.revision.annotations))
      );
    });
    // Fetch one complete batch ahead, then stop until the user approaches its
    // end. This avoids both one request per arrow press and eager library walks.
    const needsAhead = order
      .slice(index, index + 60)
      .some((key) => !hydrated.current.has(key));
    const missing = needsAhead
      ? order
          .slice(index)
          .filter((key) => !hydrated.current.has(key))
          .slice(0, 40)
      : [];
    const wanted = [...new Set([...stale, ...missing])].slice(0, 100);
    if (!wanted.length) {
      setCheckingEligibility(false);
      return;
    }
    const c = new AbortController();
    const ownGeneration = generation.current;
    setCheckingEligibility(
      !!current &&
        wanted.includes(order[index] ?? "") &&
        (!status ||
          !currentRevision ||
          BigInt(currentRevision.library) < BigInt(status.revision.library)),
    );
    void api(
      "/library/queue-tracks",
      queueTracks,
      { trackKeys: wanted },
      c.signal,
    )
      .then((v) => {
        if (c.signal.aborted || ownGeneration !== generation.current) return;
        const returned = new Map(v.entries.map((e) => [e.key, e.track]));
        for (const key of wanted) {
          const t = returned.get(key);
          if (t) {
            identities.current.set(key, t.trackKey);
            hydrated.current.set(key, v.revision);
          } else {
            identities.current.delete(key);
            hydrated.current.delete(key);
          }
        }
        // Components can merge while a queue is open. Keep the earliest captured
        // slot for each resolved representative and never insert a new identity.
        const seen = new Set<string>();
        const next = orderRef.current.filter((key) => {
          if (wanted.includes(key) && !returned.has(key)) return false;
          const representative = identities.current.get(key);
          if (!representative) return true;
          if (seen.has(representative)) return false;
          seen.add(representative);
          return true;
        });
        const selected = orderRef.current[indexRef.current];
        const retained = next.indexOf(selected ?? "");
        setOrder(next);
        setIndex(
          retained >= 0
            ? retained
            : Math.min(indexRef.current, Math.max(0, next.length - 1)),
        );
        setRows((old) => {
          const fresh = new Map(old.map((t) => [t.trackKey, t]));
          for (const entry of v.entries)
            fresh.set(entry.track.trackKey, entry.track);
          const retainedKeys = new Set(
            next.map((key) => identities.current.get(key)),
          );
          return [...fresh.values()].filter((t) =>
            retainedKeys.has(t.trackKey),
          );
        });
        syncedRevision.current = v.revision;
        setCheckingEligibility(false);
      })
      .catch((e) => {
        if (!c.signal.aborted && ownGeneration === generation.current) {
          setError(errorMessage(e));
          // An unsuccessful eligibility check must never re-enable stale playback.
        }
      });
    return () => c.abort();
  }, [
    active,
    busy,
    index,
    order,
    status?.revision.library,
    status?.revision.annotations,
    refresh,
    mode,
    source,
    retry,
    poolVersion,
  ]);
  function coverOwnedRevision(
    before: LibraryStatusDTO["revision"] | null,
    revision: LibraryStatusDTO["revision"],
    changed: boolean,
  ) {
    const covered = ownedPatchRevision(before, revision, changed);
    if (covered !== revision) return;
    for (const [key, previous] of hydrated.current)
      if (before && sameRevision(previous, before))
        hydrated.current.set(key, revision);
    syncedRevision.current = revision;
  }
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
    if (index >= order.length) setIndex(Math.max(0, order.length - 1));
  }, [index, order.length]);
  async function mutate(tag: TagDTO | string, kind: "add" | "remove" = "add") {
    if (!active || !current || busy || eligibilityPending) return;
    setBusy(true);
    setError("");
    const key = current.trackKey,
      before = current.tagIds;
    const coveredBefore = syncedRevision.current;
    const ownGeneration = generation.current;
    try {
      const v = await api("/tag-actions", tagAction, {
        selection: { kind: "tracks", trackKeys: [key] } satisfies Selection,
        ...(typeof tag === "string" ? { tagName: tag } : { tagId: tag.id }),
        action: kind,
      });
      if (ownGeneration !== generation.current) {
        onChanged();
        return;
      }
      if (typeof tag !== "string" && syncedRevision.current === coveredBefore)
        coverOwnedRevision(coveredBefore, v.revision, v.changedCount > 0);
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
      if (ownGeneration === generation.current) setError(errorMessage(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    const a = actions.at(-1);
    if (!a || busy) return;
    setBusy(true);
    const ownGeneration = generation.current;
    try {
      const v = await api(`/tag-actions/${a.id}/undo`, undoAction, {});
      if (ownGeneration !== generation.current) {
        onChanged();
        return;
      }
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
      if (ownGeneration === generation.current) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function markReviewed() {
    if (!active || !current || busy || eligibilityPending) return;
    setBusy(true);
    setError("");
    const key = current.trackKey;
    const coveredBefore = syncedRevision.current;
    const ownGeneration = generation.current;
    try {
      const v = await api("/library/acknowledge", acknowledged, {
        trackKeys: [key],
      });
      if (ownGeneration !== generation.current) {
        onChanged();
        return;
      }
      if (syncedRevision.current === coveredBefore)
        coverOwnedRevision(coveredBefore, v.revision, v.changedCount > 0);
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
      if (ownGeneration === generation.current) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function advance(delta: number) {
    if (!active || busy) return;
    setIndex((i) =>
      Math.min(Math.max(0, i + delta), Math.max(0, order.length - 1)),
    );
  }
  function skip() {
    if (!active || busy || !current) return;
    setOrder((old) => skipToTail(old, index));
    setIndex((i) => Math.min(i, Math.max(0, order.length - 1)));
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
                <option value="newest">Untagged · newest added first</option>
                <option value="oldest">Untagged · oldest first</option>
                <option value="latest">New since last completed sync</option>
                <option value="random">Untagged · random</option>
                {source && (
                  <option value="filter">Sent from library filter</option>
                )}
              </select>
            </label>
            <button onClick={() => setRetry((v) => v + 1)}>
              Refresh queue
            </button>
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
      {(loading || (!!order.length && !current)) && (
        <p role="status">Preparing your queue…</p>
      )}
      {!loading && !order.length && (
        <div className="empty-state">
          <h3>No songs waiting in this queue</h3>
          <p>
            Tags are useful at any pace. Browse your library or check new
            arrivals after a sync.
          </p>
          {onSources && <button onClick={onSources}>Choose Sources</button>}
        </div>
      )}
      <div className="mobile-only mobile-cards">
        {order.slice(Math.max(0, index - 10), index + 31).map((key, offset) => {
          const t = rows.find(
            (row) => row.trackKey === identities.current.get(key),
          );
          if (!t) return null;
          const i = Math.max(0, index - 10) + offset;
          return (
            <button
              key={key}
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
          );
        })}
      </div>
      {showQueueDialog && (
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
          {current ? (
            <>
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
                  {current.metadata?.releaseDate?.slice(0, 4) ??
                    "Year unavailable"}{" "}
                  ·{" "}
                  {current.metadata?.durationMs === null
                    ? "Duration unavailable"
                    : `${Math.floor((current.metadata?.durationMs ?? 0) / 60000)}:${String(Math.floor(((current.metadata?.durationMs ?? 0) % 60000) / 1000)).padStart(2, "0")}`}{" "}
                  · Added{" "}
                  {current.metadata
                    ? new Date(trackAddedAt(current)!).toLocaleDateString()
                    : ""}
                </p>
                <QueuePlayback
                  key={current.trackKey}
                  trackKey={current.trackKey}
                  available={
                    !!current.metadata?.playableUri &&
                    !!current.metadata.durationMs
                  }
                  active={
                    active &&
                    playbackAllowed &&
                    !eligibilityPending &&
                    (!mobile || sheet)
                  }
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
                  {known.length === 0 && (
                    <span className="muted">No tags yet</span>
                  )}
                  {known.map((t) => (
                    <button
                      className="chip"
                      key={t.id}
                      disabled={busy || eligibilityPending}
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
                  disabled={busy || eligibilityPending}
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
                    {editingSlots
                      ? "Done editing quick tags"
                      : "Edit quick tags"}
                  </button>
                </div>
                <div className="quick-slots" aria-label="Quick tags">
                  {slots.map((t, i) => (
                    <div key={i} className={!t ? "empty-slot" : undefined}>
                      <button
                        className="chip"
                        disabled={!t || busy || eligibilityPending}
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
                  disabled={busy || index === order.length - 1}
                  onClick={() => advance(1)}
                >
                  Next →
                </button>
                <button
                  className="queue-skip"
                  disabled={busy || eligibilityPending}
                  onClick={skip}
                >
                  Skip · requeue
                </button>
              </div>
              <details className="queue-tool-disclosure">
                <summary>Song actions &amp; shortcuts</summary>
                <div className="queue-tools">
                  {current.metadata?.acknowledgedAt === null && (
                    <button
                      disabled={busy || eligibilityPending}
                      onClick={() => void markReviewed()}
                    >
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
                    disabled={busy || eligibilityPending}
                    onClick={() => void removeLast().catch(() => {})}
                  >
                    Remove last-applied tag
                  </button>
                  <button
                    className="desktop-bulk"
                    onClick={() => setHelp(true)}
                  >
                    Hotkey help
                  </button>
                </div>
              </details>
              {!!actions.length && (
                <div role="status" className="queue-feedback">
                  {savedFeedback}
                  <button
                    disabled={busy || eligibilityPending}
                    onClick={() => void undo()}
                  >
                    Undo last action
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <p role="status">Loading next song…</p>
              {error && (
                <div role="alert" className="notice">
                  {error}{" "}
                  <button onClick={() => setRetry((v) => v + 1)}>
                    Refresh queue
                  </button>
                </div>
              )}
            </>
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
