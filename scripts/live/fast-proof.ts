// Private operator stdin only. Never emit metadata, identifiers or provider bodies.
import {
  check,
  type CoreRegistry,
  newRegistry,
  ProofFailure,
  validateRegistry,
} from "./core-fixtures.ts";
import { writeCoreRegistry } from "./core-proof.ts";
import { fastProofSql } from "./fast-proof-sql.ts";
interface Input {
  appUrl: string;
  projectRef: string;
  managementToken: string;
  epoch: number;
  ownerFingerprint: string;
  registryPath: string;
  cookie: string;
}
export async function runFastProof(input: Input) {
  check(/^[a-z0-9]{20}$/.test(input.projectRef), "fast_target_invalid");
  const lock = await Deno.open(input.registryPath + ".lock", {
    createNew: true,
    write: true,
    mode: 0o600,
  }).catch(() => {
    throw new ProofFailure("fast_lock_requires_recovery");
  });
  const request = async (url: string, init: RequestInit) => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new ProofFailure("fast_request_unavailable");
    }
    check(response.ok, "fast_request_failed");
    try {
      return { response, value: await response.json() };
    } catch {
      throw new ProofFailure("fast_response_invalid");
    }
  };
  try {
    let r: CoreRegistry;
    try {
      const info = await Deno.lstat(input.registryPath);
      check(
        info.isFile && !info.isSymlink && (info.mode! & 0o777) === 0o600,
        "invalid_fast_registry",
      );
      r = JSON.parse(await Deno.readTextFile(input.registryPath));
      validateRegistry(r);
      check(
        r.phase === "cleaned" || (r.epoch === input.epoch &&
          r.ownerFingerprint === input.ownerFingerprint),
        "fast_recovery_owner_changed",
      );
      check(
        ["prepared", "inserting", "cleaned"].includes(r.phase),
        "fast_registry_wrong_proof",
      );
      if (r.phase === "cleaned") {
        r = newRegistry(input.epoch, input.ownerFingerprint);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      r = newRegistry(input.epoch, input.ownerFingerprint);
    }
    await writeCoreRegistry(input.registryPath, r);
    r.phase = "inserting";
    await writeCoreRegistry(input.registryPath, r);
    const { value } = await request(
      `https://api.supabase.com/v1/projects/${input.projectRef}/database/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.managementToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: fastProofSql(r), read_only: false }),
      },
    );
    check(
      Array.isArray(value) && value.length === 1 &&
        value[0].transactionalfasttagging === true &&
        value[0].fixturesrolledback === true && value[0].assertions === 20,
      "fast_transaction_unconfirmed",
    );
    const api = async (path: string, body: unknown) => {
      const result = await request(input.appUrl + "/api" + path, {
        method: "POST",
        headers: {
          cookie: input.cookie,
          origin: input.appUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      check(
        result.response.headers.get("cache-control")?.includes("no-store"),
        "fast_api_cache_guard",
      );
      return result.value;
    };
    const facets = await api("/library/facets", {
      filter: {
        membership: "active",
        search: "",
        untagged: false,
        newOnly: false,
        artistId: r.artistId,
      },
      facet: "artist",
      cursor: null,
      limit: 10,
    });
    check(
      facets.totalOptions === 0 && Array.isArray(facets.options) &&
        facets.options.length === 0 && facets.nextCursor === null,
      "fast_deployed_facets_failed",
    );
    const vocabulary = await api("/tags/vocabulary", {
      search: `Tagger API test ${r.run}`,
      sort: "mostUsed",
      cursor: null,
      limit: 10,
    });
    check(
      Array.isArray(vocabulary.tags) && vocabulary.tags.length === 0 &&
        vocabulary.nextCursor === null,
      "fast_deployed_vocabulary_failed",
    );
    r.phase = "cleaned";
    await writeCoreRegistry(input.registryPath, r);
    return {
      transactionalFastTagging: true,
      fixturesRolledBack: true,
      authenticatedFastReads: true,
      assertions: 20,
    };
  } finally {
    lock.close();
    await Deno.remove(input.registryPath + ".lock");
  }
}
if (import.meta.main) {
  try {
    const input = await new Response(Deno.stdin.readable).json();
    console.log(JSON.stringify({ passed: true, ...await runFastProof(input) }));
  } catch (error) {
    console.log(
      JSON.stringify({
        passed: false,
        blocker:
          error instanceof ProofFailure && /^[a-z_]+$/.test(error.message)
            ? error.message
            : "fast_live_proof_failed",
      }),
    );
    Deno.exitCode = 1;
  }
}
