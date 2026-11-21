// Operator-only disposable-playlist experiment. stdin is private; stdout is a
// fixed redacted projection. This helper is never imported by product runtime.
import { ServiceDatabase } from "../../supabase/functions/_shared/database.ts";
import {
  ownerFingerprint,
  SecretBox,
} from "../../supabase/functions/_shared/crypto.ts";
import {
  databasePacing,
  OwnerTokens,
} from "../../supabase/functions/_shared/tokens.ts";
import {
  SpotifyClient,
  type SpotifyDependencies,
  SpotifyError,
  type SpotifyPage,
  type SpotifyPlaylist,
  type SpotifyPlaylistItem,
  spotifyPlaylistOwnedBy,
} from "../../supabase/functions/_shared/spotify.ts";
import { retryAfter } from "../../supabase/functions/_shared/retry-after.ts";
import { pacedRequests } from "./paced-request.ts";

export interface ReviewProofInput {
  origin: string;
  serviceKey: string;
  clientId: string;
  encryptionKey: string;
  bindingKey: string;
  ownerFingerprint: string;
  epoch: number;
  projectRef: string;
  managementToken: string;
  registryPath: string;
  authorized: boolean;
}
export interface ReviewRegistry {
  version: 1;
  operation: string;
  epoch: number;
  ownerFingerprint: string;
  playlistId: string | null;
  state: "creating" | "created" | "cleanup_pending" | "removed";
  pending: string | null;
  // Private opaque versions only; never project this field to stdout.
  receipt?: ReviewSnapshotReceipt;
}
interface ReviewSnapshotReceipt {
  experiment: "historical_removal" | "append_ack" | "ack_targeted_removal";
  operation: "empty" | "replace" | "append" | "remove_items";
  case: typeof reviewCases[number]["name"] | "ack_historical" | "ack_latest";
  acknowledgements?: {
    operation: "replace" | "append" | "remove_items";
    snapshotId: string;
  }[];
  initialEmptySnapshotId: string | null;
  acknowledgedSnapshotId: string | null;
  readbacks: {
    beforeSnapshotId: string;
    afterSnapshotId: string;
    stable: boolean;
    count: number;
  }[];
}
interface ReadbackEvidence {
  stage: "baseline" | "later_edit" | "removal";
  case: typeof reviewCases[number]["name"];
  attempts: number;
  stableReadback: boolean;
  snapshotMatches: boolean;
  sequenceMatches: boolean | null;
  acknowledgementAdvanced: boolean | null;
  expectedCount: number | null;
  observedCount: number;
}
class ReviewFailure extends Error {
  constructor(code: string, readonly evidence?: ReadbackEvidence) {
    super(code);
  }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ReviewFailure(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function snapshot(value: unknown): string {
  check(
    record(value) && typeof value.snapshot_id === "string" &&
      value.snapshot_id.length > 0 && value.snapshot_id.length <= 2048,
    "response_schema",
  );
  return value.snapshot_id;
}
export function parseReviewRegistry(value: unknown): ReviewRegistry {
  check(
    record(value) && value.version === 1 &&
      typeof value.operation === "string" &&
      /^[0-9a-f-]{36}$/.test(value.operation) &&
      Number.isSafeInteger(value.epoch) && Number(value.epoch) > 0 &&
      typeof value.ownerFingerprint === "string" &&
      /^[0-9a-f]{64}$/.test(value.ownerFingerprint) &&
      (value.playlistId === null ||
        typeof value.playlistId === "string" &&
          /^[A-Za-z0-9]{22}$/.test(value.playlistId)) &&
      ["creating", "created", "cleanup_pending", "removed"].includes(
        String(value.state),
      ) &&
      (value.pending === null ||
        typeof value.pending === "string" &&
          /^[a-z_]{1,60}$/.test(value.pending)),
    "registry_invalid",
  );
  check(
    value.state === "creating" || value.playlistId !== null,
    "registry_invalid",
  );
  if (value.receipt !== undefined) {
    const r = value.receipt;
    const version = (v: unknown) =>
      typeof v === "string" && v.length > 0 && v.length <= 2048;
    check(
      record(r) &&
        ["historical_removal", "append_ack", "ack_targeted_removal"].includes(
          String(r.experiment),
        ) &&
        ["empty", "replace", "append", "remove_items"].includes(
          String(r.operation),
        ) &&
        (reviewCases.some((item) => item.name === r.case) ||
          r.case === "ack_historical" || r.case === "ack_latest") &&
        (r.acknowledgements === undefined ||
          Array.isArray(r.acknowledgements) && r.acknowledgements.length <= 6 &&
            r.acknowledgements.every((ack) =>
              record(ack) &&
              ["replace", "append", "remove_items"].includes(
                String(ack.operation),
              ) && version(ack.snapshotId)
            )) &&
        (r.initialEmptySnapshotId === null ||
          version(r.initialEmptySnapshotId)) &&
        (r.acknowledgedSnapshotId === null ||
          version(r.acknowledgedSnapshotId)) &&
        Array.isArray(r.readbacks) && r.readbacks.length <= 4 &&
        r.readbacks.every((item) =>
          record(item) && version(item.beforeSnapshotId) &&
          version(item.afterSnapshotId) &&
          typeof item.stable === "boolean" &&
          Number.isSafeInteger(item.count) && Number(item.count) >= 0 &&
          Number(item.count) <= 50
        ),
      "registry_invalid",
    );
  }
  return value as unknown as ReviewRegistry;
}
export async function writeReviewRegistry(path: string, value: ReviewRegistry) {
  const encoded = new TextEncoder().encode(
    JSON.stringify(parseReviewRegistry(value)),
  );
  const tmp = path + ".tmp";
  const file = await Deno.open(tmp, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    for (let written = 0; written < encoded.length;) {
      written += await file.write(encoded.subarray(written));
    }
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(tmp, path);
}

// DELETE /items is intentionally outside the runtime adapter. No positions or
// undocumented occurrence identifiers are sent. Every dispatch requires fresh
// durable registry/owner/epoch checks supplied by the operator harness.
export async function removeReviewItems(
  input: { playlistId: string; uri: string; snapshotId: string },
  deps: Pick<SpotifyDependencies, "tokens" | "pacing"> & {
    authorize: (id: string) => Promise<boolean>;
    fetch?: typeof fetch;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<string> {
  const { playlistId, uri, snapshotId } = input;
  check(
    /^[A-Za-z0-9]{22}$/.test(playlistId) &&
      /^spotify:track:[A-Za-z0-9]{22}$/.test(uri) &&
      typeof snapshotId === "string" && snapshotId.length > 0 &&
      snapshotId.length <= 2048,
    "delete_input_invalid",
  );
  const body = JSON.stringify({
    items: [{ uri: uri }],
    snapshot_id: snapshotId,
  });
  check(await deps.authorize(playlistId), "fixture_guard");
  const token = await deps.tokens.getAccessToken();
  check(
    typeof token === "string" && token.length > 0 && !/\s/.test(token),
    "token_invalid",
  );
  let waited = 0;
  for (let attempt = 0;; attempt++) {
    const permit = await deps.pacing.acquire(500);
    check(
      typeof permit.granted === "boolean" &&
        Number.isSafeInteger(permit.retryAfterMs) && permit.retryAfterMs >= 0,
      "pacing_invalid",
    );
    if (permit.granted) {
      check(permit.retryAfterMs === 0, "pacing_invalid");
      break;
    }
    const delay = Math.max(500, permit.retryAfterMs);
    check(
      attempt < 10 && delay <= 2000 && waited + delay <= 10000,
      "pacing_blocked",
    );
    waited += delay;
    await (deps.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(
      delay,
    );
  }
  check(await deps.authorize(playlistId), "fixture_guard");
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(
      `https://api.spotify.com/v1/playlists/${playlistId}/items`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw new ReviewFailure("delete_ambiguous");
  }
  if (response.status === 429) {
    let quota = false;
    try {
      const data: unknown = await response.json();
      quota = record(data) && record(data.error) &&
        data.error.reason === "QUOTA_EXCEEDED";
    } catch { /* still back off */ }
    const delay = Math.max(
      quota ? 21600000 : 1000,
      retryAfter(response.headers.get("Retry-After"), Date.now()) ?? 30000,
    );
    await deps.pacing.defer({
      retryAfterMs: delay,
      kind: quota ? "quota" : "rate_limit",
    });
    throw new ReviewFailure(quota ? "delete_quota" : "delete_rate_limited");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new ReviewFailure(
      response.status === 401
        ? "delete_unauthorized"
        : response.status === 403
        ? "delete_forbidden"
        : "delete_unconfirmed",
    );
  }
  try {
    return snapshot(await response.json());
  } catch {
    throw new ReviewFailure("delete_ambiguous");
  }
}

export const reviewCases = [
  { name: "unique", baseline: [0], later: [] },
  { name: "duplicates", baseline: [0, 0, 1], later: [] },
  { name: "later_same_uri", baseline: [0, 1], later: [0] },
  { name: "later_unrelated", baseline: [0], later: [1] },
] as const;
export function observeReviewCase(
  name: string,
  actual: (string | null)[],
  uris: string[],
) {
  check(
    reviewCases.some((item) => item.name === name) && uris.length === 2 &&
      uris[0] !== uris[1],
    "observation_invalid",
  );
  return {
    case: name,
    remainingCount: actual.length,
    targetRemainingCount: actual.filter((uri) => uri === uris[0]).length,
    unrelatedRemainingCount: actual.filter((uri) => uri === uris[1]).length,
    unknownItemCount: actual.filter((uri) => !uris.includes(uri ?? "")).length,
    expectedSequenceObserved: name === "unique"
      ? actual.length === 0
      : name === "later_same_uri"
      ? actual.length === 2 && actual[0] === uris[1] && actual[1] === uris[0]
      : actual.length === 1 && actual[0] === uris[1],
  };
}

export async function runReviewExperiment(deps: {
  uris: string[];
  replace: (uris: string[]) => Promise<string>;
  append: (uris: string[]) => Promise<string>;
  read: () => Promise<{
    snapshotId: string;
    items: (string | null)[];
    stable?: boolean;
  }>;
  remove: (uri: string, snapshotId: string) => Promise<string>;
  wait?: (ms: number) => Promise<void>;
}) {
  check(
    deps.uris.length === 2 && deps.uris[0] !== deps.uris[1] &&
      deps.uris.every((uri) => /^spotify:track:[A-Za-z0-9]{22}$/.test(uri)),
    "cached_tracks_required",
  );
  const wait = deps.wait ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  // Only GET readbacks repeat. Each acknowledged mutation remains one dispatch.
  // Equality with the acknowledged snapshot and exact sequences still gate writes.
  const confirm = async (
    scenario: typeof reviewCases[number],
    stage: ReadbackEvidence["stage"],
    expectedSnapshot: string,
    expected: string[] | null,
    acknowledgementAdvanced: boolean | null = null,
  ) => {
    for (let attempt = 0;; attempt++) {
      const observed = await deps.read();
      const evidence: ReadbackEvidence = {
        stage,
        case: scenario.name,
        attempts: attempt + 1,
        stableReadback: observed.stable !== false,
        snapshotMatches: observed.snapshotId === expectedSnapshot,
        sequenceMatches: expected === null
          ? null
          : JSON.stringify(observed.items) === JSON.stringify(expected),
        acknowledgementAdvanced,
        expectedCount: expected?.length ?? null,
        observedCount: observed.items.length,
      };
      if (
        evidence.stableReadback && evidence.snapshotMatches &&
        evidence.sequenceMatches !== false && acknowledgementAdvanced !== false
      ) return observed;
      if (attempt === 3) {
        throw new ReviewFailure(
          stage === "baseline"
            ? "baseline_unconfirmed"
            : stage === "later_edit"
            ? "later_edit_unconfirmed"
            : "removal_readback_unconfirmed",
          evidence,
        );
      }
      await wait(500 * 2 ** attempt);
    }
  };
  const observations = [];
  for (const scenario of reviewCases) {
    const baseline = scenario.baseline.map((i) => deps.uris[i]);
    const baselineSnapshot = await deps.replace(baseline);
    await confirm(scenario, "baseline", baselineSnapshot, baseline);
    if (scenario.later.length) {
      const later = scenario.later.map((i) => deps.uris[i]);
      const laterSnapshot = await deps.append(later);
      await confirm(
        scenario,
        "later_edit",
        laterSnapshot,
        [...baseline, ...later],
        laterSnapshot !== baselineSnapshot,
      );
    }
    const removedSnapshot = await deps.remove(deps.uris[0], baselineSnapshot);
    // Removal sequence is the experiment's observation, not an assumed guarantee.
    const observed = await confirm(scenario, "removal", removedSnapshot, null);
    observations.push(
      observeReviewCase(scenario.name, observed.items, deps.uris),
    );
  }
  return observations;
}

export async function runReviewAppendExperiment(deps: {
  uri: string;
  append: () => Promise<string>;
  read: () => Promise<
    { snapshotId: string; items: (string | null)[]; stable?: boolean }
  >;
  wait?: (ms: number) => Promise<void>;
}) {
  check(
    /^spotify:track:[A-Za-z0-9]{22}$/.test(deps.uri),
    "cached_tracks_required",
  );
  const wait = deps.wait ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let emptyConfirmed = false;
  let initialSnapshot = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const empty = await deps.read();
    if (empty.stable !== false && empty.items.length === 0) {
      emptyConfirmed = true;
      initialSnapshot = empty.snapshotId;
      break;
    }
    if (attempt < 3) await wait(500 * 2 ** attempt);
  }
  check(emptyConfirmed, "append_initial_empty_unconfirmed");
  const acknowledged = await deps.append();
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = await deps.read();
    last = {
      attempts: attempt + 1,
      stableReadback: observed.stable !== false,
      sequenceMatches: observed.items.length === 1 &&
        observed.items[0] === deps.uri,
      observedCount: observed.items.length,
      ackSnapshotMatches: observed.snapshotId === acknowledged,
      ackMatchesInitialSnapshot: acknowledged === initialSnapshot,
      observedSnapshotChangedFromInitial:
        observed.snapshotId !== initialSnapshot,
    };
    if (
      last.stableReadback && last.sequenceMatches && last.ackSnapshotMatches
    ) break;
    if (attempt < 3) await wait(500 * 2 ** attempt);
  }
  check(
    last?.stableReadback && last.sequenceMatches,
    "append_sequence_unconfirmed",
  );
  // This is a measured mismatch, not permission to relax production assertions.
  return last;
}

// This separate observation follows opaque write ACKs. It does not replace the
// original experiment's strict ACK/GET equality assertions above.
export async function runReviewAckExperiment(deps: {
  uris: string[];
  append: (uris: string[]) => Promise<string>;
  replace: (uris: string[]) => Promise<string>;
  remove: (uri: string, snapshotId: string) => Promise<string>;
  read: () => Promise<
    {
      snapshotId: string;
      items: (string | null)[];
      stable: boolean;
      contentComplete: boolean;
    }
  >;
  selectCase: (selected: "ack_historical" | "ack_latest") => void;
  wait?: (ms: number) => Promise<void>;
}) {
  check(
    deps.uris.length === 2 && deps.uris[0] !== deps.uris[1] &&
      deps.uris.every((uri) => /^spotify:track:[A-Za-z0-9]{22}$/.test(uri)),
    "cached_tracks_required",
  );
  const wait = deps.wait ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const exact = (a: (string | null)[], b: (string | null)[]) =>
    JSON.stringify(a) === JSON.stringify(b);
  const confirm = async (expected: (string | null)[] | null) => {
    let previous: Awaited<ReturnType<typeof deps.read>> | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const observed = await deps.read();
      const eligible = observed.stable && observed.contentComplete &&
        observed.items.length <= 3 && observed.items.every((uri) =>
          uri !== null && deps.uris.includes(uri)
        ) && (expected === null || exact(observed.items, expected));
      if (eligible && previous && exact(previous.items, observed.items)) {
        return {
          ...observed,
          consecutiveReadVersionsEqual:
            previous.snapshotId === observed.snapshotId,
        };
      }
      previous = eligible ? observed : null;
      if (attempt < 3) {
        await wait(500 * 2 ** attempt);
      }
    }
    throw new ReviewFailure("ack_content_unconfirmed");
  };
  deps.selectCase("ack_historical");
  const empty = await confirm([]);
  let previousAck = empty.snapshotId;
  const seenAcknowledgements = new Set([empty.snapshotId]);
  const acknowledge = async (action: () => Promise<string>) => {
    const acknowledged = await action();
    check(
      acknowledged.length > 0 && acknowledged.length <= 2048 &&
        acknowledged !== previousAck && !seenAcknowledgements.has(acknowledged),
      "ack_version_not_advanced",
    );
    previousAck = acknowledged;
    seenAcknowledgements.add(acknowledged);
    return acknowledged;
  };
  const [a, b] = deps.uris;
  const historicalTarget = await acknowledge(() => deps.append([a]));
  await confirm([a]);
  const historicalLatest = await acknowledge(() => deps.append([b, a]));
  await confirm([a, b, a]);
  const historicalRemoved = await acknowledge(() =>
    deps.remove(a, historicalTarget)
  );
  const historical = await confirm(null);
  const observation = (
    name: "ack_historical" | "ack_latest",
    read: typeof historical,
    target: string,
    latest: string,
    removed: string,
  ) => ({
    case: name,
    remainingCount: read.items.length,
    targetRemainingCount: read.items.filter((uri) => uri === a).length,
    unrelatedRemainingCount: read.items.filter((uri) => uri === b).length,
    historicalSequenceObserved: exact(read.items, [b, a]),
    latestSequenceObserved: exact(read.items, [b]),
    laterOccurrenceRemovedSequenceObserved: exact(read.items, [a, b]),
    unchangedSequenceObserved: exact(read.items, [a, b, a]),
    targetAckMatchesLatestAck: target === latest,
    removalAckDiffersFromLatestAck: removed !== latest,
    removalAckMatchesReadSnapshot: removed === read.snapshotId,
    readSnapshotMatchesTargetAck: read.snapshotId === target,
    readSnapshotMatchesLatestAck: read.snapshotId === latest,
    consecutiveReadVersionsEqual: read.consecutiveReadVersionsEqual,
  });
  // Reconfirm the exact observed known-URI content before overwriting this test
  // fixture. Unknown/unavailable/incomplete/changing content blocks the reset.
  await confirm(historical.items);
  deps.selectCase("ack_latest");
  await acknowledge(() => deps.replace([a]));
  await confirm([a]);
  const latestTarget = await acknowledge(() => deps.append([b, a]));
  await confirm([a, b, a]);
  const latestRemoved = await acknowledge(() => deps.remove(a, latestTarget));
  const latest = await confirm(null);
  return [
    observation(
      "ack_historical",
      historical,
      historicalTarget,
      historicalLatest,
      historicalRemoved,
    ),
    observation(
      "ack_latest",
      latest,
      latestTarget,
      latestTarget,
      latestRemoved,
    ),
  ];
}

export async function runReviewProof(
  input: ReviewProofInput,
  experiment: "historical_removal" | "append_ack" | "ack_targeted_removal" =
    "historical_removal",
) {
  check(
    experiment === "historical_removal" || experiment === "append_ack" ||
      experiment === "ack_targeted_removal",
    "input_invalid",
  );
  check(input.authorized === true, "authorization_required");
  check(
    /^[a-z0-9]{20}$/.test(input.projectRef) &&
      input.origin === `https://${input.projectRef}.supabase.co` &&
      Number.isSafeInteger(input.epoch) && input.epoch > 0 &&
      /^[a-f0-9]{64}$/.test(input.ownerFingerprint),
    "input_invalid",
  );
  let lock: Deno.FsFile;
  try {
    lock = await Deno.open(input.registryPath + ".lock", {
      createNew: true,
      write: true,
      mode: 0o600,
    });
  } catch {
    throw new ReviewFailure("operator_lock_requires_recovery");
  }
  try {
    try {
      await Deno.stat(input.registryPath + ".tmp");
      throw new ReviewFailure("operator_temp_requires_recovery");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const db = new ServiceDatabase(input.origin, input.serviceKey);
    const active = () =>
      db.rpc<boolean>("app_epoch_active", { p_epoch: input.epoch });
    check(await active(), "owner_inactive");
    const tokens = new OwnerTokens(
      db,
      new SecretBox(input.encryptionKey),
      input.epoch,
      input.clientId,
    );
    const pacing = databasePacing(db, input.epoch);
    let registry: ReviewRegistry | null = null;
    try {
      registry = parseReviewRegistry(
        JSON.parse(await Deno.readTextFile(input.registryPath)),
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new ReviewFailure("registry_invalid");
      }
    }
    const current = async () =>
      parseReviewRegistry(
        JSON.parse(await Deno.readTextFile(input.registryPath)),
      );
    const authorize = async (id: string) => {
      const r = await current();
      return r.playlistId === id && r.epoch === input.epoch &&
        r.ownerFingerprint === input.ownerFingerprint &&
        r.state === "created" && await active();
    };
    let dispatched = 0;
    const client = new SpotifyClient({
      tokens,
      pacing,
      isManagedPlaylist: authorize,
      fetch: async (...args) => {
        if (args[1]?.method !== "GET") {
          const r = await current();
          check(
            r.epoch === input.epoch &&
              r.ownerFingerprint === input.ownerFingerprint && await active(),
            "fixture_guard",
          );
          const url = new URL(String(args[0]));
          check(
            url.pathname === "/v1/me/playlists"
              ? r.state === "creating" && r.pending === "create"
              : r.state === "created" && r.playlistId !== null &&
                url.pathname === `/v1/playlists/${r.playlistId}/items` &&
                ["append", "replace"].includes(r.pending ?? ""),
            "fixture_guard",
          );
        }
        dispatched++;
        return fetch(...args);
      },
    });
    const request = pacedRequests(client, () => dispatched);
    const identity = await request({ method: "GET", path: "/me" }) as {
      accountId: string;
      id: string;
    };
    check(
      await ownerFingerprint(identity.accountId, input.bindingKey) ===
        input.ownerFingerprint,
      "owner_mismatch",
    );
    const marker = () => `[Tagger review proof ${registry!.operation}]`;
    const playlists = async () => {
      const all: SpotifyPlaylist[] = [];
      for (let offset = 0; offset <= 100000;) {
        const page = await request({
          method: "GET",
          path: "/me/playlists",
          query: { limit: 50, offset },
        }) as SpotifyPage<SpotifyPlaylist>;
        all.push(...page.items);
        if (page.nextOffset === null) return all;
        check(
          page.nextOffset > offset && page.nextOffset <= 100000,
          "playlist_paging_unbounded",
        );
        offset = page.nextOffset;
      }
      throw new ReviewFailure("playlist_paging_unbounded");
    };
    const validateFixture = async () => {
      check(
        registry?.playlistId && await authorize(registry.playlistId),
        "fixture_guard",
      );
      const p = await request({
        method: "GET",
        path: `/playlists/${registry.playlistId}`,
      }) as SpotifyPlaylist;
      check(
        spotifyPlaylistOwnedBy(p, identity) && p.collaborative === false &&
          p.description?.includes(marker()),
        "fixture_guard",
      );
    };
    const absent = async () => {
      const contains = await request({
        method: "GET",
        path: "/me/library/contains",
        query: { uris: `spotify:playlist:${registry!.playlistId}` },
      }) as boolean[];
      return contains[0] === false &&
        !(await playlists()).some((p) => p.id === registry!.playlistId);
    };
    const cleanup = async () => {
      if (registry!.state === "cleanup_pending") {
        check(await absent(), "cleanup_pending_reconciliation_required");
      } else {
        await validateFixture();
        registry!.pending = "cleanup";
        // The adapter's guard needs created state during this single dispatch.
        await writeReviewRegistry(input.registryPath, registry!);
        registry!.state = "cleanup_pending";
        // Save pending state before dispatch; use a cleanup-only guarded client.
        await writeReviewRegistry(input.registryPath, registry!);
        const cleanupClient = new SpotifyClient({
          tokens,
          pacing,
          isManagedPlaylist: async (id) => {
            const r = await current();
            return r.state === "cleanup_pending" && r.pending === "cleanup" &&
              r.playlistId === id && r.epoch === input.epoch &&
              r.ownerFingerprint === input.ownerFingerprint && await active();
          },
          fetch: async (...args) => {
            const r = await current();
            check(
              r.state === "cleanup_pending" && r.pending === "cleanup" &&
                r.playlistId === registry!.playlistId &&
                r.epoch === input.epoch &&
                r.ownerFingerprint === input.ownerFingerprint && await active(),
              "fixture_guard",
            );
            dispatched++;
            return fetch(...args);
          },
        });
        await pacedRequests(cleanupClient, () => dispatched)({
          method: "DELETE",
          path: "/me/library",
          query: { uris: `spotify:playlist:${registry!.playlistId}` },
        });
        check(await absent(), "cleanup_unconfirmed");
      }
      registry!.state = "removed";
      registry!.pending = null;
      await writeReviewRegistry(input.registryPath, registry!);
    };
    if (registry && registry.state !== "removed") {
      check(
        registry.epoch === input.epoch &&
          registry.ownerFingerprint === input.ownerFingerprint,
        "recovery_owner_changed",
      );
      if (!registry.playlistId) {
        const matches = (await playlists()).filter((p) =>
          p.description?.includes(marker())
        );
        check(
          matches.length === 1 &&
            spotifyPlaylistOwnedBy(matches[0], identity) &&
            matches[0].collaborative === false,
          "creation_reconciliation_required",
        );
        registry.playlistId = matches[0].id;
        registry.state = "created";
        await writeReviewRegistry(input.registryPath, registry);
      }
      await cleanup();
      return {
        recoveredFixture: true,
        freshExperiment: false,
        cleanupConfirmed: true,
        observations: [],
        historicalSnapshotGuarantee: false,
      };
    }
    // Only cached URIs enter memory; no new saved-library reads or writes.
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${input.projectRef}/database/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.managementToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          read_only: true,
          query:
            "select distinct m.playable_uri from app.track_metadata m join app.annotations a using(track_key) where m.removed_at is null and m.playable_uri is not null and a.epoch=" +
            input.epoch + " order by m.playable_uri limit 2;",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    check(response.ok, "cached_query_failed");
    const rows: unknown = await response.json();
    check(
      Array.isArray(rows) && rows.length === 2 &&
        rows.every((r) =>
          record(r) && typeof r.playable_uri === "string" &&
          /^spotify:track:[A-Za-z0-9]{22}$/.test(r.playable_uri)
        ),
      "cached_tracks_required",
    );
    const uris = rows.map((r) => r.playable_uri as string);
    registry = {
      version: 1,
      operation: crypto.randomUUID(),
      epoch: input.epoch,
      ownerFingerprint: input.ownerFingerprint,
      playlistId: null,
      state: "creating",
      pending: "create",
    };
    await writeReviewRegistry(input.registryPath, registry);
    const created = await request({
      method: "POST",
      path: "/me/playlists",
      body: {
        name: `Tagger API test review ${registry.operation}`,
        public: false,
        collaborative: false,
        description: `${marker()} Disposable ${
          experiment === "append_ack"
            ? "append acknowledgement"
            : "snapshot-removal"
        } experiment.`,
      },
    }) as SpotifyPlaylist;
    check(
      spotifyPlaylistOwnedBy(created, identity) &&
        created.collaborative === false &&
        created.public === false && created.description?.includes(marker()),
      "fixture_creation_unconfirmed",
    );
    registry.playlistId = created.id;
    registry.state = "created";
    registry.pending = null;
    await writeReviewRegistry(input.registryPath, registry);
    const path = `/playlists/${created.id}/items`;
    let caseIndex = -1;
    let ackCase: "ack_historical" | "ack_latest" = "ack_historical";
    const write = async (
      kind: "replace" | "append" | "remove_items",
      action: () => Promise<string>,
    ) => {
      await validateFixture();
      registry!.pending = kind;
      await writeReviewRegistry(input.registryPath, registry!);
      const result = await action();
      registry!.receipt = {
        experiment,
        operation: kind,
        case: experiment === "ack_targeted_removal"
          ? ackCase
          : reviewCases[Math.max(0, caseIndex)].name,
        ...(experiment === "ack_targeted_removal"
          ? {
            acknowledgements: [...(registry!.receipt?.acknowledgements ?? []), {
              operation: kind,
              snapshotId: result,
            }],
          }
          : {}),
        initialEmptySnapshotId: registry!.receipt?.initialEmptySnapshotId ??
          null,
        acknowledgedSnapshotId: result,
        readbacks: [],
      };
      // Persist the opaque acknowledgement while the mutation is still pending.
      // Failure leaves recovery cleanup-only; it can never dispatch append again.
      await writeReviewRegistry(input.registryPath, registry!);
      registry!.pending = null;
      await writeReviewRegistry(input.registryPath, registry!);
      return result;
    };
    // Both entrypoints share the exact registry, owner and cleanup lifecycle.
    const read = async () => {
      const before = await request({
        method: "GET",
        path: `/playlists/${created.id}`,
      }) as SpotifyPlaylist;
      const page = await request({
        method: "GET",
        path,
        query: { limit: 50, offset: 0 },
      }) as SpotifyPage<SpotifyPlaylistItem>;
      const after = await request({
        method: "GET",
        path: `/playlists/${created.id}`,
      }) as SpotifyPlaylist;
      if (experiment === "ack_targeted_removal") {
        for (const p of [before, after]) {
          check(
            p.id === created.id && spotifyPlaylistOwnedBy(p, identity) &&
              p.collaborative === false && p.description?.includes(marker()),
            "fixture_guard",
          );
        }
      }
      const contentComplete = page.total <= 4 &&
        page.total === page.items.length && page.nextOffset === null &&
        page.items.every((item) => item.uri !== null);
      const stable = before.snapshotId === after.snapshotId &&
        page.total <= 4 &&
        page.total === page.items.length && page.nextOffset === null &&
        page.items.every((item) => item.uri !== null);
      check(registry!.receipt, "receipt_required");
      if (
        experiment === "ack_targeted_removal" &&
        registry!.receipt.readbacks.length === 4
      ) registry!.receipt.readbacks.shift();
      registry!.receipt.readbacks.push({
        beforeSnapshotId: before.snapshotId,
        afterSnapshotId: after.snapshotId,
        stable,
        count: page.items.length,
      });
      if (
        registry!.receipt.operation === "empty" && stable &&
        page.items.length === 0
      ) {
        registry!.receipt.initialEmptySnapshotId = after.snapshotId;
      }
      await writeReviewRegistry(input.registryPath, registry!);
      return {
        stable,
        contentComplete,
        snapshotId: after.snapshotId,
        items: page.items.map((item) => item.uri),
      };
    };
    if (experiment === "ack_targeted_removal") {
      registry.receipt = {
        experiment,
        operation: "empty",
        case: ackCase,
        initialEmptySnapshotId: null,
        acknowledgedSnapshotId: null,
        acknowledgements: [],
        readbacks: [],
      };
      await writeReviewRegistry(input.registryPath, registry);
      const observations = await runReviewAckExperiment({
        uris,
        read,
        selectCase: (selected) => {
          ackCase = selected;
        },
        append: (target) =>
          write(
            "append",
            async () =>
              (await request({
                method: "POST",
                path,
                body: { uris: target },
              }) as { snapshotId: string }).snapshotId,
          ),
        replace: (target) =>
          write(
            "replace",
            async () =>
              (await request({
                method: "PUT",
                path,
                body: { uris: target },
              }) as { snapshotId: string }).snapshotId,
          ),
        remove: (uri, snapshotId) =>
          write(
            "remove_items",
            () =>
              removeReviewItems({ playlistId: created.id, uri, snapshotId }, {
                tokens,
                pacing,
                authorize: async (id) =>
                  (await current()).pending === "remove_items" &&
                  await authorize(id),
              }),
          ),
      });
      await cleanup();
      return {
        recoveredFixture: false,
        freshExperiment: true,
        cleanupConfirmed: true,
        experiment: "ack_targeted_removal",
        observations,
        originalProofPassed: false,
        readVersionConsistencyVerified: false,
        historicalSnapshotGuarantee: false,
      };
    }
    if (experiment === "append_ack") {
      registry.receipt = {
        experiment,
        operation: "empty",
        case: "unique",
        initialEmptySnapshotId: null,
        acknowledgedSnapshotId: null,
        readbacks: [],
      };
      await writeReviewRegistry(input.registryPath, registry);
      const observation = await runReviewAppendExperiment({
        uri: uris[0],
        read,
        append: () =>
          write(
            "append",
            async () =>
              (await request({
                method: "POST",
                path,
                body: { uris: [uris[0]] },
              }) as { snapshotId: string }).snapshotId,
          ),
      });
      await cleanup();
      return {
        recoveredFixture: false,
        freshExperiment: true,
        cleanupConfirmed: true,
        experiment: "append_ack",
        observation,
        historicalSnapshotGuarantee: false,
      };
    }
    const observations = await runReviewExperiment({
      uris,
      replace: (target) => {
        caseIndex++;
        return write(
          "replace",
          async () =>
            (await request({ method: "PUT", path, body: { uris: target } }) as {
              snapshotId: string;
            }).snapshotId,
        );
      },
      append: (target) =>
        write(
          "append",
          async () =>
            (await request({
              method: "POST",
              path,
              body: { uris: target },
            }) as {
              snapshotId: string;
            }).snapshotId,
        ),
      remove: (uri, snapshotId) =>
        write(
          "remove_items",
          () =>
            removeReviewItems({ playlistId: created.id, uri, snapshotId }, {
              tokens,
              pacing,
              authorize: async (id) =>
                (await current()).pending === "remove_items" &&
                await authorize(id),
            }),
        ),
      read,
    });
    await cleanup();
    return {
      recoveredFixture: false,
      freshExperiment: true,
      cleanupConfirmed: true,
      observations,
      historicalSnapshotGuarantee: false,
    };
  } finally {
    lock.close();
    await Deno.remove(input.registryPath + ".lock");
  }
}
export function reviewProofFailure(error: unknown) {
  // ReviewFailure messages originate only from fixed literals in this file.
  return {
    passed: false,
    blocker: error instanceof ReviewFailure
      ? `review_${error.message}`
      : error instanceof SpotifyError
      ? `spotify_${error.kind}`
      : "review_proof_failed",
    ...(error instanceof ReviewFailure && error.evidence
      ? { evidence: error.evidence }
      : {}),
  };
}
if (import.meta.main) {
  try {
    const input = JSON.parse(
      await new Response(Deno.stdin.readable).text(),
    ) as ReviewProofInput;
    console.log(
      JSON.stringify({ passed: true, ...await runReviewProof(input) }),
    );
  } catch (error) {
    console.log(JSON.stringify(reviewProofFailure(error)));
    Deno.exitCode = 1;
  }
}
