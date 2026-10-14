import { useEffect, useRef, useState } from "react";
import { pollWhileVisible } from "./polling";

export function usePageActivity() {
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const [focusVersion, setFocusVersion] = useState(0);
  useEffect(() => {
    function visibility() {
      const next = document.visibilityState !== "hidden";
      setVisible(next);
      if (next) setFocusVersion((v) => v + 1);
    }
    function focus() {
      if (document.visibilityState !== "hidden") setFocusVersion((v) => v + 1);
    }
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
    };
  }, []);
  return { visible, focusVersion };
}

export function useVisiblePolling<T>({
  enabled = true,
  refreshKey,
  ...callbacks
}: {
  enabled?: boolean;
  refreshKey: string | number;
  load: (signal: AbortSignal) => Promise<T>;
  receive: (value: T) => void;
  working: (value: T) => boolean;
  onError: (error: unknown) => void;
}) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  useEffect(() => {
    if (!enabled) return;
    return pollWhileVisible({
      load: (signal) => latest.current.load(signal),
      receive: (value) => latest.current.receive(value),
      working: (value) => latest.current.working(value),
      onError: (error) => latest.current.onError(error),
    });
  }, [enabled, refreshKey]);
}
