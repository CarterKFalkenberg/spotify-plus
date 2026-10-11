import { useEffect, useState } from "react";
import type { LibraryStatusDTO } from "../../supabase/functions/_shared/contracts";
import { api, libraryStatus, blockMessage, errorMessage } from "./api";
import { Library } from "./Library";
import { Builder } from "./Builder";
import { Playlists } from "./Playlists";
export function Workspace() {
  const [tab, setTab] = useState<"library" | "builder" | "playlists">(() =>
    matchMedia("(max-width: 640px)").matches ? "builder" : "library",
  );
  const [status, setStatus] = useState<LibraryStatusDTO | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [newOnly, setNewOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    // The owner API coalesces app-open probes across reloads/tabs for 15 minutes.
    void api(
      "/library/sync",
      libraryStatus,
      { reason: "app-open" },
      controller.signal,
    )
      .then(setStatus)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await api(
          "/library/status",
          libraryStatus,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setStatus((previous) => {
          if (
            previous &&
            JSON.stringify(previous.revision) !== JSON.stringify(next.revision)
          )
            setRefresh((v) => v + 1);
          return next;
        });
        setError("");
        timer = setTimeout(() => void load(), 5000);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(errorMessage(error));
          timer = setTimeout(() => void load(), 15000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="workspace">
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">YOUR LIBRARY, IN YOUR WORDS</div>
          <h1>
            Find your kind of <em>good.</em>
          </h1>
        </div>
        <div className="sync-controls">
          {!!status?.newCount && (
            <button
              className="new-badge"
              onClick={() => {
                setNewOnly(true);
                setTab("library");
              }}
            >
              {status.newCount} new
            </button>
          )}
          <button
            className="compact"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              setError("");
              try {
                setStatus(
                  await api("/library/sync", libraryStatus, {
                    reason: "manual",
                  }),
                );
                setRefresh((v) => v + 1);
              } catch (error) {
                setError(errorMessage(error));
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? "Requesting sync…" : "Sync now"}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {status && (
        <div className="library-status" role="status">
          {status.blockedBy
            ? blockMessage[status.blockedBy]
            : status.reportedTotal === 0
              ? "Your Spotify library is empty. Like a song in Spotify to get started."
              : status.syncPhase === "verifying"
                ? "Verifying your library — checking that the complete import is stable."
                : status.syncPhase === "importing"
                  ? `${status.importedCount.toLocaleString()} of ${status.reportedTotal?.toLocaleString() ?? "unknown total"} imported · Browse and tag while songs arrive.`
                  : status.initialSyncComplete
                    ? `${status.activeCount.toLocaleString()} songs · ${status.activeCount - status.untaggedCount} tagged${status.lastCompletedAt ? ` · Last synced ${new Date(status.lastCompletedAt).toLocaleDateString()}` : ""}`
                    : "Your first import is queued. Songs will appear as they arrive."}
          {status.blockedBy === "reconnect" && (
            <>
              {" "}
              <a href="/auth/spotify/start">Reconnect Spotify</a>
            </>
          )}
        </div>
      )}
      <nav className="workspace-tabs" aria-label="Workspace">
        <button
          aria-pressed={tab === "library"}
          onClick={() => {
            setTab("library");
            setNewOnly(false);
          }}
        >
          Library <span>{status?.activeCount ?? "—"}</span>
        </button>
        <button
          aria-pressed={tab === "builder"}
          onClick={() => setTab("builder")}
        >
          Make a playlist
        </button>
        <button
          aria-pressed={tab === "playlists"}
          onClick={() => setTab("playlists")}
        >
          Your playlists
        </button>
      </nav>
      <div hidden={tab !== "library"}>
        <Library
          refresh={refresh}
          newOnly={newOnly}
          onChanged={() => setRefresh((v) => v + 1)}
        />
      </div>
      <div hidden={tab !== "builder"}>
        <Builder
          initialComplete={status?.initialSyncComplete ?? false}
          refresh={refresh}
          onCreated={() => setRefresh((v) => v + 1)}
        />
      </div>
      <div hidden={tab !== "playlists"}>
        <Playlists refresh={refresh} />
      </div>
    </div>
  );
}
