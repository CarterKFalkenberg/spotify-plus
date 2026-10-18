import { useEffect, useState } from "react";
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
    <label className="theme-control">
      Appearance
      <select
        aria-label="Appearance"
        value={theme}
        onChange={(event) => {
          const next = event.target.value as Theme;
          setTheme(next);
          applyTheme(next);
          try {
            localStorage.setItem(key, next);
          } catch {
            /* The current choice still applies. */
          }
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
