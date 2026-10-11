import { useEffect, useState } from "react";
import { api, tags, createdTag, errorMessage } from "./api";
import type { TagDTO } from "../../supabase/functions/_shared/contracts";
export function TagPicker({
  label,
  onChoose,
  allowCreate = false,
  disabled = false,
}: {
  label: string;
  onChoose: (tag: TagDTO) => Promise<void> | void;
  allowCreate?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [options, setOptions] = useState<readonly TagDTO[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setOptions([]);
    const timer = setTimeout(() => {
      void api(
        `/tags?search=${encodeURIComponent(text)}&limit=20`,
        tags,
        undefined,
        controller.signal,
      )
        .then((value) => {
          setOptions(value.tags);
          setError("");
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);
  async function choose(item?: TagDTO) {
    if (busy || disabled || (!item && !text.trim())) return;
    setBusy(true);
    setError("");
    try {
      const next = item ?? (await api("/tags", createdTag, { name: text })).tag;
      await onChoose(next);
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
            onFocus={() => setFocused(true)}
            onChange={(event) => {
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
            (!options.length && (!allowCreate || !text.trim()))
          }
        >
          {busy ? "Saving…" : "Add"}
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
          {options.map((item) => (
            <button
              type="button"
              key={item.id}
              disabled={busy || disabled}
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
                disabled={busy || disabled}
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
