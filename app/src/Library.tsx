import { Icon } from "./Icon";
import { useEffect, useRef, useState } from "react";
import type {
  LibraryFilter,
  Selection,
  TagDTO,
  TrackDTO,
} from "../../supabase/functions/_shared/contracts";
import {
  api,
  tagAction,
  undoAction,
  errorMessage,
  lookupTags,
  ApiError,
} from "./api";
import { TagPicker } from "./TagPicker";
import {
  search,
  type Search,
  type FastFilter,
  type Facet,
  type Sort,
} from "./fast-api";
import { Facets } from "./Facets";
import { BulkTags } from "./BulkTags";
import { rangeSelection } from "./tagging";
export const emptyFilter: LibraryFilter = {
  membership: "active",
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
export function CollectionArtwork({
  url,
  kind,
}: {
  url?: string | null | undefined;
  kind: "artist" | "album" | "playlist" | "decade";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <div className={`collection-artwork ${kind}`}>
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span aria-label={`${kind} artwork unavailable`} role="img">
          <Icon name={kind} />
        </span>
      )}
    </div>
  );
}
export function TrackSummary({
  track,
  link = true,
}: {
  track: TrackDTO;
  link?: boolean;
}) {
  const m = track.metadata;
  return (
    <div className="track-summary">
      {m?.artworkUrl ? (
        <img src={m.artworkUrl} alt="" loading="lazy" />
      ) : (
        <span className="art-placeholder" aria-hidden="true">
          ♪
        </span>
      )}
      <div>
        <strong>{m?.title ?? "Metadata no longer retained"}</strong>
        <span>
          {m?.artists.map((a) => a.name).join(", ") || "Artist unavailable"}
          {m?.album ? ` · ${m.album}` : ""}
        </span>
        {m && !m.playableUri && <small>Unavailable for playlists</small>}
      </div>
      {link && m?.spotifyUrl && (
        <a
          href={m.spotifyUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${m.title} in Spotify`}
        >
          ↗
        </a>
      )}
    </div>
  );
}
export function Library({
  refresh,
  newOnly,
  onChanged,
  onQueue,
  artistId = null,
  artistJump = 0,
}: {
  refresh: number;
  newOnly: boolean;
  onChanged: () => void;
  onQueue: (filter: FastFilter | Selection) => void;
  artistId?: string | null;
  artistJump?: number;
}) {
  const [filter, setFilter] = useState<FastFilter>({
    ...emptyFilter,
    newOnly,
  });
  const [grouped, setGrouped] = useState(
    !newOnly && !matchMedia("(max-width:640px)").matches,
  );
  const [editingTrack, setEditingTrack] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<Facet>("artist");
  const [sort, setSort] = useState<Sort>("newest");
  const anchor = useRef<string | null>(null);
  const pageHistory = useRef<(string | null)[]>([]);
  useEffect(() => {
    if (artistId) {
      setFilter((v) => ({ ...v, artistId }));
      setGrouped(false);
      setCursor(null);
      pageHistory.current = [];
      setSelection(null);
    }
  }, [artistId, artistJump]);
  const [data, setData] = useState<Search | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const lookupConflict = useRef<string | null>(null);
  const [tagError, setTagError] = useState("");
  const [knownTags, setKnownTags] = useState<readonly TagDTO[]>([]);
  const [undoFeedback, setUndoFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [guidance, setGuidance] = useState(() => {
    try {
      return localStorage.getItem("tagger-guidance-dismissed") !== "yes";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    setFilter((v) => ({ ...v, membership: "active", newOnly }));
    setGrouped(!newOnly && !matchMedia("(max-width:640px)").matches);
    setData(null);
    setCursor(null);
    pageHistory.current = [];
    setSelection(null);
  }, [newOnly]);
  useEffect(() => {
    const controller = new AbortController();
    // Keep keyed rows, drafts and explicit keys mounted during current-view refresh.
    // A selected filter retains its original expectedRevision until explicitly reselected.
    setError("");
    const timer = setTimeout(() => {
      void api(
        "/library/search",
        search,
        {
          filter,
          groupBy: grouped ? groupBy : null,
          sort,
          cursor,
          limit: grouped ? 12 : 30,
        },
        controller.signal,
      )
        .then((value) => {
          if (!controller.signal.aborted) setData(value);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filter, grouped, groupBy, sort, cursor, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setKnownTags([]);
    if (data?.groupBy === null) {
      void lookupTags(
        data.tracks.flatMap((track) => track.tagIds),
        controller.signal,
      )
        .then((resolved) => {
          if (!controller.signal.aborted) setKnownTags(resolved);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setTagError(errorMessage(error));
          if (error instanceof ApiError && error.code === "unknown_tag") {
            const key = JSON.stringify(
              data.tracks.map((track) => track.tagIds),
            );
            if (lookupConflict.current !== key) {
              lookupConflict.current = key;
              setCursor(null);
              pageHistory.current = [];
              onChanged();
            }
          }
        });
    }
    return () => controller.abort();
  }, [data]);
  function changeFilter(next: FastFilter) {
    setTagError("");
    setData(null);
    setFilter(next);
    setCursor(null);
    pageHistory.current = [];
    setSelection(null);
  }
  async function mutate(
    tag: TagDTO | string,
    selection: Selection,
    kind: "add" | "remove",
  ) {
    setBusy(true);
    setUndoFeedback("");
    setError("");
    try {
      const result = await api("/tag-actions", tagAction, {
        selection,
        ...(typeof tag === "string" ? { tagName: tag } : { tagId: tag.id }),
        action: kind,
      });
      setAction({
        id: result.actionId,
        message: `${kind === "add" ? "Added" : "Removed"} “${result.tag.name}” ${kind === "add" ? "to" : "from"} ${result.changedCount} songs.`,
      });
      setCursor(null);
      pageHistory.current = [];
      onChanged();
    } catch (error) {
      setError(errorMessage(error));
      throw error;
    } finally {
      setBusy(false);
    }
  }
  const selectedKeys = selection?.kind === "tracks" ? selection.trackKeys : [];
  return (
    <section aria-labelledby="library-title">
      <div className="section-heading">
        <div>
          <h2 id="library-title">Your library</h2>
        </div>
        <span className="muted">Browse together. Tag together.</span>
      </div>
      {guidance && (
        <aside className="guidance">
          <div>
            <strong>You never need to finish.</strong>
            <p>
              Start with your biggest artists. One tag can cover dozens of
              songs. Untagged is just a filter, and new songs will be waiting
              here.
            </p>
          </div>
          <button
            className="compact"
            aria-label="Dismiss first-run guidance"
            onClick={() => {
              setGuidance(false);
              try {
                localStorage.setItem("tagger-guidance-dismissed", "yes");
              } catch {
                /* Storage is optional for guidance. */
              }
            }}
          >
            ×
          </button>
        </aside>
      )}
      <p className="section-intro">
        Find a song, or tag a whole artist, album, or decade in one move.
      </p>
      <nav className="library-browse" aria-label="Browse library">
        {(["none", "artist", "album", "decade"] as const).map((view) => (
          <button
            key={view}
            aria-pressed={
              view === "none" ? !grouped : grouped && groupBy === view
            }
            onClick={() => {
              setGrouped(view !== "none");
              if (view !== "none") setGroupBy(view);
              setData(null);
              setCursor(null);
              pageHistory.current = [];
              setSelection(null);
            }}
          >
            {view === "none"
              ? "Songs"
              : view === "artist"
                ? "Artists"
                : view === "album"
                  ? "Albums"
                  : "Decades"}
          </button>
        ))}
      </nav>
      <div className="library-filters">
        <label className="search-label">
          Search your library
          <input
            type="search"
            placeholder="Song, artist, or album"
            value={filter.search}
            maxLength={200}
            onChange={(e) =>
              changeFilter({ ...filter, search: e.target.value })
            }
          />
        </label>
        <label>
          View
          <select
            value={filter.membership}
            onChange={(e) =>
              changeFilter({
                ...filter,
                membership: e.target.value as "active" | "removed",
                newOnly: false,
              })
            }
          >
            <option value="active">Liked Songs</option>
            <option value="removed">Removed from Spotify</option>
          </select>
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={filter.untagged}
            onChange={(e) =>
              changeFilter({ ...filter, untagged: e.target.checked })
            }
          />
          Untagged
        </label>
        <label className="desktop-bulk">
          Sort songs
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as Sort);
              setCursor(null);
              pageHistory.current = [];
              setSelection(null);
            }}
          >
            {(
              ["newest", "oldest", "title", "artist", "album", "year"] as const
            ).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button
          className="desktop-bulk"
          disabled={filter.membership === "removed"}
          onClick={() => onQueue(filter)}
        >
          Send this filter to queue
        </button>
      </div>
      <details className="filter-disclosure">
        <summary>
          More filters <span>Artist, album & decade</span>
        </summary>
        <Facets filter={filter} refresh={refresh} onChange={changeFilter} />
      </details>
      {filter.newOnly && (
        <p className="muted">
          Showing new additions.{" "}
          <button
            className="compact"
            onClick={() => changeFilter({ ...filter, newOnly: false })}
          >
            Show all songs
          </button>
        </p>
      )}
      {filter.membership === "removed" && (
        <p className="notice">
          Tags stay safe when you remove a song from Spotify. Re-liking restores
          them. Cached song details disappear after 90 days.
        </p>
      )}
      {tagError && (
        <p role="alert" className="notice">
          {tagError} Current assignments were rechecked; refresh results to
          retry.
        </p>
      )}
      {error && (
        <div role="alert" className="notice">
          {error}{" "}
          <button
            onClick={() => {
              setCursor(null);
              pageHistory.current = [];
              onChanged();
            }}
          >
            Refresh results
          </button>
        </div>
      )}
      {!data && !error && <p role="status">Loading your library…</p>}
      {data && (
        <>
          <div className="result-toolbar">
            <span>
              {data.totalTracks} songs
              {data.groupBy !== null
                ? ` · ${data.totalGroups} ${data.groupBy === "artist" ? "artists" : data.groupBy === "album" ? "albums" : "decades"}`
                : ""}
              <small className="page-range">
                Page {pageHistory.current.length + 1} · Showing{" "}
                {data.groupBy === null
                  ? data.tracks.length
                  : data.groups.length}{" "}
                {data.groupBy === null ? "songs" : "groups"}
              </small>
            </span>
            {data.totalTracks > 0 && (
              <button
                className="compact desktop-bulk"
                onClick={() =>
                  setSelection({
                    kind: "filter",
                    filter,
                    expectedRevision: data.revision,
                  })
                }
              >
                Select all {data.totalTracks} matching
              </button>
            )}
          </div>
          {data.totalTracks === 0 && (
            <div className="empty-state">
              <h3>
                {filter.membership === "removed"
                  ? "Nothing in the archive"
                  : filter.untagged
                    ? "No untagged songs here"
                    : filter.search || filter.newOnly
                      ? "No songs match this view"
                      : "Your library is waiting"}
              </h3>
              <p>
                {filter.membership === "removed"
                  ? "Songs removed from your Liked Songs appear here. Your tags stay safe for when you like them again."
                  : filter.search ||
                      filter.untagged ||
                      filter.newOnly ||
                      filter.artistId ||
                      filter.album ||
                      filter.decade
                    ? "Try a broader view. Your other songs and their tags are still here."
                    : "Like songs in Spotify, then use Sync now. You can tag them as soon as they arrive."}
              </p>
              {(filter.search ||
                filter.untagged ||
                filter.newOnly ||
                filter.artistId ||
                filter.album ||
                filter.decade) && (
                <button
                  onClick={() =>
                    changeFilter({
                      ...emptyFilter,
                      membership: filter.membership,
                    })
                  }
                >
                  Reset filters
                </button>
              )}
              {filter.membership === "removed" && (
                <button onClick={() => changeFilter({ ...emptyFilter })}>
                  Back to Liked Songs
                </button>
              )}
            </div>
          )}
          {data.groupBy !== null ? (
            <div className="artist-grid">
              {data.groups.map((group) => (
                <article className="artist-card" key={group.value}>
                  <a
                    className="group-artwork-link"
                    href={
                      groupBy === "artist"
                        ? `https://open.spotify.com/artist/${group.value}`
                        : `https://open.spotify.com/search/${encodeURIComponent(group.name)}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${group.name} in Spotify`}
                  >
                    <CollectionArtwork
                      url={
                        (group as typeof group & { artworkUrl?: string | null })
                          .artworkUrl
                      }
                      kind={
                        groupBy === "artist"
                          ? "artist"
                          : groupBy === "album"
                            ? "album"
                            : "decade"
                      }
                    />
                  </a>
                  <h3>{group.name}</h3>
                  <p>
                    {group.trackCount} songs · {group.taggedCount} tagged
                  </p>
                  <button
                    className="compact desktop-bulk group-select"
                    aria-label={`Tag all ${group.trackCount} songs by ${group.name}`}
                    onClick={() => setSelection(group.selection)}
                  >
                    Tag {group.trackCount} songs
                  </button>
                  <button
                    className="compact group-browse"
                    onClick={() => {
                      changeFilter({ ...group.selection.filter });
                      setGrouped(false);
                    }}
                  >
                    Browse songs →
                  </button>
                </article>
              ))}
            </div>
          ) : data.groupBy === null ? (
            <div className="track-list">
              <div
                className="track-table-heading desktop-bulk"
                aria-hidden="true"
              >
                <span>Song / artist / album</span>
                <span>Year · Added</span>
                <span>Tags</span>
              </div>
              {data.tracks.map((track) => (
                <article
                  className={`track-row ${editingTrack === track.trackKey ? "is-editing" : ""}`}
                  key={track.trackKey}
                >
                  <label className="desktop-bulk">
                    <input
                      type="checkbox"
                      aria-label={`Select ${track.metadata?.title ?? "track"}`}
                      checked={selectedKeys.includes(track.trackKey)}
                      onChange={(e) => {
                        setSelection({
                          kind: "tracks",
                          trackKeys: rangeSelection(
                            data.tracks.map((t) => t.trackKey),
                            selectedKeys,
                            anchor.current,
                            track.trackKey,
                            (e.nativeEvent as MouseEvent).shiftKey,
                            e.target.checked,
                          ),
                        });
                        anchor.current = track.trackKey;
                      }}
                    />
                  </label>
                  <div className="track-content">
                    <TrackSummary track={track} />
                    <p className="track-dates">
                      {track.metadata?.releaseDate?.slice(0, 4) ??
                        "Year unavailable"}{" "}
                      · Added{" "}
                      {track.metadata
                        ? new Date(track.metadata.likedAt).toLocaleDateString()
                        : "date unavailable"}
                    </p>
                    <div className="chips">
                      {track.tagIds.map((id) => {
                        const tag = knownTags.find((item) => item.id === id);
                        return tag ? (
                          <button
                            className="chip"
                            key={id}
                            disabled={busy}
                            aria-label={`Remove ${tag.name} from ${track.metadata?.title ?? "track"}`}
                            onClick={() =>
                              void mutate(
                                tag,
                                { kind: "tracks", trackKeys: [track.trackKey] },
                                "remove",
                              ).catch(() => {})
                            }
                          >
                            {tag.name} ×
                          </button>
                        ) : null;
                      })}
                      {track.tagIds.some(
                        (id) => !knownTags.some((tag) => tag.id === id),
                      ) && (
                        <span className="muted">Resolving assigned tags…</span>
                      )}
                    </div>
                    <button
                      className="compact edit-track"
                      aria-expanded={editingTrack === track.trackKey}
                      onClick={() =>
                        setEditingTrack(
                          editingTrack === track.trackKey
                            ? null
                            : track.trackKey,
                        )
                      }
                    >
                      {editingTrack === track.trackKey ? "Done" : "Edit tags"}
                      <span className="sr-only">
                        {" "}
                        for {track.metadata?.title ?? "track"}
                      </span>
                    </button>
                    {editingTrack === track.trackKey && (
                      <TagPicker
                        autoFocus
                        label={`Tag ${track.metadata?.title ?? "track"}`}
                        onCreate={(name) =>
                          mutate(
                            name,
                            { kind: "tracks", trackKeys: [track.trackKey] },
                            "add",
                          )
                        }
                        disabled={busy}
                        onChoose={(tag) =>
                          mutate(
                            tag,
                            { kind: "tracks", trackKeys: [track.trackKey] },
                            "add",
                          )
                        }
                      />
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : null}
          {filter.artistId && (
            <button
              className="compact"
              onClick={() => changeFilter({ ...filter, artistId: null })}
            >
              All artists
            </button>
          )}
          {(data.nextCursor || cursor) && (
            <nav className="result-pagination" aria-label="Library pages">
              <button
                disabled={!cursor}
                onClick={() => setCursor(pageHistory.current.pop() ?? null)}
              >
                ← Previous page
              </button>
              <span>Page {pageHistory.current.length + 1}</span>
              <button
                disabled={!data.nextCursor}
                onClick={() => {
                  pageHistory.current.push(cursor);
                  setCursor(data.nextCursor);
                }}
              >
                Next page →
              </button>
            </nav>
          )}
        </>
      )}
      {selection?.kind === "filter" &&
        data &&
        JSON.stringify(selection.expectedRevision) !==
          JSON.stringify(data.revision) && (
          <p role="status" className="notice">
            Your matching selection is from an earlier library revision. Select
            the matching results again to include the current set; its saved
            revision has not changed.
          </p>
        )}
      <div className="library-action-dock">
        {selection &&
          (selection.kind === "filter" || selection.trackKeys.length > 0) && (
            <div className="bulk-bar desktop-bulk">
              <strong>
                {selection.kind === "filter"
                  ? "Matching selection"
                  : `${selection.trackKeys.length} selected`}
              </strong>
              {data && (
                <BulkTags
                  selection={selection}
                  revision={data.revision}
                  refresh={refresh}
                  busy={busy}
                  onMutate={(tag, kind) => mutate(tag, selection, kind)}
                />
              )}
              <button
                className="compact"
                disabled={filter.membership === "removed"}
                onClick={() => onQueue(selection)}
              >
                Send selection to queue
              </button>
              <TagPicker
                label="Add tag to selection"
                selection={selection}
                selectionRevision={data?.revision}
                refresh={refresh}
                onCreate={(name) => mutate(name, selection, "add")}
                disabled={busy}
                onChoose={(tag) => mutate(tag, selection, "add")}
              />
              <TagPicker
                label="Remove tag from selection"
                selection={selection}
                selectionRevision={data?.revision}
                refresh={refresh}
                actionLabel="Remove"
                disabled={busy}
                onChoose={(tag) => mutate(tag, selection, "remove")}
              />
              <button className="compact" onClick={() => setSelection(null)}>
                Clear selection
              </button>
            </div>
          )}
        {undoFeedback && (
          <p role="status" className="notice">
            {undoFeedback}
          </p>
        )}
        {action && (
          <div className="toast" role="status">
            {action.message}
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api(
                    `/tag-actions/${action.id}/undo`,
                    undoAction,
                    {},
                  );
                  setAction(null);
                  setUndoFeedback(
                    result.skippedCount
                      ? `Restored ${result.restoredCount}; ${result.skippedCount} later edits were preserved.`
                      : `Restored ${result.restoredCount} changed assignments.`,
                  );
                  onChanged();
                } catch (error) {
                  setError(errorMessage(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Undo
            </button>
            <button
              className="compact"
              aria-label="Dismiss saved action"
              onClick={() => setAction(null)}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
