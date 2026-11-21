// Operator-only, separately consented one-track experiment. Not runtime code.
import { ServiceDatabase } from "../../supabase/functions/_shared/database.ts";
import {
  ownerFingerprint,
  SecretBox,
} from "../../supabase/functions/_shared/crypto.ts";
import {
  databasePacing,
  OwnerTokens,
} from "../../supabase/functions/_shared/tokens.ts";
import { retryAfter } from "../../supabase/functions/_shared/retry-after.ts";

export interface TrackProofInput {
  origin: string;
  serviceKey: string;
  clientId: string;
  encryptionKey: string;
  bindingKey: string;
  ownerFingerprint: string;
  epoch: number;
  projectRef: string;
  managementToken: string;
  executionHead: string;
  operation: string;
  targetUri: string;
  registryPath: string;
  consent: {
    approved: true;
    purpose: "one-unliked-track-date-proof";
    operation: string;
    ownerFingerprint: string;
    epoch: number;
    reviewedHead: string;
    targetFingerprint: string;
    registryPath: string;
    maxWrites: 4;
    restoreUnliked: true;
    expiresAt: string;
  };
}
type Phase =
  | "first_like"
  | "first_unlike"
  | "second_like"
  | "final_unlike"
  | "cleanup";
interface Registry {
  version: 1;
  consent: TrackProofInput["consent"];
  targetUri: string;
  initialMembership: false;
  complete: boolean;
  writes: { phase: Phase; acknowledged: boolean }[];
  firstAddedAt: string | null;
  secondAddedAt: string | null;
}
function unresolvedLike(registry: Registry) {
  return registry.writes.some((write) =>
    !write.acknowledged && ["first_like", "second_like"].includes(write.phase)
  );
}
const phases: Phase[] = [
  "first_like",
  "first_unlike",
  "second_like",
  "final_unlike",
];
class Failure extends Error {}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Failure(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validAddedAt(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  ) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString() ===
    value.replace(
      /(?:\.(\d{1,3}))?Z$/,
      (_, digits) => "." + (digits ?? "").padEnd(3, "0") + "Z",
    );
}
export function trackProofFailure(error: unknown) {
  return {
    passed: false,
    blocker: error instanceof Failure ? error.message : "track_proof_failed",
    cleanupMayBeRequired: true,
  };
}
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function save(path: string, value: Registry) {
  const file = await Deno.open(path + ".tmp", {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    for (let offset = 0; offset < bytes.length;) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(path + ".tmp", path);
}
async function readRegistry(input: TrackProofInput): Promise<Registry | null> {
  try {
    const info = await Deno.lstat(input.registryPath);
    check(
      info.isFile && !info.isSymlink &&
        (info.mode === null || (info.mode & 0o777) === 0o600),
      "registry_invalid",
    );
    const r = JSON.parse(await Deno.readTextFile(input.registryPath));
    check(
      record(r) && r.version === 1 && r.targetUri === input.targetUri &&
        r.initialMembership === false && typeof r.complete === "boolean" &&
        record(r.consent) && Object.keys(input.consent).every((key) =>
          (r.consent as Record<string, unknown>)[key] ===
            input.consent[key as keyof typeof input.consent]
        ) &&
        Object.keys(r.consent).length === Object.keys(input.consent).length,
      "registry_invalid",
    );
    check(Array.isArray(r.writes) && r.writes.length <= 4, "registry_invalid");
    let cleanup = false;
    for (let n = 0; n < r.writes.length; n++) {
      const w = r.writes[n];
      check(
        record(w) && typeof w.acknowledged === "boolean" &&
          (w.acknowledged || n === r.writes.length - 1 ||
            (n === r.writes.length - 2 &&
              r.writes[n + 1]?.phase === "cleanup")),
        "registry_invalid",
      );
      if (w.phase === "cleanup") {
        check(
          !cleanup && n === r.writes.length - 1 && n > 0 &&
            ["first_like", "second_like"].includes(r.writes[n - 1].phase),
          "registry_invalid",
        );
        cleanup = true;
      } else check(!cleanup && w.phase === phases[n], "registry_invalid");
    }
    check(
      (r.firstAddedAt === null || validAddedAt(r.firstAddedAt)) &&
        (r.secondAddedAt === null || validAddedAt(r.secondAddedAt)),
      "registry_invalid",
    );
    const registry = r as unknown as Registry;
    check(
      !registry.complete || !unresolvedLike(registry),
      "write_reconciliation_required",
    );
    return registry;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    if (error instanceof Failure) throw error;
    throw new Failure("registry_invalid");
  }
}

export async function runTrackProof(raw: TrackProofInput) {
  // Freeze caller-owned input before any asynchronous work or pacing.
  const input = structuredClone(raw);
  check(record(input) && record(input.consent), "consent_required");
  const c = input.consent;
  check(
    [
      input.serviceKey,
      input.clientId,
      input.encryptionKey,
      input.bindingKey,
      input.managementToken,
    ].every((v) => typeof v === "string" && v.length > 0),
    "input_invalid",
  );
  check(
    /^[a-z0-9]{20}$/.test(input.projectRef) &&
      input.origin === `https://${input.projectRef}.supabase.co` &&
      Number.isSafeInteger(input.epoch) && input.epoch > 0 &&
      /^[a-f0-9]{64}$/.test(input.ownerFingerprint) &&
      /^[a-f0-9]{40}$/.test(input.executionHead) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.operation) &&
      /^spotify:track:[A-Za-z0-9]{22}$/.test(input.targetUri) &&
      typeof input.registryPath === "string" &&
      input.registryPath.startsWith("/") &&
      !input.registryPath.split("/").includes(".."),
    "input_invalid",
  );
  const targetFingerprint = await ownerFingerprint(
    "track-proof:" + input.targetUri,
    input.bindingKey,
  );
  const consentValid = () =>
    c.approved === true && c.purpose === "one-unliked-track-date-proof" &&
    c.operation === input.operation &&
    c.ownerFingerprint === input.ownerFingerprint && c.epoch === input.epoch &&
    c.reviewedHead === input.executionHead &&
    c.targetFingerprint === targetFingerprint &&
    c.registryPath === input.registryPath && c.maxWrites === 4 &&
    c.restoreUnliked === true && validAddedAt(c.expiresAt) &&
    Date.parse(c.expiresAt) > Date.now() &&
    Date.parse(c.expiresAt) <= Date.now() + 86400000;
  check(consentValid(), "consent_required");
  let lock: Deno.FsFile;
  try {
    lock = await Deno.open(input.registryPath + ".lock", {
      createNew: true,
      write: true,
      mode: 0o600,
    });
  } catch {
    throw new Failure("operator_lock_requires_recovery");
  }
  try {
    try {
      await Deno.lstat(input.registryPath + ".tmp");
      throw new Failure("operator_temp_requires_recovery");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    let registry = await readRegistry(input);
    const db = new ServiceDatabase(input.origin, input.serviceKey);
    const tokens = new OwnerTokens(
      db,
      new SecretBox(input.encryptionKey),
      input.epoch,
      input.clientId,
    );
    const pacing = databasePacing(db, input.epoch);
    const slot = async () => {
      let elapsed = 0;
      for (let attempt = 0; attempt <= 10; attempt++) {
        const p = await pacing.acquire(500);
        if (p.granted) return;
        check(
          Number.isFinite(p.retryAfterMs) && p.retryAfterMs >= 0 &&
            p.retryAfterMs <= 2000 && attempt < 10,
          "pacing_blocked",
        );
        const delay = Math.max(500, p.retryAfterMs);
        elapsed += delay;
        check(elapsed <= 10000, "pacing_blocked");
        await wait(delay);
      }
    };
    // All paths are constructed here from the frozen target, never from responses.
    const request = async (
      path: string,
      write?: "PUT" | "DELETE",
      beforeDispatch?: () => Promise<void>,
    ) => {
      check(
        !write ||
          path === "/me/library?uris=" + encodeURIComponent(input.targetUri),
        "write_refused",
      );
      await slot();
      const token = await tokens.getAccessToken();
      await beforeDispatch?.();
      let response: Response;
      try {
        response = await fetch("https://api.spotify.com/v1" + path, {
          method: write ?? "GET",
          headers: { authorization: "Bearer " + token },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
      } catch {
        throw new Failure(write ? "write_ambiguous" : "read_failed");
      }
      if (response.status === 429) {
        await pacing.defer({
          retryAfterMs: Math.max(
            1000,
            retryAfter(response.headers.get("Retry-After"), Date.now()) ??
              30000,
          ),
          kind: "rate_limit",
        });
      }
      check(
        response.status === 200,
        write ? "write_unconfirmed" : "read_failed",
      );
      if (write) {
        check(await response.text() === "", "write_unconfirmed");
        return null;
      }
      try {
        return await response.json();
      } catch {
        throw new Failure("read_schema_invalid");
      }
    };
    const guard = async () => {
      check(consentValid(), "consent_required");
      check(
        await db.rpc<boolean>("app_epoch_active", { p_epoch: input.epoch }),
        "owner_inactive",
      );
      const scopes = await tokens.getGrantedScopes();
      check(
        scopes.includes("user-library-read") &&
          scopes.includes("user-library-modify"),
        "scopes_missing",
      );
      const me = await request("/me");
      check(
        record(me) && typeof me.account_id === "string" &&
          await ownerFingerprint(me.account_id, input.bindingKey) ===
            input.ownerFingerprint,
        "owner_mismatch",
      );
    };
    await guard();
    const contains = async () => {
      const value = await request(
        "/me/library/contains?uris=" + encodeURIComponent(input.targetUri),
      );
      check(
        Array.isArray(value) && value.length === 1 &&
          typeof value[0] === "boolean",
        "contains_schema_invalid",
      );
      return value[0] as boolean;
    };
    const membership = async (expected?: boolean) => {
      let last: boolean | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await wait([500, 1000, 2000][attempt - 1]);
        const current = await contains();
        if (
          last === current && (expected === undefined || current === expected)
        ) return current;
        last = current;
      }
      throw new Failure("membership_unconfirmed");
    };
    const write = async (phase: Phase) => {
      const method = phase === "first_like" || phase === "second_like"
        ? "PUT"
        : "DELETE";
      await membership(method === "DELETE");
      await guard();
      await request(
        "/me/library?uris=" + encodeURIComponent(input.targetUri),
        method,
        async () => {
          // Token and pacing waits precede the final epoch check and durable intent.
          check(consentValid(), "consent_required");
          check(
            await db.rpc<boolean>("app_epoch_active", { p_epoch: input.epoch }),
            "owner_inactive",
          );
          const disk = await readRegistry(input);
          check(
            registry && disk &&
              JSON.stringify(disk) === JSON.stringify(registry) &&
              !registry.complete && registry.writes.length < 4,
            "registry_changed",
          );
          registry.writes.push({ phase, acknowledged: false });
          await save(input.registryPath, registry);
        },
      );
      registry!.writes.at(-1)!.acknowledged = true;
      await save(input.registryPath, registry!);
    };
    const finish = async () => {
      await guard();
      await membership(false);
      // Negative reads and a later DELETE cannot settle an earlier in-flight PUT.
      // Preserve its intent indefinitely for manual reconciliation.
      check(!unresolvedLike(registry!), "write_reconciliation_required");
      registry!.complete = true;
      await save(input.registryPath, registry!);
    };
    const cleanup = async () => {
      await guard();
      if (await membership() === false) {
        await finish();
        return;
      }
      const last = registry!.writes.at(-1);
      check(
        last && ["first_like", "second_like"].includes(last.phase) &&
          registry!.writes.length < 4,
        "cleanup_reconciliation_required",
      );
      await write("cleanup");
      await finish();
    };
    if (registry) {
      if (registry.complete) {
        return {
          passed: false,
          alreadyConsumed: true,
          freshExperiment: false,
          writeCount: registry.writes.length,
        };
      }
      await cleanup();
      return {
        passed: false,
        freshExperiment: false,
        cleanupConfirmed: true,
        writeCount: registry.writes.length,
      };
    }
    const id = input.targetUri.slice("spotify:track:".length);
    // Independent cached selection check returns only a count, never metadata.
    const cached = await fetch(
      `https://api.supabase.com/v1/projects/${input.projectRef}/database/query`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + input.managementToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          read_only: true,
          query:
            `select count(*)::int as count from app.track_metadata m join app.annotations a using(track_key) where a.epoch=${input.epoch} and m.spotify_id='${id}' and m.playable_uri='${input.targetUri}' and m.removed_at is null and not exists(select 1 from app.source_memberships s where s.epoch=a.epoch and s.track_key=m.track_key and s.source_id='liked');`,
        }),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    check(cached.ok, "cached_selection_failed");
    const rows = await cached.json();
    check(
      Array.isArray(rows) && rows.length === 1 && rows[0]?.count === 1,
      "cached_target_required",
    );
    const usable = (track: unknown) =>
      record(track) && track.type === "track" && track.id === id &&
      track.uri === input.targetUri && track.is_local === false &&
      track.is_playable !== false && !Object.hasOwn(track, "linked_from") &&
      !Object.hasOwn(track, "restrictions");
    check(usable(await request("/tracks/" + id)), "target_unusable");
    await membership(false);
    registry = {
      version: 1,
      consent: c,
      targetUri: input.targetUri,
      initialMembership: false,
      complete: false,
      writes: [],
      firstAddedAt: null,
      secondAddedAt: null,
    };
    await save(input.registryPath, registry);
    const timestamp = async () => {
      const scan = async (): Promise<string | null> => {
        // No newest-first assumption: scan a bounded complete prefix using offsets.
        for (let page = 0; page < 200; page++) {
          const offset = page * 50;
          const data = await request(`/me/tracks?limit=50&offset=${offset}`);
          check(
            record(data) && Array.isArray(data.items) &&
              data.items.length <= 50 && Number.isSafeInteger(data.total) &&
              (data.total as number) >= offset + data.items.length &&
              data.offset === offset && data.limit === 50 &&
              (data.next === null || typeof data.next === "string"),
            "saved_page_invalid",
          );
          let found: string | null = null;
          for (const item of data.items) {
            check(record(item) && record(item.track), "saved_page_invalid");
            if (
              item.track.uri === input.targetUri || item.track.id === id ||
              (record(item.track.linked_from) &&
                item.track.linked_from.id === id)
            ) {
              check(
                found === null && usable(item.track) &&
                  validAddedAt(item.added_at),
                "saved_target_invalid",
              );
              found = item.added_at;
            }
          }
          if (found !== null) return found;
          if (data.next === null) {
            check(
              offset + data.items.length === data.total,
              "saved_page_invalid",
            );
            return null;
          }
          check(data.items.length === 50, "saved_page_invalid");
          const next = new URL(data.next as string);
          check(
            next.origin === "https://api.spotify.com" &&
              next.pathname === "/v1/me/tracks" &&
              next.searchParams.get("offset") === String(offset + 50) &&
              next.searchParams.get("limit") === "50" &&
              [...next.searchParams].length === 2,
            "saved_page_invalid",
          );
        }
        throw new Failure("saved_scan_bound");
      };
      let last: string | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await wait([500, 1000, 2000][attempt - 1]);
        await membership(true);
        const date = await scan();
        if (date !== null && date === last) return date;
        last = date;
      }
      throw new Failure("timestamp_unconfirmed");
    };
    try {
      await write("first_like");
      registry.firstAddedAt = await timestamp();
      await save(input.registryPath, registry);
      await write("first_unlike");
      await membership(false);
      await wait(2100); // Outside all request timers; accommodates second precision.
      await write("second_like");
      registry.secondAddedAt = await timestamp();
      await save(input.registryPath, registry);
      await write("final_unlike");
      await finish();
      return {
        passed: true,
        freshExperiment: true,
        cleanupConfirmed: true,
        writeCount: registry.writes.length,
        timestampsValid: true,
        datesEqual: Date.parse(registry.firstAddedAt) ===
          Date.parse(registry.secondAddedAt),
        secondDateLater: Date.parse(registry.secondAddedAt) >
          Date.parse(registry.firstAddedAt),
        generalTimestampGuarantee: false,
      };
    } catch (error) {
      // A failure never resumes the experiment. Only a distinct cleanup may run.
      try {
        await cleanup();
      } catch { /* Durable intent is retained for cleanup-only recovery. */ }
      throw error;
    }
  } finally {
    lock.close();
    await Deno.remove(input.registryPath + ".lock");
  }
}
if (import.meta.main) {
  try {
    const input = JSON.parse(await new Response(Deno.stdin.readable).text());
    console.log(JSON.stringify(await runTrackProof(input)));
  } catch (error) {
    console.log(JSON.stringify(trackProofFailure(error)));
    Deno.exitCode = 1;
  }
}
