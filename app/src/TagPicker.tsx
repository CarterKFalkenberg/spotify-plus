import { Fragment, useEffect, useId, useRef, useState } from "react";
import { api, tags, errorMessage } from "./api";
import { inspectTagOptions } from "./selection-tags";
import { groupedTagOptions, normalizedTagName } from "./tagging";
import type {
  TagDTO,
  Selection,
  LibraryRevision,
} from "../../supabase/functions/_shared/contracts";
export function TagPicker({
  label,
  onChoose,
  onCreate,
  disabled = false,
  actionLabel = "Add",
  autoFocus = false,
  refresh = 0,
  showEmptySuggestions = true,
  selection,
  selectionRevision,
}: {
  label: string;
  onChoose: (tag: TagDTO) => Promise<void> | void;
  onCreate?: (name: string) => Promise<void> | void;
  disabled?: boolean;
  actionLabel?: "Add" | "Remove";
  autoFocus?: boolean;
  refresh?: number;
  showEmptySuggestions?: boolean;
  selection?: Selection;
  selectionRevision?: LibraryRevision | undefined;
}) {
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const allowCreate = !!onCreate;
  const optionsId = useId();
  const [highlight, setHighlight] = useState(0);
  const [text, setText] = useState("");
  const [options, setOptions] = useState<readonly TagDTO[]>([]);
  const [error, setError] = useState("");
  const [inspection, setInspection] = useState<Awaited<
    ReturnType<typeof inspectTagOptions>
  > | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState(false);
  const composing = useRef(false);
  const pointerActive = useRef(false);
  const pendingBlur = useRef(false);
  useEffect(() => {
    if (!focused) return;
    let frame = 0;
    const start = () => {
      pointerActive.current = true;
    };
    const finish = () => {
      pointerActive.current = false;
      // In-flow menus can change the sticky editor's height. Keep the pressed
      // target stable until its click has dispatched, then close the picker.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          pendingBlur.current &&
          !container.current?.contains(document.activeElement)
        )
          setFocused(false);
        pendingBlur.current = false;
      });
    };
    document.addEventListener("pointerdown", start, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
    return () => {
      document.removeEventListener("pointerdown", start, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
      cancelAnimationFrame(frame);
      pointerActive.current = false;
      pendingBlur.current = false;
    };
  }, [focused]);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    setOptions([]);
    setInspection(null);
    setLookupFailed(false);
    setHighlight(0);
    if (!focused || disabled || (!showEmptySuggestions && !text.trim())) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api(
        `/tags?search=${encodeURIComponent(text)}&limit=20`,
        tags,
        undefined,
        controller.signal,
      )
        .then(async (value) => {
          if (controller.signal.aborted) return;
          const states =
            selection && selectionRevision
              ? await inspectTagOptions(
                  value.tags,
                  selection,
                  selectionRevision,
                  controller.signal,
                )
              : null;
          if (controller.signal.aborted) return;
          setInspection(states);
          setSearching(false);
          setOptions(value.tags);
          const grouped = groupedTagOptions(value.tags);
          const exact = grouped.findIndex(
            ({ tag }) =>
              normalizedTagName(tag.name) === normalizedTagName(text),
          );
          setHighlight(exact >= 0 ? exact : 0);
          setError("");
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setSearching(false);
            setLookupFailed(true);
            setError(errorMessage(error));
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    text,
    focused,
    disabled,
    refresh,
    showEmptySuggestions,
    selection,
    selectionRevision,
  ]);
  const displayed = groupedTagOptions(options);
  const inspectionById = new Map(
    inspection?.tags.map((item) => [item.tag.id, item]),
  );
  async function choose(item?: TagDTO) {
    if (
      busy ||
      searching ||
      lookupFailed ||
      disabled ||
      (!item && !text.trim())
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (item) await onChoose(item);
      else await onCreate?.(text);
      setText("");
      setFocused(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
      if (
        document.activeElement === document.body ||
        container.current?.contains(document.activeElement)
      )
        input.current?.focus();
    }
  }
  return (
    <div
      className="tag-picker"
      ref={container}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          if (pointerActive.current) pendingBlur.current = true;
          else setFocused(false);
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (composing.current) return;
          if (displayed[highlight] ?? displayed[0])
            void choose((displayed[highlight] ?? displayed[0])?.tag);
          else if (allowCreate) void choose();
        }}
      >
        <label>
          {label}
          <input
            ref={input}
            autoComplete="off"
            role="combobox"
            aria-expanded={focused && (showEmptySuggestions || !!text.trim())}
            aria-controls={optionsId}
            aria-autocomplete="list"
            aria-activedescendant={
              focused && displayed[highlight]
                ? `${optionsId}-${highlight}`
                : undefined
            }
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing) {
                if (event.key === "Enter") event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (
                !event.nativeEvent.isComposing &&
                !composing.current &&
                options.length &&
                (event.key === "ArrowDown" || event.key === "ArrowUp")
              ) {
                event.preventDefault();
                setHighlight(
                  (i) =>
                    (i +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      options.length) %
                    options.length,
                );
              }
              if (event.key === "Escape") {
                setFocused(false);
                event.stopPropagation();
              }
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || composing.current)
              )
                event.preventDefault();
            }}
            value={text}
            maxLength={640}
            placeholder={allowCreate ? "Find or create a tag…" : "Find a tag…"}
            readOnly={disabled || busy}
            aria-disabled={disabled || busy}
            onFocus={() => {
              pendingBlur.current = false;
              if (!focused) setSearching(true);
              setFocused(true);
            }}
            onChange={(event) => {
              setSearching(true);
              setText(event.target.value);
              setFocused(true);
            }}
          />
        </label>
        <button
          type="submit"
          disabled={
            disabled ||
            busy ||
            searching ||
            lookupFailed ||
            (!options.length && (!allowCreate || !text.trim()))
          }
        >
          {busy ? "Saving…" : actionLabel}
        </button>
      </form>
      {focused && (showEmptySuggestions || !!text.trim()) && (
        <div className="suggestions">
          <div className="suggestion-heading">
            Your tags{" "}
            <button
              type="button"
              className="compact"
              onClick={() => setFocused(false)}
              aria-label={`Close ${label} suggestions`}
            >
              ×
            </button>
          </div>
          {searching && <p role="status">Finding tags…</p>}
          <div
            id={optionsId}
            role="listbox"
            aria-label={`${label} tag suggestions`}
          >
            {displayed.map(({ tag: item, heading }, index) => (
              <Fragment key={item.id}>
                {heading && (
                  <div className="suggestion-prefix" role="presentation">
                    {heading}
                  </div>
                )}
                <button
                  type="button"
                  id={`${optionsId}-${index}`}
                  role="option"
                  aria-selected={index === highlight}
                  className={index === highlight ? "suggestion-selected" : ""}
                  disabled={busy || searching || lookupFailed || disabled}
                  onClick={() => void choose(item)}
                >
                  <span>{item.name}</span>
                  <small>
                    {inspection
                      ? `${inspectionById.get(item.id)?.state} · ${inspectionById.get(item.id)?.assignedCount} of ${inspection.selectedCount} selected`
                      : `${item.activeTrackCount} songs`}
                  </small>
                </button>
              </Fragment>
            ))}
          </div>
          {allowCreate &&
            text.trim() &&
            !options.some(
              (item) =>
                normalizedTagName(item.name) === normalizedTagName(text),
            ) && (
              <button
                type="button"
                className="create-tag"
                disabled={busy || searching || lookupFailed || disabled}
                onClick={() => void choose()}
              >
                Create “{text.trim()}”
              </button>
            )}
          {!options.length && !allowCreate && (
            <p className="muted">
              No matching tags. Add tags in your library first.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
