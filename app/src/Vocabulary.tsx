import { useEffect, useRef, useState } from "react";
import type { TagDTO } from "../../supabase/functions/_shared/contracts";
import { api, ApiError, undoAction, errorMessage } from "./api";
import {
  vocabulary,
  managePreview,
  manage,
  type ManageIntent,
} from "./fast-api";
import { TagPicker } from "./TagPicker";
import { ManagementNotice } from "./ManagementNotice";
export function Vocabulary({
  refresh,
  onChanged,
}: {
  refresh: number;
  onChanged: () => void;
}) {
  const [sort, setSort] = useState("mostUsed"),
    [text, setText] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [data, setData] = useState<ReturnType<typeof vocabulary> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const [selected, setSelected] = useState<TagDTO | null>(null),
    [name, setName] = useState(""),
    [sources, setSources] = useState<TagDTO[]>([]),
    [target, setTarget] = useState<TagDTO | null>(null);
  const [preview, setPreview] = useState<{
    intent: ManageIntent;
    result: ReturnType<typeof managePreview>;
  } | null>(null);
  const [actions, setActions] = useState<{ id: string; message: string }[]>([]);
  const dialog = useRef<HTMLDialogElement>(null),
    previewDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const c = new AbortController();
    const timer = setTimeout(
      () =>
        void api(
          "/tags/vocabulary",
          vocabulary,
          { search: text, sort, cursor, limit: 100 },
          c.signal,
        )
          .then((v) => {
            if (!c.signal.aborted) {
              setData(v);
              setError("");
            }
          })
          .catch((e) => {
            if (!c.signal.aborted) {
              setError(errorMessage(e));
              if (
                e instanceof ApiError &&
                e.code === "stale_revision" &&
                cursor
              )
                setCursor(null);
            }
          }),
      150,
    );
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [text, sort, cursor, refresh]);
  useEffect(() => {
    if (selected) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selected]);
  useEffect(() => {
    if (preview) previewDialog.current?.showModal();
    else previewDialog.current?.close();
  }, [preview]);
  async function inspect(intent: ManageIntent) {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api("/tags/manage-preview", managePreview, {
        ...intent,
        expectedRevision: data.revision,
      });
      setPreview({ intent, result });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      const v = await api("/tags/manage", manage, {
        ...preview.intent,
        expectedRevision: preview.result.revision,
        ...(preview.intent.action === "delete"
          ? { confirmedAssignmentCount: preview.result.assignmentCount }
          : {}),
      });
      if (v.collisionTag) {
        setPreview({ intent: preview.intent, result: v });
        return;
      }
      if (v.actionId)
        setActions((old) => [
          ...old,
          {
            id: v.actionId!,
            message:
              preview.intent.action === "merge"
                ? `${preview.result.unionCount} songs will carry “${v.tag?.name ?? target?.name}”.`
                : preview.intent.action === "rename"
                  ? `Renamed to “${v.tag?.name}”.`
                  : `Deleted “${selected?.name}” from ${preview.result.assignmentCount} assignments.`,
          },
        ]);
      setPreview(null);
      setSelected(null);
      setSources([]);
      setTarget(null);
      setCursor(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="vocabulary-page" aria-labelledby="vocabulary-title">
      <div className="section-heading">
        <div>
          <h2 id="vocabulary-title">Your tags</h2>
        </div>
        <span className="muted">Your words for your music.</span>
      </div>
      <div className="library-filters">
        <label className="search-label">
          Find a tag
          <input
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCursor(null);
            }}
          />
        </label>
        <label>
          Vocabulary order
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setCursor(null);
            }}
          >
            <option value="mostUsed">Most used</option>
            <option value="name">Name</option>
            <option value="lastUsed">Last used</option>
            <option value="unused">Unused tags</option>
          </select>
        </label>
      </div>
      {sort === "unused" && (
        <p className="muted">
          Unused means no assignments, including retained tags on songs removed
          from Spotify.
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
          <button
            onClick={() => {
              setPreview(null);
              setCursor(null);
              onChanged();
            }}
          >
            Refresh vocabulary
          </button>
        </p>
      )}
      {!data && !error && <p role="status">Loading your tags…</p>}
      {data?.tags.length === 0 && (
        <p className="empty-state">
          No tags in this view. Add your own words while tagging.
        </p>
      )}
      <div className="dictionary-toolbar">
        <span>
          Tag <span className="muted">/ active songs</span>
        </span>
        <button
          className="compact text-button"
          aria-pressed={mergeMode}
          onClick={() => {
            setMergeMode(!mergeMode);
            setSources([]);
          }}
        >
          {mergeMode ? "Done selecting" : "Select tags to merge"}
        </button>
      </div>
      <div className={`vocabulary-list ${mergeMode ? "merge-mode" : ""}`}>
        {data?.tags.map((t) => (
          <article key={t.id}>
            <div>
              <strong>{t.name}</strong>
              <small>
                Last used{" "}
                {t.lastUsedAt
                  ? new Date(t.lastUsedAt).toLocaleDateString()
                  : "never"}
              </small>
            </div>
            <span className="dictionary-count">
              {t.activeTrackCount}
              <span className="sr-only"> active songs</span>
            </span>
            <button
              className="compact dictionary-manage"
              aria-label={`Manage ${t.name}`}
              onClick={() => {
                setSelected(t);
                setName(t.name);
                setSources([t]);
                setTarget(null);
              }}
            >
              Edit <span aria-hidden="true">⋯</span>
            </button>
            {mergeMode && (
              <label className="merge-source">
                <input
                  type="checkbox"
                  checked={sources.some((s) => s.id === t.id)}
                  onChange={(e) =>
                    setSources((old) =>
                      e.target.checked
                        ? [...old.filter((s) => s.id !== t.id), t]
                        : old.filter((s) => s.id !== t.id),
                    )
                  }
                />{" "}
                <span className="sr-only">Merge source {t.name}</span>
              </label>
            )}
          </article>
        ))}
      </div>
      {mergeMode && !!sources.length && (
        <aside className="notice">
          <p>
            Merge{" "}
            {sources
              .map((t) => `“${t.name}” (${t.activeTrackCount})`)
              .join(" + ")}
          </p>
          <TagPicker
            label="Merge into existing tag"
            disabled={busy}
            onChoose={(t) => {
              if (sources.some((s) => s.id === t.id)) {
                setError(
                  "Choose a destination outside the selected source tags.",
                );
                return;
              }
              setTarget(t);
              void inspect({
                action: "merge",
                sourceIds: sources.map((s) => s.id),
                targetId: t.id,
              });
            }}
          />
          <button onClick={() => setSources([])}>Clear merge sources</button>
        </aside>
      )}
      {data?.nextCursor && (
        <button onClick={() => setCursor(data.nextCursor)}>Next tags</button>
      )}
      {cursor && (
        <button onClick={() => setCursor(null)}>Back to first tags</button>
      )}
      <dialog
        ref={dialog}
        className="dialog"
        aria-labelledby="manage-tag-title"
        onCancel={() => setSelected(null)}
      >
        <h3 id="manage-tag-title">Manage “{selected?.name}”</h3>
        <p>
          {selected?.activeTrackCount} active songs. Changes apply globally;
          playlist snapshots stay as created.
        </p>
        <ManagementNotice
          error={error}
          busy={busy}
          onRefresh={() => {
            setCursor(null);
            onChanged();
          }}
        />
        <label>
          New tag name
          <input
            value={name}
            maxLength={640}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button
            disabled={busy || !name.trim()}
            onClick={() =>
              selected &&
              void inspect({ action: "rename", tagId: selected.id, name })
            }
          >
            Preview rename
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              selected && void inspect({ action: "delete", tagId: selected.id })
            }
          >
            Preview delete
          </button>
          <button onClick={() => setSelected(null)}>Close</button>
        </div>
        <TagPicker
          label="Merge this tag into"
          disabled={busy}
          onChoose={(t) => {
            if (t.id === selected?.id) {
              setError("Choose a different destination tag.");
              return;
            }
            setTarget(t);
            if (selected)
              void inspect({
                action: "merge",
                sourceIds: [selected.id],
                targetId: t.id,
              });
          }}
        />
      </dialog>
      <dialog
        ref={previewDialog}
        className="dialog"
        aria-labelledby="tag-preview-title"
        onCancel={() => setPreview(null)}
      >
        <h3 id="tag-preview-title">
          {preview?.intent.action === "delete"
            ? "Delete this tag?"
            : preview?.result.collisionTag
              ? "This name already exists"
              : preview?.intent.action === "merge"
                ? "Confirm merge"
                : "Confirm rename"}
        </h3>
        {preview?.result.collisionTag ? (
          <>
            <p>
              “{preview.result.collisionTag.name}” already exists (
              {preview.result.collisionTag.activeTrackCount} active songs).
              Merge assignments into that identity instead.
            </p>
            <button
              disabled={busy}
              onClick={() => {
                const p = preview;
                if (p.intent.action === "rename" && p.result.collisionTag) {
                  setTarget(p.result.collisionTag);
                  void inspect({
                    action: "merge",
                    sourceIds: [p.intent.tagId],
                    targetId: p.result.collisionTag.id,
                  });
                }
              }}
            >
              Preview collision merge
            </button>
          </>
        ) : (
          <>
            <p>
              {preview?.intent.action === "delete"
                ? `This removes ${preview.result.assignmentCount} assignments, including retained annotations. Stored queries referencing it will require an edit. Undo is available in this session.`
                : preview?.intent.action === "merge"
                  ? `${sources.map((t) => `“${t.name}” (${t.activeTrackCount})`).join(" + ")} → “${target?.name}” (${target?.activeTrackCount}) — ${preview.result.unionCount} distinct songs will carry “${target?.name}”, including retained annotations (${preview.result.activeTrackCount} active songs). Overlapping assignments count once.`
                  : `Rename globally to “${preview?.intent.action === "rename" ? preview.intent.name : ""}”. Stored queries keep the same tag identity.`}
            </p>
            <button
              className={preview?.intent.action === "delete" ? "danger" : ""}
              disabled={busy}
              onClick={() => void commit()}
            >
              {busy
                ? "Saving…"
                : preview?.intent.action === "delete"
                  ? `Delete tag and ${preview.result.assignmentCount} assignments`
                  : "Confirm change"}
            </button>
          </>
        )}
        <button disabled={busy} onClick={() => setPreview(null)}>
          Cancel
        </button>
        {error && <p role="alert">{error}</p>}
      </dialog>
      {!!actions.length && (
        <div className="toast" role="status">
          {actions.at(-1)?.message}
          <button
            disabled={busy}
            onClick={async () => {
              const a = actions.at(-1);
              if (!a) return;
              setBusy(true);
              try {
                const v = await api(
                  `/tag-actions/${a.id}/undo`,
                  undoAction,
                  {},
                );
                setActions((old) => old.slice(0, -1));
                setError(
                  v.skippedCount
                    ? `Restored ${v.restoredCount}; ${v.skippedCount} later changes were preserved.`
                    : "",
                );
                setCursor(null);
                onChanged();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Undo vocabulary action
          </button>
        </div>
      )}
    </section>
  );
}
