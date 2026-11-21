import type { Database } from "./database.ts";
import type { FeatureJob } from "./library.ts";
import type { Job } from "./jobs.ts";
import {
  SpotifyClient,
  SpotifyError,
  spotifyPlaylistOwnedBy,
} from "./spotify.ts";
import type { SecretBox } from "./crypto.ts";
import { databasePacing, OwnerTokens } from "./tokens.ts";

interface Item {
  playlist_id: string;
  state: string;
  snapshot_id: string | null;
}
interface Membership {
  playlist_id: string;
  status: string;
  snapshot_id: string | null;
  next_offset: number;
  observed: number;
  occurrences: number;
  total: number | null;
  checked_at: string | null;
}
interface Operation {
  id: string;
  status: string;
  phase: string;
  kind: string;
  verification_started_at?: string | null;
}
export interface ReviewWorkerState {
  accountId: string;
  trackKey: string;
  uri: string;
  operation: Operation | null;
  items: Item[];
  memberships: Membership[];
  destinations: string[];
  cache: Membership[];
}
type ReviewSpotify = Pick<
  SpotifyClient,
  | "getCurrentUser"
  | "getPlaylist"
  | "getPlaylistItemsPage"
  | "containsTracks"
  | "reviewAppend"
  | "reviewUnlike"
  | "reviewRestore"
  | "reviewReverse"
