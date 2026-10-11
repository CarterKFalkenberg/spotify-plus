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
import { TagPicker } from "./TagPicker";
import {
  queueShortcut,
  skipToTail,
  quickSlots,
  preserveCurrent,
  ownedPatchRevision,
} from "./tagging";
export function Queue({
  refresh,
  active,
  status,
  source,
  onChanged,
  onArtist,
}: {
  refresh: number;
  active: boolean;
  status: LibraryStatusDTO | null;
  source: FastFilter | Selection | null;
  onChanged: () => void;
  onArtist: (id: string) => void;
}) {
  const [mode, setMode] = useState("newest");
  const [rows, setRows] = useState<TrackDTO[]>([]),
    [index, setIndex] = useState(0);
  const [frequent, setFrequent] = useState<readonly TagDTO[]>([]),
    [pinned, setPinned] = useState<Record<number, TagDTO>>({});
  const [known, setKnown] = useState<readonly TagDTO[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [help, setHelp] = useState(false),
    [sheet, setSheet] = useState(false),
    [pinSlot, setPinSlot] = useState<number | null>(null);
  const [actions, setActions] = useState<
    {
      id: string;
      key: string;
      tagId: string;
      before: readonly string[];
      message: string;
    }[]
  >([]);
  const [tagged, setTagged] = useState(new Set<string>());
  const seed = useRef(crypto.randomUUID()),
    container = useRef<HTMLDivElement>(null),
    touch = useRef<{ x: number; y: number } | null>(null);
  const sheetElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sheet) return;
    const previous = document.activeElement as HTMLElement;
    sheetElement.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, [sheet]);
  const syncedRevision = useRef<LibraryStatusDTO["revision"] | null>(null);
  const queueKeys = useRef(new Set<string>());
  const [retry, setRetry] = useState(0);
  const helpDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (help) helpDialog.current?.showModal();
    else helpDialog.current?.close();
  }, [help]);
  const current = rows[index];
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
      .then((v) => setFrequent(v.tags))
      .catch((e) => {
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
    if (active && !matchMedia("(max-width:640px)").matches)
      container.current
        ?.querySelector<HTMLInputElement>(".tag-picker input")
        ?.focus();
  }, [active, index]);
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
          before,
          message: `${kind === "add" ? "Added" : "Removed"} “${v.tag.name}” · ${v.changedCount} changed`,
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
      if (!v.skippedCount) {
        setRows((old) =>
          old.map((t) =>
            t.trackKey === a.key ? { ...t, tagIds: a.before } : t,
          ),
        );
        if (a.before.length === 0)
          setTagged((old) => new Set([...old].filter((k) => k !== a.key)));
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
          <div className="eyebrow">ONE SONG, A FEW WORDS</div>
          <h2 id="queue-title">Tagging queue</h2>
        </div>
        <span role="status">
          {tagged.size} tagged this session ·{" "}
          {status ? status.activeCount - status.untaggedCount : 0} songs tagged
        </span>
      </div>
      <label className="desktop-bulk">
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
          {source && <option value="filter">Sent from library filter</option>}
        </select>
      </label>
      {error && (
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
            onClick={() => {
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
        <div
          className={`queue-card ${sheet ? "sheet-open" : ""}`}
          ref={sheetElement}
          role={sheet ? "dialog" : undefined}
          aria-modal={sheet ? true : undefined}
          aria-label={sheet ? "Tag song" : undefined}
          onKeyDown={(e) => {
            if (!sheet) return;
            if (e.key === "Escape") {
              setSheet(false);
              e.stopPropagation();
            }
            if (e.key === "Tab") {
              const controls = [
                ...e.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not(:disabled),a[href],input:not(:disabled)",
                ),
              ].filter((el) => el.getClientRects().length);
              const first = controls[0],
                last = controls.at(-1);
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
              }
            }
          }}
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
          <TrackSummary track={current} />
          <p className="queue-details">
            {current.metadata?.releaseDate?.slice(0, 4) ?? "Year unavailable"} ·{" "}
            {current.metadata?.durationMs === null
              ? "Duration unavailable"
              : `${Math.floor((current.metadata?.durationMs ?? 0) / 60000)}:${String(Math.floor(((current.metadata?.durationMs ?? 0) % 60000) / 1000)).padStart(2, "0")}`}{" "}
            · Liked{" "}
            {current.metadata
              ? new Date(current.metadata.likedAt).toLocaleDateString()
              : ""}
          </p>
          <div className="chips">
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
          <div className="quick-slots" aria-label="Quick tags">
            {slots.map((t, i) => (
              <div key={i}>
                <button
                  className="chip"
                  disabled={!t || busy}
                  onClick={() => t && void mutate(t).catch(() => {})}
                >
                  <kbd>{i + 1}</kbd> {t?.name ?? "Empty slot"}
                </button>
                <button
                  className="compact desktop-bulk"
                  aria-label={`Set or pin slot ${i + 1}`}
                  onClick={() => setPinSlot(i)}
                >
                  {" "}
                  {pinned[i] ? "Pinned" : "Pin"}
                </button>
              </div>
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
          <div className="queue-actions">
            {current.metadata?.acknowledgedAt === null && (
              <button disabled={busy} onClick={() => void markReviewed()}>
                Mark arrival reviewed
              </button>
            )}
            <button disabled={index === 0 || busy} onClick={() => advance(-1)}>
              ← Previous
            </button>
            <button
              disabled={busy || index === rows.length - 1}
              onClick={() => advance(1)}
            >
              Next →
            </button>
            <button disabled={busy} onClick={skip}>
              Skip · requeue
            </button>
            {current.metadata?.spotifyUrl && (
              <a
                href={current.metadata.spotifyUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open in Spotify ↗
              </a>
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
        </div>
      )}
      {!!actions.length && (
        <div role="status" className="toast">
          {actions.at(-1)?.message}
          <button disabled={busy} onClick={() => void undo()}>
            Undo last action
          </button>
        </div>
      )}
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
      <dialog
        ref={helpDialog}
        className="dialog"
        onCancel={() => setHelp(false)}
      >
        <h3>Keep your hands on the keyboard</h3>
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
