# Deployment and API proof operators

Only the native orchestrator operates the configured production targets. The scripts below keep credential values in private files, request bodies or child stdin. Do not print vendor responses or capture real library pages. Use Node 24.21.0, the lockfile (`npm ci`), Deno 2.9.7 and Supabase CLI 2.120.0. Build and deploy from a clean, committed `codex/...` checkout, then redeploy the final merged revision.

## Local checks

`sh scripts/check` runs the existing setup suite, frontend/proxy TypeScript and Vitest checks, formatting, production build, synthetic desktop/mobile Playwright, and integrated Deno/PostgreSQL checks. Browser installation is `npx playwright install chromium` (`--with-deps` on CI).

`node scripts/check-supabase.mjs` snapshots committed migrations, functions and database tests into a disposable temporary Supabase project. It uses ports 61021–61030 and no production credentials or remote link. It applies all migrations, tests vendor extension/private bucket boundaries, and observes an actual minute cron callback authenticated with a synthetic Vault secret. It also runs the actual `ServiceDatabase` and API/jobs handlers against local PostgREST with synthetic Spotify responses. Assertions cover active UPDATE/DELETE safe-update rejection, named parameters, 204 void responses, bootstrap/owner sessions, OAuth state, refresh/cooldown/reconnect, maintenance, disconnect/purge, and stale epoch/lease fences. The maintenance probe uses a different SHA from the raw void probe. Generated local keys stay in memory/private child stdin; no raw tool responses are logged. The script stops and removes only its own stack.

An optional source checkout argument selects a frozen checkout without modifying it. `--working-tree` explicitly snapshots current source, including untracked tests/migrations, for pre-commit development checks; its result is labelled `working-tree`, records the base HEAD plus a source snapshot hash, and is not evidence for an unchanged committed head. Default execution and CI always read committed source. Coordinate the ports before running concurrently. The local real-REST and scheduled callback proofs remain separate from freshly deployed Edge Runtime routing and actual deployed jobs execution.