>;
export function createReviewRunner(input: {
  db: Database;
  spotify: (job: Job) => ReviewSpotify;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): FeatureJob {
  const now = input.now ?? Date.now;
  const wait = input.wait ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (job, deadline) => {
    if (job.epoch === null || !["review", "review_check"].includes(job.kind)) {
      throw new Error("invalid_review_job");
    }
    const base = { p_epoch: job.epoch, p_job: job.id, p_lease: job.leaseToken };
    const state = await input.db.rpc<ReviewWorkerState | null>(
      "app_review_worker",
      base,
    );
    if (!state) return null;
    const o = state.operation;
    if (
      o &&
      ["completed", "undone", "cancelled", "needs_attention"].includes(o.status)
    ) {
      return { done: true };
    }
    if (!state.uri || !/^spotify:track:[A-Za-z0-9]{22}$/.test(state.uri)) {
      return { done: true };
    }
    const client = input.spotify(job);
    const identity = await client.getCurrentUser();
    if (identity.accountId !== state.accountId) throw new SpotifyError("guard");
    const transition = (
      event: string,
      playlist: string | null = null,
      snapshot: string | null = null,
      error: string | null = null,
    ) =>
      input.db.rpc<boolean>("app_review_transition", {
        ...base,
        p_event: event,
        p_playlist: playlist,
        p_snapshot: snapshot,
        p_error: error,
      });
    const attention = async (code: string) => {
      await transition("attention", null, null, code);
      return { done: true };
    };
    const observe = (playlist: string, value: Record<string, unknown>) =>
      input.db.rpc<boolean>("app_review_scan", {
        ...base,
        p_playlist: playlist,
        p_observation: value,
      });
    const scan = async (id: string, _previous?: Membership) => {
      const missing = async (code: string) => {
        await observe(id, {
          status: "unavailable",
          offset: 0,
          observed: 0,
          occurrences: 0,
          total: null,
          snapshotId: null,
          errorCode: code,
        });
        return "unavailable";
      };
      if (now() >= deadline - 20000) return "checking";
      try {
        const playlist = await client.getPlaylist(id);
        if (!spotifyPlaylistOwnedBy(playlist, identity)) {
          return await missing("destination_not_owned");
        }
        // Metadata snapshots can remain unchanged after item changes. Only an
        // unfinished scan checkpoint may resume; ready indexes prove no freshness.
        const cache = state.cache.find((c) =>
          c.playlist_id === id && c.snapshot_id === playlist.snapshotId &&
          c.status === "checking"
        );
        let offset = cache?.next_offset ?? 0;
        const fromOffset = offset;
        let observed = cache?.observed ?? 0;
        let occurrences = cache?.occurrences ?? 0;
        let reset = !cache;
        await wait(550);
        const page = await client.getPlaylistItemsPage(id, {
          offset,
          limit: 50,
        });
        const consistentTotal = !cache || cache.total === null ||
          cache.total === page.total;
        observed += page.items.length;
        occurrences += page.items.filter((item) =>
          item.uri === state.uri
        ).length;
        let uris = page.items.flatMap((item) => item.uri ? [item.uri] : []);
        let status = "checking";
        if (!consistentTotal) {
          offset = 0;
          observed = 0;
          occurrences = 0;
          uris = [];
          reset = true;
        } else if (page.nextOffset === null) {
          await wait(550);
          const after = await client.getPlaylist(id);
          if (!spotifyPlaylistOwnedBy(after, identity)) {
            return await missing("destination_not_owned");
          }
          if (
            after.snapshotId === playlist.snapshotId && observed === page.total
          ) status = occurrences > 0 ? "present" : "absent";
          else {
            offset = 0;
            observed = 0;
            occurrences = 0;
            uris = [];
            reset = true;
          }
        } else offset = page.nextOffset;
        await observe(id, {
          status,
          snapshotId: playlist.snapshotId,
          offset,
          observed,
          occurrences,
          total: page.total,
          errorCode: null,
          uris,
          reset,
          fromOffset,
          initial: !cache,
        });
        return status;
      } catch (error) {
        if (
          error instanceof SpotifyError &&
          ["not_found", "forbidden"].includes(error.kind)
        ) return await missing("destination_unavailable");
        throw error;
      }
    };
    if (!o) {
      const id = state.destinations.find((id) => {
        const m = state.memberships.find((m) => m.playlist_id === id);
        return !m?.checked_at || Date.parse(m.checked_at) < now() - 300000;
      });
      if (!id) return { done: true };
      await scan(id, state.memberships.find((m) => m.playlist_id === id));
      return { done: false, retryMs: 1000 };
    }
    // A process lost after committing a send intent cannot know whether dispatch
    // occurred. Reclaimed work reconciles; it never replays an uncertain POST.
    const sent = state.items.find((i) => i.state === "sending");
    if (sent) {
      await transition("append_uncertain", sent.playlist_id);
      return { done: false, retryMs: 1000 };
    }
    if (o.phase.startsWith("restore_") || o.phase.startsWith("unlike_")) {
      const restoring = o.phase.startsWith("restore_");
      const liked = (await client.containsTracks([state.uri]))[0];
      const satisfied = restoring ? liked : !liked;
      if (!restoring && o.phase.endsWith("pending")) {
        // Each destination is read completely once in the server-owned final
        // round. A rolling TTL makes slow rounds expire their own early reads.
        // This sequential pass is not an atomic remote snapshot.
        for (const item of state.items) {
          if (!state.destinations.includes(item.playlist_id)) {
            return await attention("destination_unavailable");
          }
          const membership = state.memberships.find((m) =>
            m.playlist_id === item.playlist_id
          );
          if (
            !membership ||
            ["unknown", "checking"].includes(membership.status) ||
            !membership.checked_at || !o.verification_started_at ||
            Date.parse(membership.checked_at) <
              Date.parse(o.verification_started_at)
          ) {
            await scan(item.playlist_id);
            return { done: false, retryMs: 1000 };
          }
          if (membership.status !== "present") {
            return await attention(
              membership.status === "unavailable"
                ? "destination_unavailable"
                : "membership_changed",
            );
          }
        }
      }
      if (satisfied) {
        // Even an already satisfied pending command traverses the durable intent
        // state before finalization; no raw HTTP acknowledgement is assumed.
        if (o.phase.endsWith("pending")) {
          if (
            !await transition(restoring ? "restore_intent" : "unlike_intent")
          ) return null;
        }
        if (!await transition(restoring ? "restored" : "completed")) {
          return null;
        }
        return restoring ? { done: false, retryMs: 1000 } : { done: true };
      }
      if (!o.phase.endsWith("pending")) {
        await transition(restoring ? "restore_retry" : "unlike_retry");
        return { done: false, retryMs: 1000 };
      }
      if (!await transition(restoring ? "restore_intent" : "unlike_intent")) {
        return null;
      }
      await wait(550);
      try {
        if (restoring) await client.reviewRestore(o.id, state.uri);
        else await client.reviewUnlike(o.id, state.uri);
      } catch (error) {
        // Both successful and ambiguous idempotent library writes are verified
        // by containment in a later bounded invocation, including after crash.
        if (
          error instanceof SpotifyError &&
          ["forbidden", "not_found", "guard"].includes(error.kind)
        ) {
          return await attention(
            error.kind === "guard"
              ? "destination_unavailable"
              : "spotify_forbidden",
          );
        }
        throw error;
      }
      await transition(restoring ? "restore_check" : "unlike_check");
      return { done: false, retryMs: 1000 };
    }
    if (o.phase === "reversing") {
      for (const item of state.items) {
        if (
          ["preexisting", "reversed", "reversal_unavailable"].includes(
            item.state,
          )
        ) continue;
        const unavailable = async () => {
          if (!await transition("reverse_unavailable", item.playlist_id)) {
            return null;
          }
          return { done: false, retryMs: 1000 };
        };
        if (item.state === "unconfirmed") return await unavailable();
        if (item.state === "reverse_sending") {
          // A reclaimed send intent may already have reached Spotify. Never
          // dispatch it again; only a later complete read can settle absence.
          if (!await transition("reverse_check", item.playlist_id)) return null;
          return { done: false, retryMs: 1000 };
        }
        const membership = state.memberships.find((m) =>
          m.playlist_id === item.playlist_id
        );
        if (
          !membership || ["unknown", "checking"].includes(membership.status) ||
          !membership.checked_at ||
          Date.parse(membership.checked_at) < now() - 60000
        ) {
          await scan(item.playlist_id);
          return { done: false, retryMs: 1000 };
        }
        if (item.state === "reverse_check") {
          if (membership.status !== "absent" || membership.occurrences !== 0) {
            return await unavailable();
          }
          if (!await transition("reversed", item.playlist_id)) return null;
          return { done: false, retryMs: 1000 };
        }
        if (
          item.state !== "confirmed" || membership.status !== "present" ||
          membership.occurrences !== 1 || !item.snapshot_id ||
          membership.snapshot_id !== item.snapshot_id
        ) return await unavailable();
        if (now() >= deadline - 20000) return { done: false, retryMs: 1000 };
        try {
          const live = await client.getPlaylist(item.playlist_id);
          if (
            !spotifyPlaylistOwnedBy(live, identity) ||
            live.snapshotId !== item.snapshot_id
          ) return await unavailable();
        } catch (error) {
          if (
            error instanceof SpotifyError &&
            ["forbidden", "not_found"].includes(error.kind)
          ) return await unavailable();
          throw error;
        }
        // Fresh reads narrow attribution; they are not a remote atomic version
        // precondition. The provider can still change after this last read.
        if (
          !await transition(
            "reverse_intent",
            item.playlist_id,
            item.snapshot_id,
          )
        ) return null;
        await wait(550);
        try {
          const result = await client.reviewReverse(
            o.id,
            item.playlist_id,
            state.uri,
            item.snapshot_id,
          );
          await transition(
            "reverse_check",
            item.playlist_id,
            result.snapshotId,
          );
        } catch (error) {
          if (
            error instanceof SpotifyError &&
            ["forbidden", "not_found"].includes(error.kind)
          ) return await unavailable();
          await transition("reverse_check", item.playlist_id);
          if (
            error instanceof SpotifyError &&
            ["authentication", "cooldown", "rate_limit", "quota"].includes(
              error.kind,
            )
          ) throw error;
        }
        return { done: false, retryMs: 1000 };
      }
      if (!await transition("undone")) return null;
      return { done: true };
    }
    // Revalidate every selected destination, including acknowledged additions,
    // before permitting unlike. Present is never inferred from a missing cache.
    for (const item of state.items) {
      if (!state.destinations.includes(item.playlist_id)) {
        return await attention("destination_unavailable");
      }
      const membership = state.memberships.find((m) =>
        m.playlist_id === item.playlist_id
      );
      if (
        !membership || membership.status === "unknown" ||
        membership.status === "checking" || !membership.checked_at ||
        (item.state === "pending" &&
          Date.parse(membership.checked_at) < now() - 60000)
      ) {
        await scan(item.playlist_id, membership);
        return { done: false, retryMs: 1000 };
      }
      if (membership.status === "unavailable") {
        return await attention("destination_unavailable");
      }
      if (item.state === "pending") {
        if (membership.status === "present") {
          await transition("preexisting", item.playlist_id);
          return { done: false, retryMs: 1000 };
        }
        // Refresh absence near dispatch. This is an observation, not an atomic
        // remote add-if-absent condition; external edits remain a provider limit.
        if (Date.parse(membership.checked_at) < now() - 60000) {
          await scan(item.playlist_id);
          return { done: false, retryMs: 1000 };
        }
        const live = await client.getPlaylist(item.playlist_id);
        if (!spotifyPlaylistOwnedBy(live, identity)) {
          return await attention("destination_unavailable");
        }
        if (live.snapshotId !== membership.snapshot_id) {
          await scan(item.playlist_id);
          return { done: false, retryMs: 1000 };
        }
        if (!await transition("append_intent", item.playlist_id)) return null;
        await wait(550);
        let result: { snapshotId: string };
        try {
          result = await client.reviewAppend(o.id, item.playlist_id, state.uri);
        } catch (error) {
          if (!(error instanceof SpotifyError) || error.ambiguous) {
            await transition("append_uncertain", item.playlist_id);
            return { done: false, retryMs: 1000 };
          }
          await transition("append_rejected", item.playlist_id);
          if (["forbidden", "not_found", "guard"].includes(error.kind)) {
            return await attention("destination_unavailable");
          }
          throw error;
        }
        await transition(
          "append_confirmed",
          item.playlist_id,
          result.snapshotId,
        );
        return { done: false, retryMs: 1000 };
      }
      if (membership.status !== "present") {
        return await attention(
          item.state === "unconfirmed"
            ? "addition_unconfirmed"
            : "membership_changed",
        );
      }
    }
    if (!await transition("unlike_prepare")) return null;
    // Never perform an unlike in the same invocation as an append. Durable
    // destination confirmations survive interruption and are inspected first.
    return { done: false, retryMs: 1000 };
  };
}

export function reviewJobs(
  db: Database,
  box: SecretBox,
  clientId: string,
  request: typeof fetch = fetch,
): FeatureJob {
  return createReviewRunner({
    db,
    spotify: (job) => {
      const epoch = job.epoch!;
      const base = { p_epoch: epoch, p_job: job.id, p_lease: job.leaseToken };
      const pacing = databasePacing(db, epoch);
      return new SpotifyClient({
        tokens: new OwnerTokens(db, box, epoch, clientId, request),
        pacing: {
          acquire: async (interval) => {
            if (!await db.rpc("app_review_worker", base)) {
              throw new SpotifyError("control_unavailable");
            }
            return await pacing.acquire(interval);
          },
          defer: pacing.defer,
        },
        isManagedPlaylist: () => Promise.resolve(false),
        authorizeReview: (authorization, operation) =>
          db.rpc<boolean>("app_review_authorize", {
            ...base,
            p_operation: authorization.operationId,
            p_action: authorization.action,
            p_method: operation.method,
            p_path: operation.path,
            p_uri: operation.uri,
            p_snapshot: operation.snapshotId ?? null,
          }),
        fetch: request,
      });
    },
  });
}
