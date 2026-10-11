import { useEffect, useState } from "react";
import { api, tags, errorMessage } from "./api";
import type { TagDTO } from "../../supabase/functions/_shared/contracts";
export function TagPicker({
  label,
  onChoose,
  onCreate,
  disabled = false,
  actionLabel = "Add",
}: {
  label: string;
  onChoose: (tag: TagDTO) => Promise<void> | void;
  onCreate?: (name: string) => Promise<void> | void;
  disabled?: boolean;
  actionLabel?: "Add" | "Remove";
}) {
  const allowCreate = !!onCreate;
  const [text, setText] = useState("");
  const [options, setOptions] = useState<readonly TagDTO[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    setOptions([]);
    if (!focused || disabled) {
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
        .then((value) => {
          if (controller.signal.aborted) return;
          setSearching(false);
          setOptions(value.tags);
          setError("");
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setSearching(false);
            setError(errorMessage(error));
          }
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, focused, disabled]);
  async function choose(item?: TagDTO) {
    if (busy || searching || disabled || (!item && !text.trim())) return;
    setBusy(true);
    setError("");
    try {
      if (item) await onChoose(item);
      else await onCreate?.(text);
      setText("");
      setFocused(false);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="tag-picker">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (options[0]) void choose(options[0]);
          else if (allowCreate) void choose();
        }}
      >
        <label>
          {label}
          <input
            value={text}
            maxLength={640}
            placeholder={allowCreate ? "Find or create a tag…" : "Find a tag…"}
            disabled={disabled || busy}
            onFocus={() => {
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
            (!options.length && (!allowCreate || !text.trim()))
          }
        >
          {busy ? "Saving…" : actionLabel}
        </button>
      </form>
      {focused && (
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
          {options.map((item) => (
            <button
              type="button"
              key={item.id}
              disabled={busy || searching || disabled}
              onClick={() => void choose(item)}
            >
              <span>{item.name}</span>
              <small>{item.activeTrackCount} songs</small>
            </button>
          ))}
          {allowCreate &&
            text.trim() &&
            !options.some(
              (item) =>
                item.name.toLocaleLowerCase() ===
                text.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
            ) && (
              <button
                type="button"
                className="create-tag"
                disabled={busy || searching || disabled}
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
