import { useEffect, useRef, useState } from "react";
export type Theme = "system" | "light" | "dark";
declare global {
  interface Window {
    spotifyPlusAppearance: {
      key: string;
      read: () => Theme;
      apply: (theme: Theme) => void;
    };
  }
}
const {
  key,
  read: savedTheme,
  apply: applyTheme,
} = window.spotifyPlusAppearance;
export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function close(event: PointerEvent | KeyboardEvent) {
      const element = disclosure.current;
      if (!element?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        element.open = false;
        element.querySelector("summary")?.focus();
      } else if (!element.contains(event.target as Node)) element.open = false;
    }
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, []);
  useEffect(() => {
    applyTheme(theme);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(theme);
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setTheme(savedTheme());
    };
    media.addEventListener("change", update);
    window.addEventListener("storage", sync);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("storage", sync);
    };
  }, [theme]);
  return (
    <details className="theme-control" ref={disclosure}>
      <summary aria-label="Appearance" title="Appearance">
        <svg
          viewBox="0 0 24 24"
          width="21"
          height="21"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4v16a8 8 0 0 0 0-16" fill="currentColor" stroke="none" />
        </svg>
        <span>Appearance</span>
      </summary>
      <fieldset className="theme-options">
        <legend>Appearance</legend>
        {(["system", "light", "dark"] as const).map((choice) => (
          <label key={choice}>
            <input
              type="radio"
              name="appearance"
              checked={theme === choice}
              onChange={() => {
                setTheme(choice);
                applyTheme(choice);
                try {
                  localStorage.setItem(key, choice);
                } catch {
                  /* Current visit still works. */
                }
              }}
            />
            {choice.slice(0, 1).toUpperCase() + choice.slice(1)}
          </label>
        ))}
      </fieldset>
    </details>
  );
}