Migration `20261011000300_safeupdate_rpc.sql` replaces affected functions additively; already-applied migrations remain unchanged. Supabase PostgREST sessions load [pg-safeupdate](https://github.com/eradman/pg-safeupdate), which rejects unqualified UPDATE/DELETE inside function calls even when a direct administrative SQL call succeeds. Keep that guard enabled. The correction uses singleton/epoch/lease predicates while retaining the existing account locks and transactions. Disconnect purges cancelled and earlier session/OAuth generations under the advanced account epoch. [PostgREST RPCs](https://docs.postgrest.org/en/stable/references/api/functions.html) map JSON keys to named arguments; the local HTTP proof confirms SQL void functions return an empty 204. Only `app_jobs_started` and `app_pacing_defer` accept that response; an empty or malformed JSON-returning RPC remains unavailable.

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
    "functionInvocations": 0,
    "functionInvocationLimit": 500000,
    "workerRequestsToday": 0,
    "workerDailyRequestLimit": 100000
  }
}
```

The numeric values above illustrate the shape; replace usage and limits with the actual observations. `functionInvocations` and `functionInvocationLimit` are the current displayed Supabase Edge Function invocation usage and allowance, not configured or assumed values. Record the dashboard observation time; provider usage refresh latency means these observations prove displayed capacity at that time, not future capacity. Missing, invalid or exhausted function-invocation evidence blocks both preparation and live verification. Never treat this example as evidence. Observations expire after 15 minutes and are bound to the targets and commit.

Run `npm run build`, then `node scripts/prepare-deployment.mjs`. It also freshly checks the configured project's identity/health through the Management API. It creates missing runtime keys without changing existing keys, and prepares `.local/deploy/<sha>/supabase.env`, `wrangler.json`, `worker-secrets.json` and `vault-input.json`. Preparation makes **no deployment, migration, Vault or hosting changes**. `.local` is a symlink to the primary private directory.

The orchestrator then performs these already-authorized steps, parsing vendor output only in memory and emitting only statuses (never persist raw vendor responses or trace events):

1. Apply reviewed additive migrations to the exact configured project with its established migration history. Inspect the dry run first. Never reset a remote database.
2. Transfer `supabase.env` with `supabase secrets set --env-file <private file> --project-ref <configured ref>`. Set Vault names `spotify_plus_project_url` and `spotify_plus_cron_secret` from the private JSON request body. Management token and DB password are subprocess environment values, never runtime secrets or CLI arguments.
3. Deploy `api` and `jobs` from this same checkout with the configured project ref. Both use the custom session/service checks and intentionally disable gateway JWT verification.
4. Use pinned Wrangler `deploy --config <private wrangler.json> --secrets-file <private worker-secrets.json>`. The Worker holds only `PROXY_SECRET` and public origin/revision settings. Worker observability logging is disabled to avoid logging OAuth callbacks. Provider metrics/traces used for CPU proof must remain private and redacted.
5. Run `node scripts/import-bootstrap.mjs` once. It verifies the direct operator route with both service secrets, refreshes an expired access grant privately if needed, and atomically saves any rotated refresh token **before** import while preserving `authorizedAt`. The API rechecks Spotify identity and stores the session hash with the encrypted grant in the same `app_connect` transaction. Only an accepted commit issues the secure HttpOnly cookie; the helper saves it in ignored `.local/owner-session.json`, mode 600. Only confirmed consumption produces the consumed receipt and removes the raw local grant. Before refresh dispatch, the helper atomically marks the ignored grant with `refreshAttemptedAt`. A timeout, lost/malformed response or interrupted process leaves that marker in place; every subsequent run rejects both refresh and import with `bootstrap_refresh_ambiguous_reconnect_required`, even if the old access token appears unexpired. Only safely saved validated credentials (including a positive integral `expires_in` of at most one day), or a definitive HTTP 400 `invalid_grant` refusal, clear the marker. A definitive refusal reports `bootstrap_refresh_rejected_reconnect_required`; it is not a transient retry instruction. Do not edit or delete the marker to retry. For ambiguity, run `node scripts/connect-spotify.mjs` and complete a fresh setup OAuth login; its new complete grant replaces the marked file. Then rerun the import helper. A definitive `invalid_grant` refusal also needs fresh consent rather than repeated attempts with a rejected grant. A committed import whose response was lost cannot issue a replacement cookie on retry; the consumed status is reconciled, but owner-session verification remains blocked until a normal PKCE login.

Cloudflare's static asset routing and secret-file deployment are documented at [Worker routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) and [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/). The database scheduler follows [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions).

## Function routing boundary

The proxy and cron call gateway URLs such as `/functions/v1/api/healthz` and `/functions/v1/jobs`. [Supabase routing documentation](https://supabase.com/docs/guides/functions/routing) specifies that the URL inside the function retains its function-name prefix: `/api/healthz` and `/jobs`. The shared resolver accepts both shapes and strips exactly one matching prefix. A product `/api/session` route is therefore `/api/api/session` inside the API function; bare `/api/session` is not a shorthand alias. Synthetic API helpers construct that actual runtime shape. Handler regressions cover both shapes, health/SHA results, anonymous session access, OAuth/bootstrap dispatch, wrong secrets and wrong/adjacent/repeated prefixes. The disposable vendor cron callback is not an Edge Runtime routing proof; freshly deployed handler checks remain required.

## Fresh deployed verification

A genuine verified OAuth session is required. The one-time import completes the previously authorized setup OAuth login after a fresh Spotify identity check, preserving the original authorization date. This avoids redundant consent while using the same transactional owner binding and 30-day opaque session as hosted PKCE. Its proof source is `verified-bootstrap-oauth`; it is not a fresh interactive hosted consent check. Denied, consumed, wrong-owner or cancelled imports issue no session. No direct SQL or synthetic session is permitted.

The import helper writes `{ "origin": "<configured app origin>", "cookie": "<cookie header>", "source": "verified-bootstrap-oauth", "issuedAt": "<ISO timestamp>" }` to ignored `.local/owner-session.json`, mode 600. A later normal hosted PKCE login can supply the same shape with source `interactive-hosted-oauth` through a private local operator action. Never put the cookie in a prompt, shell argument, issue or log. The verifier checks actual authenticated owner access again rather than trusting the file or consumed receipt. Its OAuth denial probe requires exactly one `__Host-sp_oauth` cookie with the application’s opaque token, bare HttpOnly/Secure flags, SameSite=Lax, host-only Path=/ and a positive Max-Age no longer than the ten-minute state lifetime. Duplicate, malformed or insecure application cookies fail even if a secure provider cookie exists. Unrelated provider cookies are excluded from this policy check and from the probe’s callback Cookie header; the proxy continues preserving separate upstream Set-Cookie headers.

Measure successful Worker CPU from at least 20 actual request traces covering health, guest session and OAuth-start routes. Send these CPU sampling requests without an owner Cookie; actual owner-session authentication is a separate assertion. Parse Wrangler/Cloudflare events only in memory, retaining only sample counts, outcome/status booleans and CPU numbers. Never save or emit raw events, request URLs/query strings, headers, cookies or vendor responses, even to private logs. Close all app browser tabs and inspect the browser inventory; emit only the target-origin tab count and closure boolean, never tab titles, unrelated URLs, live app DOM or screenshots. Record these fresh observations in `.local/live-operator-evidence.json` (mode 600), tied to the same `buildSha` and `targetFingerprint`:

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

The Spotify probe outputs only counts and schema/status booleans. It creates one private tracked “Tagger API test …” playlist, adds and replaces 101 usable distinct tracks when available, verifies ordered membership, and removes it using the guarded `DELETE /me/library` route. It checks both containment and current-user playlist absence. The probe’s Deno file permissions permit read/write only for `api-proof-playlist.json` and its `.tmp` sibling; read access to the temporary source is required for atomic rename. Synthetic subprocess tests exercise the actual writer and deny unrelated sibling-file access. The ignored `api-proof-playlist.json` registry is persisted before creation; a lost create response is reconciled by its unique description marker, never blindly replayed. If cleanup is unconfirmed, the registry remains and the next run resolves that tracked playlist before another proof. No Liked Songs writes occur. A rate-limit/quota error stops rather than retrying aggressively.

A successful receipt is saved privately under `.local/verification/` and tied to exact frontend/API/jobs SHAs. A previous live-stage receipt never substitutes for a new run. Plan/CPU/browser observations are explicitly labelled operator evidence; live requests run again. The fast-tagging and resilience verifiers are implemented with the scoped assertions and fresh isolated-check evidence described below. Resilience additionally requires the encrypted-backup implementation from [issue #27](https://github.com/CarterKFalkenberg/spotify-plus/issues/27) integrated into the exact checked and deployed head. These verifier changes alone do not complete either stage: full checks, database/browser coverage, dependency integration and fresh deployed proofs remain required. The API proof is internal feasibility setup, not a complete library browser or MVP release.

CI uses the pinned [Supabase setup action](https://github.com/supabase/setup-cli) and the [Playwright Chromium/dependency setup](https://playwright.dev/docs/ci-intro). It runs the same synthetic check plus the disposable vendor harness without production credentials.

## Core-loop proof and recovery

After the reviewed integrated revision has merged and all three deployments match
that clean HEAD, refresh the signed-in Free-plan/usage, Worker CPU and closed-app
browser observations above. The orchestrator alone runs:

```sh
source /Users/carterfalkenberg/.local/share/spotify-plus/tooling/env.sh
node scripts/verify-stage.mjs core-loop
```

This repeats the API proof before running `scripts/live/core-proof.ts`. The core
child receives credentials through stdin and has read/write permission only for
its configured private `core-proof-registry.json`, `.tmp` and `.lock` siblings.
Management credentials stay in that operator process, never runtime or browser
code. Parent output whitelists fixed booleans and counts; provider bodies, cached
metadata, real names/IDs and errors are discarded in memory. Never inspect real
app DOM or capture screenshots during this run.

The proof checks protected product routes, stable import completion, app-open
probe debounce and a new manual full-sync completion. Stable adjacent-pass set
comparison, function restart/checkpoints and failure recovery additionally remain
synthetic SQL/worker assertions; an already completed import does not prove a
fresh OAuth or actual worker interruption. It creates random isolated annotations,
null-playable synthetic metadata and two disposable tags under the current owner
and epoch. Operator fixture SQL serializes account/library state, rejects live
leases and collisions, and refuses cleanup after changed metadata or foreign
assignment/action edges. Group/filter selection, immediate durable tags,
changed-only Undo, normalization, removed annotations, acknowledgement and nested
All/Any/None semantics operate only on these synthetic rows. Cleanup removes the
synthetic tracks before the actual library preview, retaining an unassigned test
tag for a None query. No real assignments, purge or disconnect are changed.

Every cached preview page must share query/revision/counts/duration/readiness;
aggregate membership, playable exclusions, duration and liked-date/key order are
checked privately. The deployed observation requires no overlapping jobs and
unchanged shared Spotify pacing/credential version before and after preview. This
is observable boundary evidence, not an omniscient count of all network traffic.
The library/query handler's deny-transport synthetic invariant separately proves
its code path does not call Spotify.

Creation uses the product's durable intent route and recorded request UUID, then
waits for confirmed ready state and verifies private ordered remote contents with
50-item read pages. Writes remain the product worker's 100-item chunks. It checks
request dedupe, Pin/Unpin/Extend and Regenerate. The narrow operator-only rename
helper sends one exact `PUT /playlists/{registered-id}` after immutable owner,
private playlist, registered intent, epoch and app-managed-row checks using owner
tokens and shared pacing. Only the fixed synthetic name and outside note are sent;
regeneration must preserve both. The runtime adapter still permits description
updates only. Official [details](https://developer.spotify.com/documentation/web-api/reference/change-playlist-details)
and [item read](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items)
contracts were read October 11, 2026; these source checks do not prove live behavior.

Readiness polling allows up to 120 five-second waits. An `incomplete` playlist
with `unavailable` or `rateLimited` can still have an active operation whose
queued/running durable job will retry naturally. The verifier checks that narrow
status-only database projection before continuing; stalled/parked work, reconnect
and quota blocks fail without submitting a Retry action. Completion racing the
DTO read permits another poll, but only a ready, unblocked product DTO ends the
wait. Persistent temporary failure still times out and preserves the registry.
This wait does not relax the worker's snapshot/description guards or the proof's
ordered-content assertions; `remote_changed` alone cannot identify which guard
failed or establish provider eventual consistency.

After waiting out the final API background drain and requiring quiet jobs, the
operator accelerates only the exact registered disposable playlist's app deadline
to yesterday in America/New_York. This is an accelerated test deadline, not elapsed
calendar retention. Date/month-end/DST correctness remains synthetic evidence.
The core proof never enqueues maintenance or invokes jobs/scheduler manually. It
allows twenty minutes for the existing fifteen-minute maintenance cadence, minute
cron dispatch and bounded drains, then correlates private `app.cron_dispatches`
request IDs with successful authenticated `net._http_response` results and the
completed expiry operation for that playlist. App browsers stay closed throughout.
The historical API-proof queued maintenance assertion remains API-stage evidence.
Run the long proof in a yielded command session, poll in intervals under a minute
and keep the chat responsive; no raw child diagnostics should be forwarded.

Finally, removal must be confirmed by both library containment and current-user
playlist absence. Only exact registered synthetic rows/tags/actions are cleaned;
unrelated metadata and assignments survive. The durable removed playlist record
may remain as lifecycle history. A successful receipt never consumes an old proof.
Missing permissions, auth, schema, cleanup or cron evidence blocks the stage.

The import/expiry run can outlast the fifteen-minute evidence lifetime. While the
yielded verifier is running, the orchestrator refreshes the same private dashboard,
CPU and browser observations through the original measured procedures before the
final checks. Updating a timestamp without repeating its observation is not fresh
evidence. Failure to refresh leaves the stage blocked even if playlist cleanup
completed; a stored receipt cannot bypass the required new proof.

On interruption or ambiguity, preserve the registry and rerun the same command.
Recovery resolves its recorded durable request/playlist, waits for a safe lifecycle
state, uses the managed product deletion action if necessary, confirms remote
absence, and performs exact-ID fixture cleanup. It reports
`core_previous_fixture_cleaned_rerun`; rerun again for a fresh proof. An ambiguous
create without a reconciled durable record remains blocked rather than replaying
Spotify POST. Never remove a registry or edit identifiers to evade that blocker.
For a leftover `.lock` or `.tmp`, the orchestrator must first verify the previous
operator process is dead, preserve the private files for inspection/reconciliation,
and remove only the confirmed stale lock/temp before recovery. Owner/epoch changes,
foreign edges or metadata edits require explicit operator reconciliation; they are
never permission to delete unrelated data. Do not print private registry contents.

## Fast tagging and resilience stage evidence

`node scripts/verify-stage.mjs fast-tagging` runs the common fresh deployment,
Free-plan/usage, CPU, owner/authentication and natural authenticated cron gates.
It does not create a Spotify playlist. Its private `fast-proof-registry.json`
tracks random synthetic identifiers before invoking installed database RPCs.
A nested SQL subtransaction exercises filter sorting/paging, facets, exact group
selection, tri-state bulk changes, changed-only undo, stale selection rejection,
normalized vocabulary, Unicode rename, collision merge, exact union impact,
nested query rewrite, merge undo and confirmed delete/undo. The successful path
raises a reserved rollback sentinel; errors also roll back. Registered rows must
be absent before success. Nothing commits to real owner annotations, and the
synthetic playlist row is never visible to another transaction. Separate
non-mutating authenticated HTTP requests check empty isolated facets/vocabulary
and private response caching. SQL RPC proof is distinct from HTTP route coverage.

A killed proof preserves its registry. If `.lock` or `.tmp` remains, the operator
must establish no verifier process is active, inspect the saved registry privately
and reconcile file state before rerunning. Do not blindly remove an active lock
or overwrite a temporary registry. Reruns use the same registered identifiers;
any unexpected persistent collision fails rather than deleting uncertain rows.

Both final stages require `.local/verification/software-checks.json`, written by
the orchestrator only after successful **full `scripts/check`** on the exact
committed deployment source, including synthetic Playwright keyboard and mobile
flows. Format: `source: "orchestrator-scripts-check"`, `buildSha`, `verifiedAt`,
`passed: true`, `fullCheck: true`, `syntheticBrowser: true`. It expires after one
hour and rejects future timestamps. This is recorded operator test execution,
not a substitute for the verifier's new deployed requests or actual human timing.

`resilience-and-handoff` additionally requires
`.local/verification/isolated-backup.json`: `source: "scripts/check-supabase.mjs"`,
`buildSha`, `verifiedAt`, `passed: true`, and `checker` containing the complete
redacted success JSON from `node scripts/check-supabase.mjs` on that committed
head. The root owns the disposable Docker lease and captures this output; the
stage verifier does not start a competing stack. It independently recomputes the
checker's sorted committed SQL/TS/MJS source snapshot hash. Working-tree proofs,
another head, missing actual Storage HTTP status, fewer than four storage races,
or missing encrypted isolated restore cannot pass. The checker uses actual local
Supabase Storage/PostgREST with synthetic data; it never restores or purges the
production owner. Storage HTTP 400 is accepted only after the checker confirms
the missing-bucket contract, alongside HTTP 404.

Resilience reuses the core proof's **fresh** real private create/regenerate/pin/
unpin/extend/accelerated natural expiry and both removal checks, with the existing
resumable core registry. It skips the extra API-proof disposable playlist. Both
operator observations and deployment identity are checked again at completion.
Software-check/backup receipts establish isolated recovery coverage, while the
fresh lifecycle establishes the real deployed Spotify path; neither is presented
as a deliberate live provider outage or six-month waiting experiment.

Recovery coverage lives in the existing synthetic suites:

- `supabase/tests/database/library.sql`: changing pages, equal-count swaps, stable
  full passes, interrupted checkpoints, 90-day metadata purge and retained keys.
- `library_test.ts`: lost commit acknowledgement, reclaimed completed job,
  checkpoint/lease cancellation, bounded execution and cooldown/reconnect retry.
- `playlist-runner_test.ts` and `playlist-runtime_test.ts`: ambiguous create and
  append, restart reconciliation, divergent remote sequences, deadline reserve,
  retries and disconnect/lease fences; deployed lifecycle does not force outages.
- `tokens_test.ts`, `spotify_test.ts`, `retry-after_test.ts`: rotated tokens,
  invalid grants, malformed/lost refresh responses, 401/403/429 and quota delays
  with no immediate remote replay or live request flood.
- `playlist-domain_test.ts` and database playlist tests: New York DST/month-end
  date math and serialized pin/regenerate/cleanup decisions.
- Actual isolated backup checker: encrypted daily copy/restore, concurrent upload
  and retirement, disconnected late upload rejection and absence checks.

Free-project pause recovery is operator dashboard resume followed by ordinary
durable catch-up; cron does not prevent pausing. Quota failure remains a blocker,
never upgrade permission. Architecture review, reviewed corrections, final
same-head smoke and temporary review automation shutdown remain independent
software gates. Actual phone under-one-minute and familiar-song 3–5-second
acceptance remain pending human checks even when stage receipts pass.
