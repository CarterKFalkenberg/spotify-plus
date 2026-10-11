import { useEffect, useState } from "react";
import type {
  LibraryFilter,
  LibrarySearchResponse,
  Selection,
  TagDTO,
  TrackDTO,
} from "../../supabase/functions/_shared/contracts";
import {
  api,
  librarySearch,
  tagAction,
  undoAction,
  errorMessage,
  tags,
} from "./api";
import { TagPicker } from "./TagPicker";
export const emptyFilter: LibraryFilter = {
  membership: "active",
  search: "",
  untagged: false,
  newOnly: false,
  artistId: null,
};
export function TrackSummary({ track }: { track: TrackDTO }) {
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
      {m?.spotifyUrl && (
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
}: {
  refresh: number;
  newOnly: boolean;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<LibraryFilter>({
    ...emptyFilter,
    newOnly,
  });
  const [grouped, setGrouped] = useState(!newOnly);
  const [data, setData] = useState<LibrarySearchResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [knownTags, setKnownTags] = useState<readonly TagDTO[]>([]);
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
    setGrouped(!newOnly);
    setCursor(null);
    setSelection(null);
  }, [newOnly]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setSelection(null);
    setError("");
    const timer = setTimeout(() => {
      void api(
        "/library/search",
        librarySearch,
        { filter, groupBy: grouped ? "artist" : null, cursor, limit: 50 },
        controller.signal,
      )
        .then(setData)
        .catch((error) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filter, grouped, cursor, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    void api("/tags?limit=100", tags, undefined, controller.signal)
      .then((v) => setKnownTags(v.tags))
      .catch(() => {});
    return () => controller.abort();
  }, [refresh]);
  function changeFilter(next: LibraryFilter) {
    setFilter(next);
    setCursor(null);
    setSelection(null);
  }
  async function mutate(
    tag: TagDTO,
    selection: Selection,
    kind: "add" | "remove",
  ) {
    setBusy(true);
    setError("");
    try {
      const result = await api("/tag-actions", tagAction, {
        selection,
        tagId: tag.id,
        action: kind,
      });
      setAction({
        id: result.actionId,
        message: `${kind === "add" ? "Added" : "Removed"} “${tag.name}” ${kind === "add" ? "to" : "from"} ${result.changedCount} songs.`,
      });
      setCursor(null);
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
          <div className="eyebrow">MAKE A LITTLE ORDER</div>
          <h2 id="library-title">Your library</h2>
        </div>
        <span className="muted">Tags save as you go</span>
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
        <label className="check-label desktop-bulk">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => {
              setGrouped(e.target.checked);
              setCursor(null);
            }}
          />
          Group by artist
        </label>
      </div>
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
      {error && (
        <div role="alert" className="notice">
          {error}{" "}
          <button
            onClick={() => {
              setCursor(null);
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
              {data.groupBy === "artist"
                ? ` · ${data.totalGroups} artists`
                : ""}
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
                Like songs in Spotify, then sync here. Your tags will have a
                place to land.
              </p>
            </div>
          )}
          {data.groupBy === "artist" ? (
            <div className="artist-grid">
              {data.groups.map((group) => (
                <article className="artist-card" key={group.artistId}>
                  <div className="artist-monogram" aria-hidden="true">
                    {group.name.slice(0, 1)}
                  </div>
                  <h3>{group.name}</h3>
                  <p>
                    {group.trackCount} songs · {group.taggedCount} tagged
                  </p>
                  <div className="desktop-bulk">
                    <TagPicker
                      label={`Tag all ${group.trackCount} songs by ${group.name}`}
                      allowCreate
                      disabled={busy}
                      onChoose={(tag) => mutate(tag, group.selection, "add")}
                    />
                    <button
                      className="compact"
                      onClick={() => setSelection(group.selection)}
                    >
                      Select group
                    </button>
                  </div>
                  <button
                    className="compact"
                    onClick={() => {
                      changeFilter({ ...filter, artistId: group.artistId });
                      setGrouped(false);
                    }}
                  >
                    Browse songs →
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="track-list">
              {data.tracks.map((track) => (
                <article className="track-row" key={track.trackKey}>
                  <label className="desktop-bulk">
                    <input
                      type="checkbox"
                      aria-label={`Select ${track.metadata?.title ?? "track"}`}
                      checked={selectedKeys.includes(track.trackKey)}
                      onChange={(e) =>
                        setSelection({
                          kind: "tracks",
                          trackKeys: e.target.checked
                            ? [...selectedKeys, track.trackKey]
                            : selectedKeys.filter(
                                (key) => key !== track.trackKey,
                              ),
                        })
                      }
                    />
                  </label>
                  <div className="track-content">
                    <TrackSummary track={track} />
                    <div className="chips">
                      {track.tagIds.map((id) => (
                        <button
                          className="chip"
                          key={id}
                          disabled={busy}
                          aria-label={`Remove ${knownTags.find((t) => t.id === id)?.name ?? "tag"} from ${track.metadata?.title ?? "track"}`}
                          onClick={() =>
                            void mutate(
                              knownTags.find((t) => t.id === id) ?? {
                                id,
                                name: "tag",
                                activeTrackCount: 0,
                                lastUsedAt: null,
                              },
                              { kind: "tracks", trackKeys: [track.trackKey] },
                              "remove",
                            ).catch(() => {})
                          }
                        >
                          {knownTags.find((t) => t.id === id)?.name ?? "Tag"} ×
                        </button>
                      ))}
                    </div>
                    <TagPicker
                      label={`Tag ${track.metadata?.title ?? "track"}`}
                      allowCreate
                      disabled={busy}
                      onChoose={(tag) =>
                        mutate(
                          tag,
                          { kind: "tracks", trackKeys: [track.trackKey] },
                          "add",
                        )
                      }
                    />
                  </div>
                </article>
              ))}
            </div>
          )}
          {filter.artistId && (
            <button
              className="compact"
              onClick={() => changeFilter({ ...filter, artistId: null })}
            >
              All artists
            </button>
          )}
          {data.nextCursor && (
            <button onClick={() => setCursor(data.nextCursor)}>
              Next results
            </button>
          )}
          {cursor && (
            <button className="compact" onClick={() => setCursor(null)}>
              Back to first results
            </button>
          )}
        </>
      )}
      {selection &&
        (selection.kind === "filter" || selection.trackKeys.length > 0) && (
          <div className="bulk-bar desktop-bulk">
            <strong>
              {selection.kind === "filter"
                ? "Matching selection"
                : `${selection.trackKeys.length} selected`}
            </strong>
            <TagPicker
              label="Add tag to selection"
              allowCreate
              disabled={busy}
              onChoose={(tag) => mutate(tag, selection, "add")}
            />
            <div>
              <label>
                Remove tag from selection
                <select
                  defaultValue=""
                  disabled={busy}
                  onChange={(event) => {
                    const tag = knownTags.find(
                      (t) => t.id === event.target.value,
                    );
                    if (tag)
                      void mutate(tag, selection, "remove").catch(() => {});
                    event.target.value = "";
                  }}
                >
                  <option value="" disabled>
                    Choose tag to remove…
                  </option>
                  {knownTags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button className="compact" onClick={() => setSelection(null)}>
              Clear selection
            </button>
          </div>
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
                setError(
                  result.skippedCount
                    ? `Restored ${result.restoredCount}; ${result.skippedCount} later edits were preserved.`
                    : "",
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
    </section>
  );
}
