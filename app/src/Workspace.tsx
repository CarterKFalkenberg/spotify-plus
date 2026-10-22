import { Icon } from "./Icon";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  LibraryStatusDTO,
  Selection,
} from "../../supabase/functions/_shared/contracts";
import { api, libraryStatus, blockMessage, errorMessage } from "./api";
import { Library, emptyFilter } from "./Library";
import { Builder } from "./Builder";
import { Playlists } from "./Playlists";
import { Queue } from "./Queue";
import { Sources } from "./Sources";
import { Vocabulary } from "./Vocabulary";
import type { FastFilter } from "./fast-api";
import { usePageActivity, useVisiblePolling } from "./useVisiblePolling";
export function Workspace({ playbackAllowed }: { playbackAllowed: boolean }) {
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width:640px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width:640px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [tab, setTab] = useState<
    "queue" | "library" | "builder" | "playlists" | "vocabulary" | "sources"
  >(() =>
    matchMedia("(max-width: 640px)").matches
      ? "builder"
      : (() => {
          try {
            return localStorage.getItem("tagger-guidance-dismissed") === "yes"
              ? "queue"
              : "library";
          } catch {
            return "library";
          }
        })(),
  );
  const navigation = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const root = document.documentElement;
    const measure = () => {
      root.style.setProperty(
        "--workspace-nav-height",
        `${mobile ? nav.getBoundingClientRect().height : 0}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    measure();
    return () => {
      observer.disconnect();
      root.style.removeProperty("--workspace-nav-height");
    };
  }, [mobile]);
  const { visible, focusVersion } = usePageActivity();
  const [vocabularyRefresh, setVocabularyRefresh] = useState(0);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const opened = useRef(false);
  const viewRefresh = useRef<Record<string, number>>({});
  const [status, setStatus] = useState<LibraryStatusDTO | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [poolVersion, setPoolVersion] = useState(0);
  const sourcesRevision = useRef<string | undefined>(undefined);
  function invalidatePool() {
    setPoolVersion((v) => v + 1);
    setQueueSource(null);
    setRefresh((v) => v + 1);
  }
  function poolChanged() {
    setStatus((previous) =>
      previous ? { ...previous, initialSyncComplete: false } : previous,
    );
    invalidatePool();
    setStatusAttempt((v) => v + 1);
  }
  const [newOnly, setNewOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [queueSource, setQueueSource] = useState<FastFilter | Selection | null>(
    null,
  );
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (visible) setVisited((old) => new Set([...old, tab]));
  }, [tab, visible]);
  const [artistId, setArtistId] = useState<string | null>(null);
  const [artistJump, setArtistJump] = useState(0);
  useEffect(() => {
    if (!visible || opened.current) return;
    const controller = new AbortController();
    // The owner API coalesces app-open probes across reloads/tabs for 15 minutes.
    void api(
      "/library/sync",
      libraryStatus,
      { reason: "app-open" },
      controller.signal,
    )
      .then(() => {
        if (!controller.signal.aborted) {
          opened.current = true;
          setStatusAttempt((v) => v + 1);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [visible]);
  useVisiblePolling({
    refreshKey: statusAttempt,
    load: (signal) => api("/library/status", libraryStatus, undefined, signal),
    receive: (next) => {
      if (next.sourcesRevision !== undefined) {
        if (
          sourcesRevision.current !== undefined &&
          sourcesRevision.current !== next.sourcesRevision
        )
          invalidatePool();
        sourcesRevision.current = next.sourcesRevision;
      }
      setStatus((previous) => {
        if (
          previous &&
          JSON.stringify(previous.revision) !== JSON.stringify(next.revision)
        )
          setRefresh((v) => v + 1);
        return next;
      });
      setError("");
    },
    working: (next) =>
      !next.blockedBy &&
      (!next.initialSyncComplete || next.syncPhase !== "idle"),
    onError: (error) => setError(errorMessage(error)),
  });
  // Hidden views stay mounted, preserving drafts, selection, scroll and saved
  // intents. They consume revision invalidation when they become visible again.
  if (visible) viewRefresh.current[tab] = refresh;
  const refreshFor = (view: string) => viewRefresh.current[view] ?? 0;
  return (
    <div className="workspace" data-view={tab}>
      <details
        className="workspace-sync"
        open={
          !mobile ||
          !!status?.blockedBy ||
          (!!status && !status.initialSyncComplete)
        }
      >
        <summary>Library &amp; sync</summary>
        <div className="workspace-heading">
          <h1 className="sr-only">Your music workspace</h1>
          <div className="sync-controls">
            {!!status?.newCount && (
              <button
                className="new-badge desktop-arrivals"
                onClick={() => {
                  setNewOnly(true);
                  setQueueSource({ ...emptyFilter, newOnly: true });
                  setTab("queue");
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
                  setStatusAttempt((v) => v + 1);
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
                ? "Your song pool is empty. Choose Sources to add music."
                : status.syncPhase === "verifying"
                  ? "Verifying your library — checking that the complete import is stable."
                  : status.syncPhase === "importing"
                    ? `${status.importedCount.toLocaleString()} of ${status.reportedTotal?.toLocaleString() ?? "unknown total"} imported · Browse and tag while songs arrive.`
                    : status.initialSyncComplete
                      ? `${status.activeCount.toLocaleString()} songs · ${status.activeCount - status.untaggedCount} tagged${status.lastCompletedAt ? ` · Last synced ${new Date(status.lastCompletedAt).toLocaleDateString()}` : ""}`
                      : "Your sources are queued for import. Songs will appear as they arrive."}
            {status.blockedBy === "reconnect" && (
              <>
                {" "}
                <a href="/auth/spotify/start">Reconnect Spotify</a>
              </>
            )}
          </div>
        )}
      </details>
      {status && status.untaggedCount > 100 && tab === "queue" && (
        <p className="guidance desktop-bulk">
          {status.untaggedCount} untagged songs · A few big artists make a good
          start.{" "}
          <button onClick={() => setTab("library")}>
            Bulk-tag your backlog
          </button>
        </p>
      )}
      <nav ref={navigation} className="workspace-tabs" aria-label="Workspace">
        <button
          className="nav-queue"
          aria-pressed={tab === "queue"}
          onClick={() => {
            setQueueSource(null);
            setTab("queue");
          }}
        >
          <Icon name="queue" /> Tag queue
        </button>
        <button
          className="nav-library"
          aria-pressed={tab === "library"}
          onClick={() => {
            setTab("library");
            setNewOnly(false);
          }}
        >
          <Icon name="library" /> Library{" "}
          <span>{status?.activeCount ?? "—"}</span>
        </button>
        <button
          className="nav-create"
          aria-pressed={tab === "builder"}
          onClick={() => setTab("builder")}
        >
          <Icon name="builder" /> Make a playlist
        </button>
        <button
          className="nav-playlists"
          aria-pressed={tab === "playlists"}
          onClick={() => setTab("playlists")}
        >
          <Icon name="playlists" /> Your playlists
        </button>
        <button
          className="nav-tags"
          aria-pressed={tab === "vocabulary"}
          onClick={() => setTab("vocabulary")}
        >
          <Icon name="vocabulary" /> Tags
        </button>
        <button
          className="nav-arrivals mobile-only"
          aria-pressed={tab === "queue"}
          onClick={() => {
            setNewOnly(true);
            setQueueSource({ ...emptyFilter, newOnly: true });
            setTab("queue");
          }}
        >
          <Icon name="queue" /> New arrivals{" "}
          <span>{status?.newCount ?? "—"}</span>
        </button>
        <button
          className="nav-sources"
          aria-pressed={tab === "sources"}
          onClick={() => setTab("sources")}
        >
          <Icon name="sources" /> Sources
        </button>
      </nav>
      <div hidden={tab !== "sources"}>
        {(visited.has("sources") || (visible && tab === "sources")) && (
          <Sources
            active={visible && tab === "sources"}
            refresh={refreshFor("sources")}
            onChanged={poolChanged}
            onSync={() => {
              setRefresh((v) => v + 1);
              setStatusAttempt((v) => v + 1);
            }}
          />
        )}
      </div>
      <div hidden={tab !== "queue"}>
        {(visited.has("queue") || (visible && tab === "queue")) && (
          <Queue
            poolVersion={poolVersion}
            onSources={() => setTab("sources")}
            playbackAllowed={playbackAllowed}
            active={visible && tab === "queue"}
            refresh={refreshFor("queue")}
            status={status}
            source={queueSource}
            onChanged={() => setRefresh((v) => v + 1)}
            onArtist={(id) => {
              setArtistId(id);
              setArtistJump((v) => v + 1);
              setTab("library");
            }}
          />
        )}
      </div>
      <div hidden={tab !== "vocabulary"}>
        {(visited.has("vocabulary") || (visible && tab === "vocabulary")) && (
          <Vocabulary
            refresh={refreshFor("vocabulary")}
            onChanged={() => {
              setVocabularyRefresh((v) => v + 1);
              setRefresh((v) => v + 1);
            }}
          />
        )}
      </div>
      <div hidden={tab !== "library"}>
        {(visited.has("library") || (visible && tab === "library")) && (
          <Library
            poolVersion={poolVersion}
            onSources={() => setTab("sources")}
            active={visible && tab === "library"}
            refresh={refreshFor("library")}
            newOnly={newOnly}
            artistId={artistId}
            artistJump={artistJump}
            onQueue={(filter) => {
              setQueueSource(filter);
              setTab("queue");
            }}
            onChanged={() => setRefresh((v) => v + 1)}
          />
        )}
      </div>
      <div hidden={tab !== "builder"}>
        {(visited.has("builder") || (visible && tab === "builder")) && (
          <Builder
            onSources={() => setTab("sources")}
            poolEmpty={
              status?.initialSyncComplete === true && status.activeCount === 0
            }
            initialComplete={status?.initialSyncComplete ?? false}
            refresh={refreshFor("builder")}
            onCreated={() => setRefresh((v) => v + 1)}
            onViewPlaylists={() => setTab("playlists")}
            onTagLibrary={() => setTab("library")}
          />
        )}
      </div>
      <div hidden={tab !== "playlists"}>
        {(visited.has("playlists") || (visible && tab === "playlists")) && (
          <Playlists
            active={visible && tab === "playlists"}
            refresh={refreshFor("playlists")}
            vocabularyRefresh={`${vocabularyRefresh}:${focusVersion}:${status?.revision.annotations ?? ""}`}
          />
        )}
      </div>
    </div>
  );
}
