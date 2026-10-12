# Spotify Song Tagger: build plan

Updated October 11, 2026 for the user's [accepted decisions](DECISIONS.md) and strict $0/month budget. This implements the original [product brief](PRODUCT-BRIEF.md). The application has not been built or deployed yet.

## Outcome and scope

Build one private personal application whose first useful release can connect, sync, tag, preview a query, request a Spotify playlist hidden from profile/search, and remove it automatically after its selected retention. The final acceptance is a real phone flow under a minute and familiar-song tagging at roughly 3–5 seconds per song. Local tests alone never establish that acceptance.

Keep the full MVP scope in the first useful release. The initial API/hosting proof is internal preparation, not a read-only browser advertised as a release. Preserve every MVP feature in the brief; use later stages to finish throughput, vocabulary gardening, mobile triage, and fault recovery. Deep-link-only audio and snapshot playlists are appropriate MVP boundaries.

## Accepted decisions

| Decision | Accepted choice | Reason |
| --- | --- | --- |
| Default playlist retention | One calendar month; picker has 1 week / 1 month / 3 months / pinned | Disposable by default, without frequent surprise removal |
| Removed metadata retention | 90 days | Useful short archive, finite Spotify metadata cache |
| Assignments after metadata purge | Persist annotations keyed by an HMAC of Spotify track ID while the account remains connected | Re-like restores tags without keeping titles, artists, art URLs, or raw track IDs indefinitely |
| Returning desktop home | Focused queue; bulk shortcut when >100 untagged | First-run groups tackle backlog; daily use remains quick |
| Regenerate name | Preserve the current Spotify name | User renames remain authoritative |
| Disconnect playlists | Keep existing playlists; explicitly explain that automatic cleanup stops | Disconnect deletes app data, rather than surprising the user with playlist removal |
| Letter shortcuts | Alt/Option+letter in the focused input; bare letters only outside editable controls | Empty-input S still consumes the first letter of “sad”; emptiness alone cannot solve this conflict |
| Hosting budget | $0/month; Supabase Free + Cloudflare Workers Free | Scheduled functions replace paid always-on services |

The persistent-annotation key is a minimization design, not a claim that pseudonymized identifiers are exempt from Spotify terms. Delete the annotations, key, credentials, and all derived data on explicit “delete everything.” These choices are already recorded in the configuration template; no repeated product ratification is needed.

## Architecture

Use **TypeScript, React + Vite + React Router, Supabase PostgreSQL and Edge Functions, and Cloudflare Workers Static Assets**. Node 24 LTS is local build tooling; Supabase functions run on Deno. Use versioned SQL migrations and server-side Supabase RPCs for atomic mutations, leases and query evaluation. Keep transactional logic in SQL functions rather than trying to compose a transaction from separate REST calls. No Redis or permanent server process is needed.

Cloudflare serves the frontend and a small same-origin API/OAuth proxy. The proxy only forwards to the fixed configured Supabase origin, adds a server-held proxy secret, strips client-supplied forwarding/secret headers, preserves cookies and redirects, and disables caching on private routes. Keep Spotify tokens and database keys out of this proxy and all browser code. Supabase's `api` function owns Spotify OAuth, opaque sessions and product actions; `jobs` runs the shared durable-job implementation. Spotify remains the only product login; Supabase Auth is not needed.

The function gateway's Supabase JWT check is disabled only for these handlers because they use our Spotify-backed sessions and service authentication. The API checks the proxy secret plus owner session on protected routes; OAuth start/callback have state/PKCE checks. The jobs function requires a separate cron secret held in Vault. Neither disabling gateway JWT verification nor possessing a publishable key authorizes a product action. Tables/RPCs grant no anonymous access; use server-only privileges and explicit grants. [Function authentication](https://supabase.com/docs/guides/functions/auth).

