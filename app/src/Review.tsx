import { useRef, useState } from "react";
import type {
  ReviewDTO,
  ReviewDestinationsDTO,
  ReviewCommand,
  ReviewInput,
} from "../../supabase/functions/_shared/review-contracts";
import { ApiError, errorMessage } from "./api";
import {
  review,
  reviewCommand,
  reviewDestinations,
  reviewRequest,
  reviewWorking,
} from "./review-api";
import { useVisiblePolling } from "./useVisiblePolling";
import { QueuePlayback } from "./QueuePlayback";
const pendingKey = "tagger-review-command";
type Pending = { command: "done" | "discard" | "undo"; input: ReviewInput };
function restorePending(): Pending | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    return v &&
      ["done", "discard", "undo"].includes(v.command) &&
      typeof v.input?.requestId === "string" &&
      typeof v.input?.revision === "string"
      ? v
      : null;
  } catch {
    return null;
  }
}
function invalidDraftChoices(data: ReviewDTO | null, ids: string[]) {
  return ids.filter((id) => {
    const destination = data?.destinations.find((d) => d.id === id);
    return (
      !destination ||
      !destination.configured ||
      !destination.available ||
      destination.membership === "unavailable"
    );
  });
}
export function Review({
  active,
  playbackAllowed,
  refresh,
  onChanged,
}: {
  active: boolean;
  playbackAllowed: boolean;
  refresh: number;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ReviewDTO | null>(null),
    latest = useRef<ReviewDTO | null>(null);
  const [selected, setSelected] = useState<string[]>([]),
    choices = useRef<string[]>([]);
  const [saving, setSaving] = useState(false),
    savingRef = useRef(false),
    dirty = useRef(false);
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false);
  const [pending, setPending] = useState<Pending | null>(restorePending);
  const [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [config, setConfig] = useState<ReviewDestinationsDTO | null>(null),
    [configIds, setConfigIds] = useState<string[]>([]),
    [configSearch, setConfigSearch] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const epoch = useRef(0);
  function accept(next: ReviewDTO) {
    latest.current = next;
    setData(next);
    const ids =
      next.draft &&
      next.current &&
      next.draft.trackKey === next.current.trackKey
        ? next.draft!.destinationIds
        : [];
    choices.current = ids;
    setSelected(ids);
    setConfirmDiscard(false);
  }
  function failed(e: unknown) {
    if (
      e instanceof ApiError &&
      ["stale_revision", "request_conflict"].includes(e.code)
    ) {
      setConflict(true);
      setError(
        "Review changed on another device. Reload the saved review before continuing.",
      );
    } else {
      const messages: Record<string, string> = {
        unknown_track:
          "This exact track is no longer available in the liked backlog. Refresh the review.",
        unknown_playlist:
          "A destination is no longer available. Refresh and check your configured destinations.",
        playlist_busy:
          "A destination is already being updated. Wait for it to finish, then retry the saved action.",
        invalid_action:
          "This action is not available in the saved review state. Refresh to check its progress.",
      };
      setError((e instanceof ApiError && messages[e.code]) || errorMessage(e));
    }
  }
  useVisiblePolling({
    enabled: active,
    refreshKey: `${refresh}:${attempt}`,
    load: async (signal) => {
      const started = epoch.current;
      return {
        started,
        value: await reviewRequest("", review, undefined, signal),
      };
    },
    receive: ({ started, value: next }) => {
      if (started !== epoch.current) return;
      if (busyRef.current || savingRef.current || dirty.current || config)
        return;
      accept(next);
    },
    working: ({ value }) => reviewWorking(value),
    onError: failed,
  });
  async function saveDraft(): Promise<boolean> {
    if (savingRef.current) return false;
    // The server rejects a draft containing any invalid destination. Keep
    // intermediate local removals until the whole remaining draft is valid.
    if (invalidDraftChoices(latest.current, choices.current).length)
      return false;
    epoch.current++;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      while (dirty.current) {
        const current = latest.current;
        if (!current?.current) return false;
        const ids = [...choices.current];
        dirty.current = false;
        try {
          const next = await reviewCommand("draft", {
            revision: current.revision,
            trackKey: current.current.trackKey,
            destinationIds: ids,
          });
          latest.current = next;
          setData(next);
          // A later tap owns the local draft until its own acknowledgement.
          if (!dirty.current) {
            choices.current = ids;
            setSelected(ids);
          }
        } catch (e) {
          dirty.current = true;
          throw e;
        }
      }
      return true;
    } catch (e) {
      failed(e);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      setAttempt((v) => v + 1);
    }
  }
  function toggle(id: string) {
    if (busyRef.current || savingRef.current || conflict || pending) return;
    const ids = choices.current.includes(id)
      ? choices.current.filter((v) => v !== id)
      : [...choices.current, id];
    choices.current = ids;
    setSelected(ids);
    dirty.current = true;
    void saveDraft();
  }
  async function execute(
    command: ReviewCommand,
    extra: Partial<ReviewInput> = {},
    retry?: Pending,
  ) {
    if (busyRef.current || savingRef.current || conflict || !latest.current)
      return;
    epoch.current++;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      if (dirty.current && !(await saveDraft())) return;
      const current = latest.current!;
      const input: ReviewInput = retry?.input ?? {
        revision:
          command === "destinations" && config
            ? config.revision
            : current.revision,
        ...extra,
      };
      const durable = ["done", "discard", "undo"].includes(command);
      if (durable && !retry) input.requestId = crypto.randomUUID();
      if (durable) {
        const intent = { command, input } as Pending;
        setPending(intent);
        try {
          sessionStorage.setItem(pendingKey, JSON.stringify(intent));
        } catch {
          /* Same mounted intent remains retryable. */
        }
      }
      const next = await reviewCommand(command, input);
      accept(next);
      dirty.current = false;
      setPending(null);
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        /* Server remains authoritative. */
      }
      setConfig(null);
      setAttempt((v) => v + 1);
      onChanged();
    } catch (e) {
      failed(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function configure() {
    if (busyRef.current || savingRef.current || dirty.current || pending)
      return;
    setBusy(true);
    epoch.current++;
    busyRef.current = true;
    setError("");
    try {
      const next = await reviewRequest("/destinations", reviewDestinations);
      setConfig(next);
      setConfigIds(next.items.filter((d) => d.configured).map((d) => d.id));
      setConfigSearch("");
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }
  const operation = data?.operation;
  const operating =
    !!operation &&
    ["queued", "adding", "unliking", "undoing", "needs_attention"].includes(
      operation.status,
    );
  const locked = busy || saving || conflict || !!pending || operating;
  const current = data?.current,
    metadata = current?.metadata;
  const invalidSelected = invalidDraftChoices(data, selected);
  const desired =
    selected.length > 0 ||
    !!data?.destinations.some(
      (d) => d.configured && d.membership === "present",
    );
  const membershipsReady =
    !!data &&
    data.destinations
      .filter((d) => d.configured)
      .every(
        (d) => d.membership !== "unknown" && d.membership !== "checking",
      ) &&
    selected.every((id) =>
      data.destinations.some(
        (d) =>
          d.id === id &&
          d.configured &&
          d.available &&
          ["present", "absent"].includes(d.membership),
      ),
    );
  return (
    <section className="review" aria-labelledby="review-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">One song at a time</p>
          <h2 id="review-title">Liked Songs review</h2>
        </div>
        <button
          aria-label="Choose destinations"
          disabled={locked}
          onClick={() => void configure()}
        >
          Destinations
        </button>
      </div>
      <p className="muted review-intro">
        Oldest liked first · Choose playlists, then Done.
      </p>
      {error && (
        <div role="alert" className="notice">
          {error}
          {conflict ? (
            <button
              onClick={() => {
                dirty.current = false;
                setConflict(false);
                setError("");
                setPending(null);
                try {
                  sessionStorage.removeItem(pendingKey);
                } catch {
                  /* Reloading authoritative state works without browser storage. */
                }
                setConfig(null);
                setAttempt((v) => v + 1);
              }}
            >
              Reload saved review
            </button>
          ) : pending ? (
            <button
              disabled={busy}
              onClick={() => void execute(pending.command, {}, pending)}
            >
              Retry saved action
            </button>
          ) : dirty.current ? (
            <button disabled={saving} onClick={() => void saveDraft()}>
              Retry saving choices
            </button>
          ) : (
            <button onClick={() => setAttempt((v) => v + 1)}>
              Refresh review
            </button>
          )}
        </div>
      )}
      {pending && !error && (
        <div className="notice" role="status">
          An action still needs confirmation.{" "}
          <button
            disabled={busy}
            onClick={() => void execute(pending.command, {}, pending)}
          >
            Check saved action
          </button>
        </div>
      )}
      {!data && <p role="status">Preparing your Liked Songs review…</p>}
      {config && (
        <div className="review-configuration">
          <h3>Playlists you maintain</h3>
          <p>
            Choose existing owned playlists to offer here. This does not change
            tagging Sources. Generated playlists are excluded.
          </p>
          <label>
            Find a destination
            <input
              value={configSearch}
              onChange={(e) => setConfigSearch(e.target.value)}
            />
          </label>
          {config.discoveryStatus !== "ready" && (
            <p role="status">
              {config.discoveryStatus === "pending"
                ? "Finding your playlists… Close and check again shortly."
                : "Playlist discovery is unavailable. Try again later."}
            </p>
          )}
          <div className="review-destinations">
            {config.items
              .filter((d) =>
                d.name
                  .toLocaleLowerCase()
                  .includes(configSearch.toLocaleLowerCase()),
              )
              .map((d) => (
                <label className="review-destination" key={d.id}>
                  <input
                    type="checkbox"
                    checked={configIds.includes(d.id)}
                    disabled={busy || (!d.available && !d.configured)}
                    onChange={() =>
                      setConfigIds((ids) =>
                        ids.includes(d.id)
                          ? ids.filter((id) => id !== d.id)
                          : [...ids, d.id],
                      )
                    }
                  />
                  <DestinationIdentity destination={d} />
                  <span>
                    {!d.available
                      ? "Unavailable"
                      : configIds.includes(d.id)
                        ? "Offered in review"
                        : ""}
                  </span>
                </label>
              ))}
          </div>
          <div className="review-config-actions">
            <button disabled={busy} onClick={() => setConfig(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || config.discoveryStatus !== "ready"}
              onClick={() =>
                void execute("destinations", { destinationIds: configIds })
              }
            >
              Save destinations
            </button>
          </div>
        </div>
      )}
      {data && !config && (
        <>
          <div className="review-counts">
            {data.remaining} waiting · {data.skipped} skipped{" "}
            <details className="review-session">
              <summary>Session</summary>
              <p>
                Skipped tracks stay aside until you start a new session. Saved
                choices remain.
              </p>
              <button
                className="compact"
                disabled={locked}
                onClick={() => void execute("session")}
              >
                Start new session
              </button>
            </details>
          </div>
          {data.syncStatus !== "ready" && (
            <p className="notice" role="status">
              {data.syncStatus === "pending"
                ? "Syncing Liked Songs. Review will be ready after verification."
                : "Liked Songs sync is unavailable. Reconnect or try Sync now."}
            </p>
          )}
          {!data.destinations.length && (
            <div className="notice">
              <strong>Start with the playlists you maintain.</strong>
              <p>No destinations are configured yet.</p>
              <button disabled={locked} onClick={() => void configure()}>
                Set up destinations
              </button>
            </div>
          )}
          {current ? (
            <div className="review-layout">
              <div className="review-song">
                {metadata?.artworkUrl ? (
                  <img
                    className="review-cover"
                    src={metadata.artworkUrl}
                    alt=""
                  />
                ) : (
                  <div
                    className="review-cover review-cover-placeholder"
                    aria-hidden="true"
                  >
                    ♪
                  </div>
                )}
                <div>
                  <h3>{metadata?.title ?? "Track metadata unavailable"}</h3>
                  <p>
                    {metadata?.artists.map((a) => a.name).join(", ") ??
                      "Artist unavailable"}
                  </p>
                  <p className="muted">
                    {metadata?.album}
                    {metadata?.releaseDate &&
                      ` · ${metadata.releaseDate.slice(0, 4)}`}
                    {metadata?.durationMs &&
                      ` · ${Math.floor(metadata.durationMs / 60000)}:${String(Math.floor(metadata.durationMs / 1000) % 60).padStart(2, "0")}`}
                  </p>
                  {metadata && (
                    <p className="muted">
                      Liked {new Date(metadata.likedAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <QueuePlayback
                  trackKey={current.trackKey}
                  available={!!metadata?.playableUri && !!metadata.durationMs}
                  active={active && playbackAllowed && !operating}
                />
                {metadata?.spotifyUrl && (
                  <a
                    className="review-spotify-link"
                    href={metadata.spotifyUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Spotify ↗
                  </a>
                )}
              </div>
              <div className="review-choices">
                <h3>Add to your playlists</h3>
                <p className="muted">
                  {saving
                    ? "Saving choices…"
                    : dirty.current
                      ? "Choices need saving."
                      : "Choices saved. Spotify changes only after Done."}
                </p>
                {invalidSelected.length > 0 && (
                  <div className="notice" role="status">
                    <p>
                      Remove unavailable or unconfigured saved choices to
                      continue. Choices will save after all of these are
                      removed. Existing playlist memberships stay intact.
                    </p>
                    {invalidSelected.map((id, index) => {
                      const name =
                        data.destinations.find((d) => d.id === id)?.name ??
                        `Saved destination ${index + 1}`;
                      return (
                        <div key={id}>
                          <strong>{name}</strong>{" "}
                          <button
                            disabled={locked}
                            onClick={() => toggle(id)}
                            aria-label={`Remove saved choice for ${name}`}
                          >
                            Remove saved choice
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="review-destinations">
                  {data.destinations.map((d) => (
                    <label
                      key={d.id}
                      className={`review-destination ${d.membership === "present" ? "already-added" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={
                          d.membership === "present" || selected.includes(d.id)
                        }
                        disabled={
                          locked ||
                          d.membership === "present" ||
                          (!selected.includes(d.id) &&
                            (d.membership !== "absent" ||
                              !d.available ||
                              !d.configured))
                        }
                        onChange={() => toggle(d.id)}
                      />
                      <DestinationIdentity destination={d} />
                      <span>
                        {d.membership === "present"
                          ? "Already added"
                          : !d.configured
                            ? selected.includes(d.id)
                              ? "No longer configured · remove the saved choice"
                              : "No longer configured"
                            : !d.available || d.membership === "unavailable"
                              ? selected.includes(d.id)
                                ? "Unavailable · remove the saved choice or check Spotify"
                                : "Unavailable · check Spotify"
                              : ["unknown", "checking"].includes(d.membership)
                                ? "Checking membership…"
                                : selected.includes(d.id)
                                  ? "Selected"
                                  : "Add"}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <h3>
                {data.skipped
                  ? "All set for this session"
                  : "No liked tracks waiting"}
              </h3>
              <p>
                {data.skipped
                  ? "Start a new session to return to skipped songs."
                  : "New likes will appear here after sync."}
              </p>
            </div>
          )}
          {operation && (
            <div className="notice" role="status">
              {operation.status === "needs_attention"
                ? "This action is incomplete. Your track has not been reported as finished."
                : operation.status === "adding" || operation.status === "queued"
                  ? `Adding to playlists · ${operation.completedDestinations} of ${operation.totalDestinations} confirmed`
                  : operation.status === "unliking"
                    ? "Playlist choices confirmed. Finishing the liked-track change…"
                    : operation.status === "undoing"
                      ? "Restoring the like and checking this action’s additions…"
                      : operation.status === "undone"
                        ? "Undo finished."
                        : "Track handled."}
              {operation.reversalIncomplete && (
                <p>
                  Some playlist changes could not safely be reversed. They were
                  left intact; check Spotify before making corrections.
                </p>
              )}
              {operation.status === "needs_attention" && (
                <>
                  <button
                    disabled={busy || !!pending || conflict}
                    onClick={() =>
                      void execute("retry", { operationId: operation.id })
                    }
                  >
                    Retry incomplete action
                  </button>
                  <p>
                    {operation.canCancel
                      ? "Return to review keeps confirmed playlist additions. This action has not sent an unlike."
                      : "Return to review is unavailable until the remote changes are safely reconciled."}
                  </p>
                  <button
                    disabled={
                      busy || !!pending || conflict || !operation.canCancel
                    }
                    onClick={() =>
                      void execute("cancel", { operationId: operation.id })
                    }
                  >
                    Return to review
                  </button>
                </>
              )}
            </div>
          )}
          {data.undo && (
            <div className="review-undo">
              <span>
                Most recent {data.undo.kind === "discard" ? "Discard" : "Done"}{" "}
                can be undone. Restoring a like may change its liked date;
                concurrent playlist edits can limit reversal.
              </span>
              <button
                disabled={locked}
                onClick={() =>
                  void execute("undo", { operationId: data.undo!.id })
                }
              >
                Undo most recent
              </button>
            </div>
          )}
          {current && (
            <div className="review-actions">
              {confirmDiscard ? (
                <div
                  className="review-discard-confirm"
                  role="group"
                  aria-label="Confirm discard"
                >
                  <span>Unlike this track without adding it anywhere?</span>
                  <button
                    disabled={locked}
                    onClick={() => setConfirmDiscard(false)}
                  >
                    Keep reviewing
                  </button>
                  <button
                    disabled={locked}
                    onClick={() =>
                      void execute("discard", {
                        trackKey: current.trackKey,
                        confirmation: true,
                      })
                    }
                  >
                    Confirm Discard
                  </button>
                </div>
              ) : (
                <>
                  <button
                    disabled={locked}
                    onClick={() =>
                      void execute("skip", { trackKey: current.trackKey })
                    }
                  >
                    Skip for now
                  </button>
                  <button
                    disabled={locked}
                    onClick={() => setConfirmDiscard(true)}
                  >
                    Discard
                  </button>
                  <button
                    className="primary"
                    disabled={
                      locked ||
                      !desired ||
                      !membershipsReady ||
                      data.syncStatus !== "ready"
                    }
                    onClick={() =>
                      void execute("done", { trackKey: current.trackKey })
                    }
                  >
                    Done
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
function DestinationIdentity({
  destination: d,
}: {
  destination: ReviewDTO["destinations"][number];
}) {
  return (
    <span className="review-destination-identity">
      {d.artworkUrl ? (
        <img src={d.artworkUrl} alt="" loading="lazy" />
      ) : (
        <span className="review-destination-placeholder" aria-hidden="true">
          ♫
        </span>
      )}
      <strong>{d.name}</strong>
    </span>
  );
}
