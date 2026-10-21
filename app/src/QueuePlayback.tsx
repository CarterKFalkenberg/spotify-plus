import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { QueuePlayer, loadSDK, type ListenView } from "./playback";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_response");
  return value as Record<string, unknown>;
}
export function QueuePlayback({
  trackKey,
  available,
  active,
}: {
  trackKey: string;
  available: boolean;
  active: boolean;
}) {
  const [view, setView] = useState<ListenView>({
    status: "idle",
    message: "",
    enable: false,
  });
  const [retry, setRetry] = useState(0);
  const [enabling, setEnabling] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);
  const enableRequest = useRef<AbortController | null>(null);
  const player = useRef<QueuePlayer | null>(null);
  useEffect(() => {
    setView({ status: "idle", message: "", enable: false });
    setEnabling(false);
    if (!active || !available) return;
    let current = true;
    setSdkReady(false);
    void loadSDK()
      .then(() => {
        if (current) setSdkReady(true);
      })
      .catch(() => {
        if (current)
          setView({
            status: "error",
            message: "Audio could not load. Try again or open Spotify.",
            enable: false,
          });
      });
    const controller = new QueuePlayer(
      trackKey,
      {
        token: (signal) =>
          api(
            "/playback/token",
            (value) => {
              const v = object(value);
              if (
                typeof v.accessToken !== "string" ||
                !v.accessToken ||
                /\s/.test(v.accessToken)
              )
                throw new Error("invalid_response");
              return v.accessToken;
            },
            {},
            signal,
          ),
        start: (key, deviceId, signal) =>
          api(
            "/playback/start",
            (value) => {
              const v = object(value);
              if (
                typeof v.uri !== "string" ||
                !/^spotify:track:[A-Za-z0-9]{22}$/.test(v.uri) ||
                typeof v.positionMs !== "number" ||
                typeof v.durationMs !== "number" ||
                !Number.isSafeInteger(v.durationMs) ||
                v.durationMs <= 0 ||
                v.durationMs > 86400000 ||
                !Number.isSafeInteger(v.positionMs) ||
                v.positionMs !== Math.floor(v.durationMs / 3)
              )
                throw new Error("invalid_response");
              return {
                uri: v.uri,
                positionMs: v.positionMs,
                durationMs: v.durationMs,
              };
            },
            { trackKey: key, deviceId },
            signal,
          ),
      },
      setView,
    );
    player.current = controller;
    return () => {
      current = false;
      player.current = null;
      enableRequest.current?.abort();
      enableRequest.current = null;
      controller.destroy();
    };
  }, [trackKey, available, active, retry]);
  const playing = view.status === "snippet" || view.status === "more";
  const waiting =
    view.status === "loading" ||
    view.status === "starting" ||
    view.status === "pausing";
  async function enable() {
    if (!active || enabling || enableRequest.current) return;
    const request = new AbortController();
    enableRequest.current = request;
    setEnabling(true);
    try {
      const url = await api(
        "/playback/enable",
        (value) => {
          const raw = object(value).url;
          if (typeof raw !== "string") throw new Error("invalid_response");
          const url = new URL(raw);
          if (
            url.origin !== "https://accounts.spotify.com" ||
            url.pathname !== "/authorize"
          )
            throw new Error("invalid_response");
          return url.href;
        },
        {},
        AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
      );
      if (!request.signal.aborted && enableRequest.current === request)
        window.location.assign(url);
    } catch {
      if (request.signal.aborted || enableRequest.current !== request) return;
      setView({
        status: "error",
        message: "Spotify could not be connected. Try again.",
        enable: true,
      });
    } finally {
      if (enableRequest.current === request) {
        enableRequest.current = null;
        setEnabling(false);
      }
    }
  }
  return (
    <div
      className="queue-playback"
      aria-label="Listen while tagging"
      onMouseDown={(event) => {
        if (!matchMedia("(max-width:640px)").matches) event.preventDefault();
      }}
    >
      {view.enable ? (
        <button
          className="listen-play"
          disabled={enabling || !active}
          onClick={() => void enable()}
        >
          {enabling ? "Connecting Spotify…" : "Enable playback"}
        </button>
      ) : view.status === "error" ? (
        <button className="listen-play" onClick={() => setRetry((v) => v + 1)}>
          Try playback again
        </button>
      ) : (
        <button
          className="listen-play"
          disabled={!available || !active || !sdkReady || waiting || playing}
          onClick={() => void player.current?.play()}
        >
          {!sdkReady
            ? "Loading audio…"
            : waiting
              ? view.status === "loading"
                ? "Connecting audio…"
                : view.status === "pausing"
                  ? "Pausing…"
                  : "Starting…"
              : view.status === "paused"
                ? "▶ Play more"
                : "▶ Play"}
        </button>
      )}
      {(playing || waiting) && (
        <button
          className="compact listen-pause"
          onClick={() =>
            waiting ? setRetry((v) => v + 1) : void player.current?.pause()
          }
        >
          {waiting ? "Cancel" : "Ⅱ Pause"}
        </button>
      )}
      <span className="listen-caption" role="status">
        {!available
          ? "This song is unavailable for playback."
          : view.message ||
            (view.status === "snippet"
              ? "Playing a 20-second listen"
              : view.status === "more"
                ? "Playing until you pause"
                : view.status === "paused"
                  ? "Paused · Play more to keep listening"
                  : "Listen from one-third in · 20 seconds")}
      </span>
    </div>
  );
}