`pg_cron` checks for due work every minute; `pg_net` invokes `jobs` with a Vault-held secret. Jobs lease rows transactionally, checkpoint small batches and stop before their execution budget. Immediate UI actions can start a bounded drain through the API; cron continues unfinished work if the browser closes. No self-invocation chain or in-memory queue is the durability mechanism. Bound each drain to 90 seconds with lease renewal and cancellation checks; if the platform kills it earlier, the next tick resumes safely. [Scheduling functions](https://supabase.com/docs/guides/functions/schedule-functions).

The hosting ceiling is **$0**, not a usage estimate. [HOSTING.md](HOSTING.md) compares alternatives, records free quotas and explains pausing. Do not enable paid plans/add-ons or silently upgrade when quotas fail. Live proof must verify free account plans, actual CPU/storage/egress use, and closed-browser cleanup. A paused Supabase project requires dashboard resume; daily jobs are real work, not proof against pausing.

Keep one repository: `app/` for frontend, `proxy/` for the tiny Cloudflare Worker, `supabase/functions/api`, `supabase/functions/jobs` and `supabase/functions/_shared` for the backend, `supabase/migrations/` for SQL, `tests/` for synthetic contracts/browser flows, and `scripts/` for repeatable checks/deployment.

## Data and authentication

Only one configured owner can authorize. Bootstrap verifies the user ID from the user's own Spotify profile link, then binds the **immutable `account_id`** from `/me`. Every subsequent login must match that identity; never silently adopt the next person who logs in. No signup or account switching. Spotify added `account_id` in May 2026 and directs account linking to use it. [May changelog](https://developer.spotify.com/documentation/web-api/references/changes/may-2026).

Use Authorization Code with PKCE. The verifier and state remain on the server; application tokens never reach browser storage. PKCE needs the Client ID but no client secret. Opaque sessions use HttpOnly/Secure/SameSite cookies, expiry, state validation and mutation-origin checks. Encrypt refresh tokens at rest with a runtime key; serialize refresh operations and persist returned rotation tokens. Save original authorization time. Warn at 30 and 7 days before the estimated six-calendar-month deadline; `invalid_grant` clears unusable credentials and parks Spotify-dependent work until reconnect. Existing annotation editing can remain available to an already authenticated owner. [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), [refresh lifetime](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens).

The schema needs a singleton owner/authorization/settings row; sessions; permanent annotation track keys; temporary track metadata/membership; tags with immutable UUIDs and normalized names; unique track-tag assignments; sync runs and seen-track sets; generated playlists with query AST, retention/status and target membership; durable jobs with leases/retry state. Tag identity and track metadata have separate lifecycles. Foreign keys never cascade metadata deletion into annotations.

Tags normalize Unicode to NFC, trim/collapse whitespace, and use a consistent case-insensitive identity while preserving the first display spelling. Keep accents and punctuation meaningful; no stemming, singularization, hierarchy, colors or inferred tags. Stable IDs make renames safe. Merge unions assignments, computes an exact distinct-track impact, rewrites stored query leaves to the target tag ID in the same transaction, and invalidates previews. Deleted referenced tags require explicit query feedback rather than silently turning a query into “match everything.” Session undo restores actual changed assignments and the prior query references.

## Library correctness

Initial authorization enqueues import automatically. Each fetched page upserts only needed metadata, marks IDs seen in that run, and commits the resume offset in one transaction. Count **unique observed tracks**, not requests, against the latest reported total. Browsing/tagging works after page one. Once the walk ends, show “Verifying library” and keep generation disabled until verification completes. An empty first page with total zero gets a proper empty-library state.

Offset pagination is not a snapshot. Total/head checks alone miss equal-count swaps. Require **two consecutive complete walks with identical track-ID + liked-at membership sets**, consistent totals and unique-count coverage before first completion or destructive removal reconciliation. A changed, interrupted or inconsistent walk never marks unseen tracks removed. Retry from the beginning when stability cannot be established; checkpoints make unattended progress, not consistency guarantees. There is no finite proof against arbitrary continuous mutation without an API snapshot, so describe this honestly and test the intended mid-import add/remove cases. Initial import may take approximately 120 requests for two passes over 3,000 songs, rather than promising “a few seconds.”

App open, debounced to once per 15 minutes, probes the first page + total cheaply. A difference queues a walk. This is only a freshness hint; identical total/head never proves unchanged membership. Manual sync runs a full verified walk. A worker backstop runs full sync every 24 hours even if probes see nothing. Spotify owns membership, the app owns tags. Only a verified complete run soft-removes missing tracks.

Metadata for removed tracks remains in the low-prominence archive for 90 days, then disappears. Annotation keys and tags remain, and re-like recreates metadata against the same key. The archive explains what survives and that old metadata is purged. New tracks have an explicit acknowledgement marker for the quiet badge; viewing a sync does not silently clear it. The “new since last sync” mode uses the latest completed sync's additions, while the unread badge can accumulate across syncs.

Unavailable/null/local-only items are handled explicitly: count what Spotify reports, preserve usable identifiers, show unavailable state, and exclude items without a valid playable track URI from playlist writes. A preview identifies any exclusions; never silently present a larger count than the actual create target.

## Tagging surfaces

First desktop run opens artist groups by descending size with the brief's three-sentence dismissible explainer. One group can be tagged with one decision. Returning desktop home follows the ratified setting. Browser has all requested columns, sorting, text search, untagged filter, facets, grouping, range selection and select-all-matching. A bulk operation freezes the selected IDs/filter result at action time so arrivals cannot change its target midway.

Tagging mutations are transactions and save immediately. Applying an existing assignment is a no-op. Tri-state chips report all/some/none; adding fills missing assignments, clearing is explicit. Undo records only the changed assignment edges, not a snapshot of all tags that could overwrite a later edit. Toasts report the affected count. Merge previews use union counts, not summed usage counts that double-count overlaps.

Focused queue keeps album art, metadata and current tags visible with persistent input focus. Quick slots use frequent tags and session pinning. Snapshot the queue sequence for stable next/previous behavior while tags change; skip moves a track to the session's tail, and navigation never commits a form. Count up distinct newly tagged songs and total active tagged songs. Provide help, remove-last-tag, undo, Spotify open and artist jump.

Plain text always types, including the first S in “sad.” Modified letters handle actions while input has focus; bare 1–9 are quick slots only when input is empty and not composing. Numeric tag names remain creatable through paste/autocomplete or the browser's ordinary tag input. Arrows navigate songs when the input is empty, otherwise edit text/suggestions. Test IME composition and repeated keys. Deep links are the only MVP audio.

Mobile home leads with Generate and existing playlists. New badge opens the lite card list; a song sheet offers slots/input/Spotify open with swipe advance. No mobile bulk controls or dense desktop table. Use accessible controls, comfortably sized tap targets, focus management and real phone verification.

## Query and playlist lifecycle

Store a versioned recursive AST with `tag(id)`, `and(children)`, `or(children)`, and `not(child)`. The three buckets emit `AND(all-tags, OR(any-tags), NOT(OR(none-tags)))`, omitting empty buckets. An entirely empty builder asks for at least one tag rather than silently creating a whole-library playlist. Evaluate recursively over active cached membership using parameterized SQL; the same evaluator powers count, duration, preview and creation. Preview makes **zero Spotify calls** and is debounced roughly 200 ms. Clearly show zero matches and broad result counts.

Creation freezes the selected track IDs/URIs, query and retention before queuing a write. Sort newest-liked first for deterministic results. Revalidate the library version on create if a sync changed it since preview. Explicitly set `public:false` and `collaborative:false`. Under the accepted publication decision, readiness requires acknowledged fixed-false publication updates alongside verified content/disclosure; contradictory public readbacks are recorded, not treated as verified hiding. Anyone holding a link may still access it. Dates use America/New_York: 1 week is seven calendar dates; 1/3 months clamp month ends. A playlist remains valid through its displayed expiry date; the next local date becomes eligible for cleanup. UI and Spotify description agree on this convention.

Playlist creation has a durable operation ID embedded in a compact description marker. If POST create times out, reconcile that marker through current-user playlists before issuing another create; if visibility is unresolved, retain an unknown/incomplete state rather than blindly creating duplicates. Save the Spotify ID as soon as confirmed. Writes then replace the first ≤100 items and append subsequent ≤100-item chunks.

**A saved chunk position alone does not make append idempotent.** A POST may succeed before its response is lost. On ambiguity or restart, fetch ordered playlist items, compare against the frozen target, and resume only a verified prefix. Otherwise rebuild the managed playlist contents deterministically. Never blindly replay append. Keep incomplete records visible with Retry. Regenerate serializes with cleanup, rereads the current name and non-Tagger description text, updates contents and the Tagger-managed query/expiry disclosure, and resets expiry after successful completion.

Descriptions also disclose that manual Spotify edits are overwritten by Regenerate and the playlist is removed on expiry. Use compact query rendering and bounded truncation if the live description limit requires it; the app retains the full AST. Extend and Pin/Unpin update both database and disclosure through retryable jobs. Unpin starts a fresh selected retention clock rather than making a long-pinned playlist immediately expire.

Worker cleanup checks due rows periodically, serializes with pin/regenerate actions, removes **only app-managed playlists**, and confirms absence from the library before retiring the row. An externally removed playlist is detected through containment/current-user library membership; an accessible playlist URL does not mean it is still saved. 403 is not proof of deletion. There is no true Spotify object-delete operation: customer copy should promise removal from Your Library, with Delete now explained in that sense. [Spotify playlist semantics](https://developer.spotify.com/documentation/web-api/concepts/playlists).

## Platform and data constraints

Central Spotify adapter has pacing and a shared database-backed cooldown across web and worker. Start conservatively near 2 requests/second, then adjust from real evidence, not a claimed safe published quota. Honor Retry-After. Distinguish `QUOTA_EXCEEDED` from ordinary throttling and park/retry with long backoff rather than tight loops. Prioritize explicit playlist work over ambient sync.

Consent denial and wrong verified account have distinct screens. A 403 screen names allowlist, Premium and permissions checks when Spotify does not provide an unambiguous reason. Do not mislabel every 403 as “not allowlisted.” No API can verify another person's dashboard settings for us.

Disconnect first disables the account epoch and cancels/invalidates jobs. In-flight responses cannot restore data after deletion. Purge derived data and tokens immediately, plus annotations for this explicit “delete everything” action. The supported revocation path we found is the user's Spotify account Apps page; link to it and distinguish forgetting local credentials from revoking the grant. Existing playlists follow the ratified policy.

Use a private Storage bucket for three daily encrypted annotation backups: tag identities/names, assignment HMACs and necessary key-version information only. Exclude cached Spotify metadata, OAuth tokens, sessions and pending Spotify writes. Keep encryption keys outside the backup. Disconnect invalidates the account epoch, deletes every application backup and confirms absence before reporting application-data deletion complete. Recovery requires an explicit operator action and a currently connected matching account; it cannot restore credentials or restart old playlist jobs. The backup protects against accidental edits, not whole-account loss. Managed provider backup retention is outside the app's direct controls; do not claim byte-level provider erasure. See [hosting backup limits](HOSTING.md).

Keep credentials, screenshots, actual library names and raw responses out of model context, public Git history and build logs. Use synthetic data for AI-assisted UI QA. This is a conservative implementation of the current policy, which covers model ingestion as well as training. [Developer terms](https://developer.spotify.com/terms), [Developer policy](https://developer.spotify.com/policy).

## Delivery and verification

Four sequential milestone gates are encoded in `.build/tasks.json`: real API/deployment proof; first complete useful loop; fast tagging and vocabulary management; resilience/final handoff. The user's October 11 native-goal decision permits bounded parallel tasks in isolated worktrees within those gates. Each coherent change ships through a reviewed PR; a milestone may span several PRs and remains incomplete until its integrated deployment passes every stage and common gate. The orchestrator centrally owns integration, migrations, deployments, Spotify mutations, independent verification and merges. The full phone/throughput acceptance remains a final human check.

Use Vitest for meaningful invariants: query truth tables/nesting/empty buckets, normalization, rename/merge identity, exact bulk union/undo, retention dates, auth state and writer URI restrictions. PostgreSQL integration tests cover transactions, leases and sync reconciliation. Playwright uses synthetic libraries for keyboard and mobile layouts. Fault injection covers lost write responses, worker restarts, 401/403/429 and changing pagination without deliberately hammering Spotify. Small live scripts assert actual schema, grant identity, private creation, ordered membership and removal, emitting only redacted outcomes.

`scripts/check` must typecheck, run relevant automated tests, and build. `scripts/verify-stage.mjs` must execute the stage's live/deployed assertions and emit a redacted JSON receipt tied to Git HEAD. The native orchestrator, or optional runner when used alone, reruns both and checks deployed `/healthz` matches that SHA. Before software completion, finish independent architecture/repository review and reviewed fixes, rerun final verification against final merged/deployed code, and stop the temporary review automation. Handoff includes the URL, merged PRs/issues, actual evidence and revisions, operational limits, shutdown confirmation and pending manual checks. GitHub issues and private coordination/review ledgers provide continuity. Follow `docs/agents/delivery.md` and `docs/AUTONOMY.md` for ownership and delivery gates.
