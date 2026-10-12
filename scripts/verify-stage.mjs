// A stored receipt never substitutes for these new requests. Operator observations
// (provider billing pages, CPU traces, browser closure) are labelled separately.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  committedBackupSnapshot,
  validateIsolatedBackup,
  validateSoftwareChecks,
} from "./live/stage-evidence.mjs";
import { oauthCallbackCookie } from "./live/oauth-cookie.mjs";
import {
  currentHead,
  privateFetch,
  privateJson,
  readJson,
  requireCheck,
  targetFingerprint,
  validateDashboardEvidence,
  validateTargets,
  verifyProject,
} from "./live/config.mjs";
export function validateOperatorEvidence(
  value,
  config,
  head,
  now = Date.now(),
) {
  requireCheck(
    value?.buildSha === head &&
      value.targetFingerprint === targetFingerprint(config),
    "operator_target_evidence_required",
  );
  for (const observation of [value.closedBrowsers, value.cpu]) {
    const time = Date.parse(observation?.observedAt);
    requireCheck(
      Number.isFinite(time) && time <= now && now - time <= 15 * 60_000,
      "fresh_operator_observation_required",
    );
  }
  requireCheck(
    value.closedBrowsers.source === "operator-browser-inventory" &&
      value.closedBrowsers.appTabs === 0,
    "close_all_app_browser_tabs_before_proof",
  );
  requireCheck(
    value.cpu.source === "cloudflare-workers-request-traces" &&
      Number.isSafeInteger(value.cpu.sampleCount) &&
      value.cpu.sampleCount >= 20 &&
      value.cpu.failedRequests === 0 &&
      Number.isFinite(value.cpu.maxCpuMs) &&
      value.cpu.maxCpuMs >= 0 &&
      value.cpu.maxCpuMs <= 10,
    "measured_free_worker_cpu_required",
  );
  return value;
}
async function json(response, code) {
  requireCheck(response.ok, code);
  try {
    return await response.json();
  } catch {
    requireCheck(false, code);
  }
}
async function managementQuery(config, token, query) {
  return json(
    await privateFetch(
      `https://api.supabase.com/v1/projects/${config.supabaseProjectRef}/database/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, read_only: true }),
      },
    ),
    "database_read_probe_failed",
  );
}
export function spotifyProofArguments(config, registryPath) {
  return [
    "run",
    "--no-prompt",
    `--allow-net=${config.supabaseProjectRef}.supabase.co,api.spotify.com,accounts.spotify.com`,
    // rename reads its temporary source as well as writing both paths.
    `--allow-read=${registryPath},${registryPath}.tmp`,
    `--allow-write=${registryPath},${registryPath}.tmp`,
    "scripts/live/spotify-proof.ts",
  ];
}
export function coreProofArguments(config, registryPath) {
  return [
    "run",
    "--no-prompt",
    `--allow-net=${new URL(config.appUrl).hostname},${config.supabaseProjectRef}.supabase.co,api.supabase.com,api.spotify.com,accounts.spotify.com`,
    `--allow-read=${registryPath},${registryPath}.tmp,${registryPath}.lock`,
    `--allow-write=${registryPath},${registryPath}.tmp,${registryPath}.lock`,
    "scripts/live/core-proof.ts",
  ];
}
export function fastProofArguments(config, registryPath) {
  return [
    "run",
    "--no-prompt",
    `--allow-net=${new URL(config.appUrl).hostname},api.supabase.com`,
    `--allow-read=${registryPath},${registryPath}.tmp,${registryPath}.lock`,
    `--allow-write=${registryPath},${registryPath}.tmp,${registryPath}.lock`,
    "scripts/live/fast-proof.ts",
  ];
}
export function redactedFastResult(value) {
  requireCheck(
    value?.passed === true &&
      value.transactionalFastTagging === true &&
      value.fixturesRolledBack === true &&
      value.authenticatedFastReads === true &&
      value.assertions === 20,
    "fast_proof_receipt_invalid",
  );
  return {
    transactionalFastTagging: true,
    fixturesRolledBack: true,
    authenticatedFastReads: true,
    assertions: value.assertions,
  };
}
export function redactedCoreResult(value) {
  const booleans = [
    "automaticImportComplete",
    "stableManualSync",
    "protectedCoreRoutes",
    "isolatedTagging",
    "changedOnlyUndo",
    "filterRevisionGuard",
    "previewPacingCredentialObservationUnchanged",
    "publicationWriteAcknowledged",
    "noncollaborativeSnapshot",
    "orderedSnapshot",
    "requestIntentDeduplicated",
    "pinUnpinExtend",
    "regeneratePreservesNameAndNotes",
    "acceleratedDeadline",
    "authenticatedScheduledExpiry",
    "removedByContains",
    "removedByCurrentUserPlaylists",
    "fixturesCleaned",
  ];
  const counts = [
    "progressObservations",
    "activeTracks",
    "previewMatches",
    "previewPlayable",
    "previewExcluded",
    "previewDurationMs",
  ];
  requireCheck(
    value?.passed === true &&
      booleans.every((key) => value[key] === true) &&
      value.publicationReadbackVerified === false &&
      [null, true, false].includes(value.publicReadback) &&
      [null, true, false].includes(value.regeneratedPublicReadback) &&
      counts.every(
        (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
      ),
    "core_proof_receipt_invalid",
  );
  return Object.fromEntries(
    [
      ...booleans,
      ...counts,
      "publicationReadbackVerified",
      "publicReadback",
      "regeneratedPublicReadback",
    ].map((key) => [key, value[key]]),
  );
}
async function runSpotifyProof(root, config, input, core = false) {
  return new Promise((done, fail) => {
    const child = spawn(
      "deno",
      core === "fast"
        ? fastProofArguments(config, input.registryPath)
        : core
          ? coreProofArguments(config, input.registryPath)
          : spotifyProofArguments(config, input.registryPath),
      {
        cwd: root,
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (data) => {
      // A child must never fill memory with accidental response dumps.
      if (stdout.length + data.length > 16384) {
        child.kill();
        return;
      }
      stdout += data;
    });
    child.stderr.resume(); // Stack traces may include inputs; never forward them.
    child.on("error", () =>
      fail(
        Object.assign(new Error(), { code: "live_probe_runtime_unavailable" }),
      ),
    );
    child.on("close", (exitCode) => {
      try {
        const result = JSON.parse(stdout);
        requireCheck(
          exitCode === 0 && result.passed === true,
          /^[a-z_]+$/.test(result.blocker)
            ? result.blocker
            : "live_spotify_proof_failed",
        );
        done(
          core === "fast"
            ? redactedFastResult(result)
            : core
              ? redactedCoreResult(result)
              : result,
        );
      } catch (error) {
        fail(
          Object.assign(new Error(), {
            code: error.code ?? "live_spotify_proof_failed",
          }),
        );
      }
    });
    child.stdin.on("error", () => {}); // Child failure is classified by close/error.
    child.stdin.end(JSON.stringify(input));
  });
}
export async function verifyStage(stage, root) {
  requireCheck(
    [
      "api-proof",
      "core-loop",
      "fast-tagging",
      "resilience-and-handoff",
    ].includes(stage),
    "stage_live_verifier_not_implemented",
  );
  const local = resolve(root, ".local");
  const head = currentHead(root);
  const config = validateTargets(readJson(resolve(local, "config.json")));
  requireCheck(
    config.authorization.createAndRemoveDisposableTestPlaylists === true,
    "disposable_playlist_authorization_required",
  );
  const dashboard = validateDashboardEvidence(
    readJson(resolve(local, "deployment-dashboard-evidence.json")),
    config,
    head,
  );
  let operator = validateOperatorEvidence(
    readJson(resolve(local, "live-operator-evidence.json")),
    config,
    head,
  );
  await verifyProject(config, local);
  const keys = readJson(resolve(local, "runtime-keys.json"));
  const base = `https://${config.supabaseProjectRef}.supabase.co`;
  const health = () =>
    privateFetch(config.appUrl + "/healthz").then((response) =>
      json(response, "deployed_health_unavailable"),
    );
  const firstHealth = await health();
  requireCheck(
    ["frontendSha", "apiSha", "jobsSha"].every(
      (name) => firstHealth[name] === head,
    ),
    "deployed_revisions_do_not_match_head",
  );
  const landing = await privateFetch(config.appUrl + "/");
  requireCheck(
    landing.ok &&
      (await landing.text()).includes(
        `<meta name="app-build" content="${head}"`,
      ),
    "frontend_asset_revision_mismatch",
  );
  for (const path of ["/privacy", "/terms"])
    requireCheck(
      (await privateFetch(config.appUrl + path)).ok,
      "policy_route_unavailable",
    );
  requireCheck(
    (await privateFetch(base + "/functions/v1/api/api/session")).status === 401,
    "direct_api_requires_proxy_secret",
  );
  requireCheck(
    (await privateFetch(base + "/functions/v1/jobs/healthz")).status === 401,
    "jobs_requires_cron_secret",
  );
  requireCheck(
    (
      await privateFetch(base + "/functions/v1/api/internal/bootstrap", {
        headers: { "x-proxy-secret": keys.proxySecret },
      })
    ).status === 401,
    "bootstrap_requires_separate_secret",
  );
  requireCheck(
    (await privateFetch(config.appUrl + "/internal/bootstrap")).status === 404,
    "bootstrap_must_not_be_public",
  );
  const anonymousResponse = await privateFetch(config.appUrl + "/api/session", {
    headers: {
      "x-proxy-secret": "spoof",
      "x-cron-secret": "spoof",
      authorization: "Bearer spoof",
      apikey: "spoof",
    },
  });
  requireCheck(
    anonymousResponse.headers.get("cache-control")?.includes("no-store"),
    "private_route_must_not_cache",
  );
  const anonymous = await json(
    anonymousResponse,
    "anonymous_session_probe_failed",
  );
  requireCheck(
    anonymous.authenticated === false,
    "anonymous_must_not_be_owner",
  );
  const owner = readJson(resolve(local, "owner-session.json"));
  requireCheck(
    owner.origin === config.appUrl &&
      ["verified-bootstrap-oauth", "interactive-hosted-oauth"].includes(
        owner.source,
      ) &&
      typeof owner.cookie === "string" &&
      owner.cookie.length > 20 &&
      !/[\r\n]/.test(owner.cookie),
    "real_owner_session_required",
  );
  const ownerSession = await json(
    await privateFetch(config.appUrl + "/api/session", {
      headers: { cookie: owner.cookie },
    }),
    "owner_session_probe_failed",
  );
  requireCheck(
    ownerSession.authenticated === true &&
      ownerSession.connection === "connected",
    "real_connected_owner_session_required",
  );
  // Invalid confirmation in every negative test prevents real deletion even if an auth guard regresses.
  const invalidBody = JSON.stringify({
    confirmation: "INVALID LIVE TEST CONFIRMATION",
  });
  const mutation = (headers) =>
    privateFetch(config.appUrl + "/api/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: invalidBody,
    });
  requireCheck(
    (await mutation({ origin: config.appUrl })).status === 401,
    "owner_session_guard_failed",
  );
  requireCheck(
    (
      await mutation({
        cookie: owner.cookie,
        origin: "https://invalid.example.test",
      })
    ).status === 403,
    "mutation_origin_guard_failed",
  );
  requireCheck(
    (await mutation({ cookie: owner.cookie, origin: config.appUrl })).status ===
      400,
    "explicit_deletion_confirmation_required",
  );
  const start = await privateFetch(config.appUrl + "/auth/spotify/start");
  requireCheck(start.status === 303, "oauth_start_failed");
  const authorization = new URL(start.headers.get("location"));
  const scopes = authorization.searchParams.get("scope")?.split(" ") ?? [];
  requireCheck(
    authorization.origin === "https://accounts.spotify.com" &&
      authorization.pathname === "/authorize" &&
      authorization.searchParams.get("code_challenge_method") === "S256" &&
      authorization.searchParams.get("code_challenge")?.length >= 43 &&
      authorization.searchParams.get("redirect_uri") ===
        config.appUrl + "/auth/spotify/callback" &&
      scopes.length === 5 &&
      new Set(scopes).size === 5 &&
      scopes.every((scope) =>
        [
          "user-library-read",
          "playlist-read-private",
          "playlist-modify-private",
          "playlist-modify-public",
          "user-library-modify",
        ].includes(scope),
      ),
    "production_pkce_contract_failed",
  );
  const oauthCookie = oauthCallbackCookie(start.headers.getSetCookie());
  const callback = new URL(config.appUrl + "/auth/spotify/callback");
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get("state"),
    error: "access_denied",
  }).toString();
  const denied = await privateFetch(callback, {
    headers: {
      cookie: oauthCookie,
    },
  });
  requireCheck(
    denied.status === 303 &&
      new URL(denied.headers.get("location"), config.appUrl).searchParams.get(
        "auth_error",
      ) === "consent_denied",
    "consent_denied_flow_failed",
  );
  const bootstrap = await json(
    await privateFetch(base + "/functions/v1/api/internal/bootstrap", {
      headers: {
        "x-proxy-secret": keys.proxySecret,
        "x-bootstrap-secret": keys.bootstrapSecret,
      },
    }),
    "bootstrap_status_probe_failed",
  );
  requireCheck(bootstrap.consumed === true, "bootstrap_not_committed");
  const managementToken = readFileSync(
    resolve(local, "supabase-access-token"),
    "utf8",
  ).trim();
  const apiKeys = await json(
    await privateFetch(
      `https://api.supabase.com/v1/projects/${config.supabaseProjectRef}/api-keys?reveal=true`,
      { headers: { authorization: `Bearer ${managementToken}` } },
    ),
    "operator_service_key_unavailable",
  );
  const serviceKey = apiKeys.find(
    (item) => item.name === "service_role",
  )?.api_key;
  requireCheck(
    typeof serviceKey === "string" && serviceKey.length > 20,
    "operator_service_key_unavailable",
  );
  const rpc = (name, body = {}) =>
    privateFetch(base + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }).then((response) => json(response, "live_database_rpc_failed"));
  const account = await rpc("app_account_status");
  requireCheck(
    account.ownerBound &&
      account.bootstrapConsumed &&
      account.state === "connected",
    "bound_connected_account_required",
  );
  const rows = await managementQuery(
    config,
    managementToken,
    "select owner_fingerprint, pg_database_size(current_database()) as database_bytes from app.account;",
  );
  requireCheck(
    rows.length === 1 &&
      rows[0].database_bytes < dashboard.quotas.databaseLimitBytes,
    "actual_database_capacity_exceeded",
  );
  const software = ["fast-tagging", "resilience-and-handoff"].includes(stage)
    ? validateSoftwareChecks(
        readJson(resolve(local, "verification/software-checks.json")),
        head,
      )
    : null;
  const backup =
    stage === "resilience-and-handoff"
      ? validateIsolatedBackup(
          readJson(resolve(local, "verification/isolated-backup.json")),
          head,
          committedBackupSnapshot(root, head),
        )
      : null;
  const fast = ["fast-tagging", "resilience-and-handoff"].includes(stage)
    ? await runSpotifyProof(
        root,
        config,
        {
          appUrl: config.appUrl,
          projectRef: config.supabaseProjectRef,
          managementToken,
          epoch: account.epoch,
          ownerFingerprint: rows[0].owner_fingerprint,
          cookie: owner.cookie,
          registryPath: resolve(local, "fast-proof-registry.json"),
        },
        "fast",
      )
    : null;
  const spotify = ["api-proof", "core-loop"].includes(stage)
    ? await runSpotifyProof(root, config, {
        origin: base,
        serviceKey,
        clientId: config.spotifyClientId,
        encryptionKey: keys.tokenEncryptionKey,
        bindingKey: keys.ownerBindingKey,
        ownerFingerprint: rows[0].owner_fingerprint,
        epoch: account.epoch,
        registryPath: resolve(local, "api-proof-playlist.json"),
        authorized: true,
      })
    : null;
  const core = ["core-loop", "resilience-and-handoff"].includes(stage)
    ? await runSpotifyProof(
        root,
        config,
        {
          origin: base,
          appUrl: config.appUrl,
          projectRef: config.supabaseProjectRef,
          managementToken,
          serviceKey,
          clientId: config.spotifyClientId,
          encryptionKey: keys.tokenEncryptionKey,
          bindingKey: keys.ownerBindingKey,
          ownerFingerprint: rows[0].owner_fingerprint,
          epoch: account.epoch,
          cookie: owner.cookie,
          head,
          registryPath: resolve(local, "core-proof-registry.json"),
          authorized: true,
        },
        true,
      )
    : null;
  let scheduled = core?.authenticatedScheduledExpiry === true;
  if (stage === "api-proof") {
    scheduled = await schedulerProbe();
  } else if (stage === "fast-tagging") {
    scheduled = await schedulerProbe();
  }
  async function schedulerProbe() {
    // A background API drain can update lastJobAt. Correlate the natural scheduler's
    // recorded pg_net request with a successful authenticated jobs HTTP response too.
    // Enqueue actual bounded maintenance, but do not invoke the jobs endpoint or scheduler ourselves.
    const before = Date.now();
    const pingId = await rpc("app_job_enqueue", {
      p_kind: "scheduler_ping",
      p_epoch: null,
      p_payload: {},
      p_priority: 0,
    });
    requireCheck(/^[a-f0-9-]{36}$/.test(pingId), "scheduled_probe_job_invalid");
    scheduled = false;
    for (let attempt = 0; attempt < 36; attempt++) {
      await new Promise((done) => setTimeout(done, 5000));
      const current = await health();
      if (
        current.jobsSha === head &&
        Date.parse(current.lastSchedulerAt) >= before &&
        Date.parse(current.lastJobAt) >= before
      ) {
        const observations = await managementQuery(
          config,
          managementToken,
          `select exists(select 1 from app.cron_dispatches d join net._http_response h on h.id=d.request_id where d.dispatched_at>=to_timestamp(${before}/1000.0) and h.status_code=200 and not coalesce(h.timed_out,false) and h.error_msg is null and h.content::jsonb->>'jobsSha'='${head}' and (h.content::jsonb->>'completed')::integer>0) and exists(select 1 from app.jobs where id='${pingId}' and kind='scheduler_ping' and state='done') as confirmed;`,
        );
        if (observations[0]?.confirmed === true) {
          scheduled = true;
          break;
        }
      }
    }
    requireCheck(scheduled, "closed_browser_scheduled_job_not_observed");
    return scheduled;
  }
  requireCheck(currentHead(root) === head, "verification_head_changed");
  const finalHealth = await health();
  requireCheck(
    ["frontendSha", "apiSha", "jobsSha"].every(
      (name) => finalHealth[name] === head,
    ),
    "deployed_revisions_changed_during_proof",
  );
  // Long import/expiry runs must finish with current operator observations too.
  validateDashboardEvidence(
    readJson(resolve(local, "deployment-dashboard-evidence.json")),
    config,
    head,
  );
  operator = validateOperatorEvidence(
    readJson(resolve(local, "live-operator-evidence.json")),
    config,
    head,
  );
  if (software)
    validateSoftwareChecks(
      readJson(resolve(local, "verification/software-checks.json")),
      head,
    );
  if (backup)
    validateIsolatedBackup(
      readJson(resolve(local, "verification/isolated-backup.json")),
      head,
      committedBackupSnapshot(root, head),
    );
  const receipt = {
    passed: true,
    live: true,
    stage,
    buildSha: head,
    deploymentUrl: config.appUrl,
    verifiedAt: new Date().toISOString(),
    deployments: { frontend: head, api: head, jobs: head },
    hostingPlans: { supabase: "free", cloudflare: "free" },
    evidence: [
      "Fresh signed-in provider dashboard plan/quota observations matched this head and targets.",
      "Fresh production HTML and frontend/API/jobs health match the exact head.",
      `Owner session (${owner.source}), direct/proxy/jobs/bootstrap authentication and safe negative mutation checks passed.`,
      "Production PKCE, secure OAuth cookies and consent-denied callback passed.",
      "Bootstrap committed once; immutable owner and encrypted persisted credential path passed.",
      ...(spotify
        ? [
            "Live saved-track schema/paging, ordered add/replace, publication command acknowledgement and playlist-only removal passed; publication readback remains unverified.",
          ]
        : []),
      ...(spotify || core
        ? [
            "Both containment and current-user playlist collection confirm removal.",
          ]
        : []),
      ...(fast
        ? [
            "Installed transactional fast-tagging RPC assertions passed with mandatory rollback; authenticated facets/vocabulary HTTP reads passed.",
            "Exact-head full synthetic checks include keyboard and mobile UI; human timing remains pending.",
          ]
        : []),
      ...(backup
        ? [
            "Same-head committed-source isolated encrypted restore and actual Storage HTTP upload/delete fences passed.",
          ]
        : []),
      core
        ? "Natural maintenance discovered the accelerated disposable expiry; authenticated cron response and completed expiry operation were correlated with app browsers reported closed."
        : "Natural scheduler dispatch matched a successful authenticated jobs HTTP response and completed maintenance after enqueue; app browsers reported closed.",
      "Fresh Cloudflare request traces report successful proxy CPU below the Free ceiling.",
    ],
    assertions: {
      ...(spotify ?? {}),
      ...(fast ? { fast, softwareChecks: software } : {}),
      ...(backup ? { backup } : {}),
      ...(core ? { core } : {}),
      scheduledJob: true,
      databaseBytes: rows[0].database_bytes,
      cpuMaxMs: operator.cpu.maxCpuMs,
      cpuSamples: operator.cpu.sampleCount,
    },
    pendingHumanAcceptance: [
      "actual-phone-query-under-one-minute",
      "familiar-song-tagging-three-to-five-seconds",
    ],
    ...(stage === "resilience-and-handoff"
      ? {
          softwareCompletion: false,
          stageScope:
            "Deployed feature and recovery proof; final independent architecture review and shutdown remain separate gates.",
        }
      : {}),
    finalSoftwareGates:
      "Independent architecture review, reviewed fixes, final deployed smoke and review-automation shutdown remain separately required.",
    observationSources: {
      ownerSession: owner.source,
      plans: dashboard.source,
      cpu: operator.cpu.source,
      browsers: operator.closedBrowsers.source,
      scheduler: "pg_net-response-joined-to-private-scheduler-dispatch",
      ...(core
        ? {
            previewTransport:
              "unchanged-shared-pacing-and-credential-state-with-no-active-work",
            previewTransportLimit:
              "Observes guarded deployed transport side effects; synthetic handler tests separately prove no Spotify dispatch. It is not provider-wide request telemetry.",
            sync: "fresh-status-and-persisted-stable-completion-transition; matching-set-algorithm-tested-synthetically",
            expiry:
              "registered-disposable-deadline-accelerated-to-prior-New-York-date; natural-authenticated-cron",
          }
        : {}),
    },
  };
  privateJson(resolve(local, "verification", stage + ".json"), receipt);
  return receipt;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  verifyStage(
    process.argv[2],
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  )
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error) => {
      console.log(
        JSON.stringify({
          passed: false,
          live: true,
          stage: process.argv[2],
          blockers: [
            error.code ?? "live_verification_prerequisite_or_probe_failed",
          ],
        }),
      );
      process.exitCode = 1;
    });
}
