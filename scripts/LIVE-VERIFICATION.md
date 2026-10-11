# Deployment and API proof operators

Only the native orchestrator operates the configured production targets. The scripts below keep credential values in private files, request bodies or child stdin. Do not print vendor responses or capture real library pages. Use Node 24.21.0, the lockfile (`npm ci`), Deno 2.9.7 and Supabase CLI 2.120.0. Build and deploy from a clean, committed `codex/...` checkout, then redeploy the final merged revision.

## Local checks

`sh scripts/check` runs the existing setup suite, frontend/proxy TypeScript and Vitest checks, formatting, production build, synthetic desktop/mobile Playwright, and integrated Deno/PostgreSQL checks. Browser installation is `npx playwright install chromium` (`--with-deps` on CI).

`node scripts/check-supabase.mjs` snapshots the current committed migrations into a disposable temporary Supabase project. It uses ports 61021–61030 and no production credentials or remote link. The script applies both migrations, tests vendor extension and private bucket boundaries, and observes an actual minute cron callback authenticated with a synthetic Vault secret. It stops and removes only its own stack. A second source checkout argument is for the orchestrator's frozen foundation proof before integration. That does not modify the source checkout. Coordinate the ports before running concurrently. The local callback proof is separate from the real deployed jobs-function proof.

## Prepare one deployment

Immediately before deploying, inspect the signed-in Supabase and Cloudflare dashboards. The scoped credentials cannot prove billing plans through their denied billing APIs; do not expand permissions. Store fresh observations in ignored `.local/deployment-dashboard-evidence.json`, mode 600:

```json
{
  "source": "signed-in-provider-dashboards",
  "observedAt": "<current ISO timestamp>",
  "buildSha": "<exact clean HEAD>",
  "targetFingerprint": "<targetFingerprint(config) from scripts/live/config.mjs>",
  "supabase": { "plan": "free" },
  "cloudflare": { "plan": "free", "cpuLimitMs": 10 },
  "monthlyCostUsd": 0,
  "paidAddons": false,
  "quotas": {
    "databaseBytes": 0,
    "databaseLimitBytes": 500000000,
    "egressBytes": 0,
    "egressLimitBytes": 5000000000,
    "storageBytes": 0,
    "storageLimitBytes": 1000000000,
    "workerRequestsToday": 0,
    "workerDailyRequestLimit": 100000
  }
}
```

The numeric values above illustrate the shape; replace usage and limits with the actual observations. Never treat this example as evidence. Observations expire after 15 minutes and are bound to the targets and commit.

Run `npm run build`, then `node scripts/prepare-deployment.mjs`. It also freshly checks the configured project's identity/health through the Management API. It creates missing runtime keys without changing existing keys, and prepares `.local/deploy/<sha>/supabase.env`, `wrangler.json`, `worker-secrets.json` and `vault-input.json`. Preparation makes **no deployment, migration, Vault or hosting changes**. `.local` is a symlink to the primary private directory.

The orchestrator then performs these already-authorized steps, capturing vendor output privately and emitting only statuses:

1. Apply reviewed additive migrations to the exact configured project with its established migration history. Inspect the dry run first. Never reset a remote database.
2. Transfer `supabase.env` with `supabase secrets set --env-file <private file> --project-ref <configured ref>`. Set Vault names `spotify_plus_project_url` and `spotify_plus_cron_secret` from the private JSON request body. Management token and DB password are subprocess environment values, never runtime secrets or CLI arguments.
3. Deploy `api` and `jobs` from this same checkout with the configured project ref. Both use the custom session/service checks and intentionally disable gateway JWT verification.
4. Use pinned Wrangler `deploy --config <private wrangler.json> --secrets-file <private worker-secrets.json>`. The Worker holds only `PROXY_SECRET` and public origin/revision settings. Worker observability logging is disabled to avoid logging OAuth callbacks. Provider metrics/traces used for CPU proof must remain private and redacted.
5. Run `node scripts/import-bootstrap.mjs` once. It verifies the direct operator route with both service secrets, refreshes an expired access grant privately if needed, and atomically saves any rotated refresh token **before** import while preserving `authorizedAt`. Only a confirmed server commit produces the consumed receipt and removes the raw local grant. An ambiguous refresh stops; do not repeat a possibly rotated token blindly.

Cloudflare's static asset routing and secret-file deployment are documented at [Worker routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) and [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/). The database scheduler follows [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions).

## Fresh deployed verification

A real owner login is required. Store its cookie privately in `.local/owner-session.json` as `{ "origin": "<configured app origin>", "cookie": "<cookie header>" }`, mode 600, through a local operator action; never put it in a prompt, shell argument, issue or log. The verifier cannot invent this session from the bootstrap grant.

Measure successful Worker CPU from at least 20 actual request traces covering health, session and OAuth routes. Close all app browser tabs and inspect the browser inventory. Record these fresh observations in `.local/live-operator-evidence.json` (mode 600), tied to the same `buildSha` and `targetFingerprint`:

```json
{
  "buildSha": "<exact clean HEAD>",
  "targetFingerprint": "<configured target fingerprint>",
  "closedBrowsers": {
    "source": "operator-browser-inventory",
    "observedAt": "<current ISO timestamp>",
    "appTabs": 0
  },
  "cpu": {
    "source": "cloudflare-workers-request-traces",
    "observedAt": "<current ISO timestamp>",
    "sampleCount": 20,
    "failedRequests": 0,
    "maxCpuMs": "<actual number>"
  }
}
```

Run `node scripts/verify-stage.mjs api-proof`. It makes fresh public/direct auth and revision probes, checks the owner session and PKCE denial flow, uses persisted encrypted credentials and shared database pacing for a real Spotify contract probe, and queues a maintenance job for actual cron execution. It never calls the jobs endpoint itself to manufacture scheduler evidence. It waits up to 95 seconds for a new deployed scheduler/job heartbeat. Auth/origin negative tests always use an **invalid deletion confirmation**, so even a guard regression cannot authorize a real owner purge. Disconnect purge and wrong-account recovery are tested with isolated synthetic data by `scripts/check`.

The Spotify probe outputs only counts and schema/status booleans. It creates one private tracked “Tagger API test …” playlist, adds and replaces 101 usable distinct tracks when available, verifies ordered membership, and removes it using the guarded `DELETE /me/library` route. It checks both containment and current-user playlist absence. The ignored `api-proof-playlist.json` registry is persisted before creation; a lost create response is reconciled by its unique description marker, never blindly replayed. If cleanup is unconfirmed, the registry remains and the next run resolves that tracked playlist before another proof. No Liked Songs writes occur. A rate-limit/quota error stops rather than retrying aggressively.

A successful receipt is saved privately under `.local/verification/` and tied to exact frontend/API/jobs SHAs. A previous receipt is never an input that can pass a new run. Plan/CPU/browser observations are explicitly labelled operator evidence; live requests run again. Other stage IDs currently fail with `stage_live_verifier_not_implemented` until their corresponding application behavior and probes ship. The API proof is internal feasibility setup, not a complete library browser or MVP release.
