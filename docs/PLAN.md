# Spotify Song Tagger: build plan

Prepared October 10, 2026. This is the implementation proposal for the original [product brief](PRODUCT-BRIEF.md). Product defaults below are proposals until the user ratifies them; no application build or paid infrastructure creation has started.

## Outcome and scope

Build one private personal application whose first useful release can connect, sync, tag, preview a query, create a private Spotify playlist, and remove it automatically after its selected retention. The final acceptance is a real phone flow under a minute and familiar-song tagging at roughly 3–5 seconds per song. Local tests alone never establish that acceptance.

Keep all five stages in the first useful release. The initial API/hosting proof is internal preparation, not a read-only browser advertised as a release. Preserve every MVP feature in the brief; use later stages to finish throughput, vocabulary gardening, mobile triage, and fault recovery. Deep-link-only audio and snapshot playlists are appropriate MVP boundaries.

## Decisions to ratify

| Decision | Recommendation | Reason |
| --- | --- | --- |
| Default playlist retention | One calendar month; picker has 1 week / 1 month / 3 months / pinned | Disposable by default, without frequent surprise removal |
| Removed metadata retention | 90 days | Useful short archive, finite Spotify metadata cache |
| Assignments after metadata purge | Persist annotations keyed by an HMAC of Spotify track ID while the account remains connected | Re-like restores tags without keeping titles, artists, art URLs, or raw track IDs indefinitely |
| Returning desktop home | Focused queue; bulk shortcut when >100 untagged | First-run groups tackle backlog; daily use remains quick |
| Regenerate name | Preserve the current Spotify name | User renames remain authoritative |
| Disconnect playlists | Keep existing playlists; explicitly explain that automatic cleanup stops | Disconnect deletes app data, rather than surprising the user with playlist removal |
| Letter shortcuts | Alt/Option+letter in the focused input; bare letters only outside editable controls | Empty-input S still consumes the first letter of “sad”; emptiness alone cannot solve this conflict |
| Initial hosting budget | Aim for $10–20/month, ratify a spend ceiling | Three small always-on services; measured usage determines cost |

The persistent-annotation key is a minimization design, not a claim that pseudonymized identifiers are exempt from Spotify terms. Delete the annotations, key, credentials, and all derived data on explicit “delete everything.” If the user chooses different defaults, record them in `.local/config.json` before implementation.

## Architecture

Use **TypeScript, React Router framework mode, Node 24 LTS, PostgreSQL with Drizzle migrations**, and Railway. One codebase builds a web process and a worker process. PostgreSQL stores jobs as well as application data. SQL leases, scheduled timestamps, and retries suffice at one user; Redis would add operations without solving a current problem. React Router supports a Docker-based Node deployment; Node 24 is an LTS release. [React Router deployment docs](https://reactrouter.com/start/framework/deploying), [Node release status](https://nodejs.org/en/about/previous-releases).

Railway hosts `web`, `worker`, and `Postgres` in one project and environment. Web serves authenticated UI/actions and creates durable jobs. Worker processes import, playlist writes, cleanup, reconciliation and retention independently of browser requests. One worker polls briefly and sleeps when idle. App-open probes can use the shared rate limiter while long walks stay in the worker. Never enable sleep for the worker. The web process remains running initially for predictable phone access.

Budget is an estimate, not a platform quote: Railway Hobby has a $5 minimum including $5 usage, with actual memory, CPU, disk and egress billed by consumption. Small web/worker/database processes suggest roughly $10–20/month initially; measure after deployment. Set a billing alert and a user-chosen hard ceiling, understanding that hitting the ceiling stops services and cleanup. [Railway pricing](https://docs.railway.com/pricing/plans), [cost controls](https://docs.railway.com/pricing/cost-control).

Sites was evaluated. Its private hosting uses ChatGPT identity and its documented unattended update path depends on linked automation. This project specifically requires Spotify login to be the only login and a continuously available worker. Railway is the selected deployment target.

Repository structure stays small: `app/` for routes/components, `server/` for database, auth, query and Spotify logic, `worker/` for durable jobs, `db/` for schema/migrations, `tests/` for synthetic contracts and browser flows, and `scripts/` for repeatable checks/deployments. No monorepo or separate backend repository.

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

Creation freezes the selected track IDs/URIs, query and retention before queuing a write. Sort newest-liked first for deterministic results. Revalidate the library version on create if a sync changed it since preview. Explicitly set `public:false` and `collaborative:false`. Dates use America/New_York: 1 week is seven calendar dates; 1/3 months clamp month ends. A playlist remains valid through its displayed expiry date; the next local date becomes eligible for cleanup. UI and Spotify description agree on this convention.

Playlist creation has a durable operation ID embedded in a compact description marker. If POST create times out, reconcile that marker through current-user playlists before issuing another create; if visibility is unresolved, retain an unknown/incomplete state rather than blindly creating duplicates. Save the Spotify ID as soon as confirmed. Writes then replace the first ≤100 items and append subsequent ≤100-item chunks.

**A saved chunk position alone does not make append idempotent.** A POST may succeed before its response is lost. On ambiguity or restart, fetch ordered playlist items, compare against the frozen target, and resume only a verified prefix. Otherwise rebuild the managed playlist contents deterministically. Never blindly replay append. Keep incomplete records visible with Retry. Regenerate serializes with cleanup, rereads the current name and non-Tagger description text, updates contents and the Tagger-managed query/expiry disclosure, and resets expiry after successful completion.

Descriptions also disclose that manual Spotify edits are overwritten by Regenerate and the playlist is removed on expiry. Use compact query rendering and bounded truncation if the live description limit requires it; the app retains the full AST. Extend and Pin/Unpin update both database and disclosure through retryable jobs. Unpin starts a fresh selected retention clock rather than making a long-pinned playlist immediately expire.

Worker cleanup checks due rows periodically, serializes with pin/regenerate actions, removes **only app-managed playlists**, and confirms absence from the library before retiring the row. An externally removed playlist is detected through containment/current-user library membership; an accessible playlist URL does not mean it is still saved. 403 is not proof of deletion. There is no true Spotify object-delete operation: customer copy should promise removal from Your Library, with Delete now explained in that sense. [Spotify playlist semantics](https://developer.spotify.com/documentation/web-api/concepts/playlists).

## Platform and data constraints

Central Spotify adapter has pacing and a shared database-backed cooldown across web and worker. Start conservatively near 2 requests/second, then adjust from real evidence, not a claimed safe published quota. Honor Retry-After. Distinguish `QUOTA_EXCEEDED` from ordinary throttling and park/retry with long backoff rather than tight loops. Prioritize explicit playlist work over ambient sync.

Consent denial and wrong verified account have distinct screens. A 403 screen names allowlist, Premium and permissions checks when Spotify does not provide an unambiguous reason. Do not mislabel every 403 as “not allowlisted.” No API can verify another person's dashboard settings for us.

Disconnect first disables the account epoch and cancels/invalidates jobs. In-flight responses cannot restore data after deletion. Purge derived data and tokens immediately, plus annotations for this explicit “delete everything” action. The supported revocation path we found is the user's Spotify account Apps page; link to it and distinguish forgetting local credentials from revoking the grant. Existing playlists follow the ratified policy.

Backups must not silently defeat deletion. Enable daily managed backups only after the API-proof stage verifies the project token can enumerate and delete this database's backups. Daily Railway backups normally last six days, so natural expiry alone misses Spotify's five-day disconnect deadline. Disconnect creates a durable host-cleanup job that deletes every affected backup and verifies absence; it remains runnable without Spotify credentials. Keep a deletion epoch outside restoreable application data, and restore only through the documented procedure, so an old backup cannot re-enable a disconnected account. Do not enable PITR or extra backup copies in the MVP. If scoped backup deletion is unavailable in the actual account, resolve the backup design before enabling it or claiming disconnect complete. [Railway backups](https://docs.railway.com/volumes/backups), [backup API](https://docs.railway.com/integrations/api/manage-volumes).

Keep credentials, screenshots, actual library names and raw responses out of model context, public Git history and build logs. Use synthetic data for AI-assisted UI QA. This is a conservative implementation of the current policy, which covers model ingestion as well as training. [Developer terms](https://developer.spotify.com/terms), [Developer policy](https://developer.spotify.com/policy).

## Delivery and verification

Four sequential milestones are encoded in `.build/tasks.json`: real API/deployment proof; first complete useful loop; fast tagging and vocabulary management; resilience/final handoff. Each stage deploys from a committed feature branch and records evidence. No automatic merge to main. The full phone/throughput acceptance remains a final human check.

Use Vitest for meaningful invariants: query truth tables/nesting/empty buckets, normalization, rename/merge identity, exact bulk union/undo, retention dates, auth state and writer URI restrictions. PostgreSQL integration tests cover transactions, leases and sync reconciliation. Playwright uses synthetic libraries for keyboard and mobile layouts. Fault injection covers lost write responses, worker restarts, 401/403/429 and changing pagination without deliberately hammering Spotify. Small live scripts assert actual schema, grant identity, private creation, ordered membership and removal, emitting only redacted outcomes.

`scripts/check` must typecheck, run relevant automated tests, and build. `scripts/verify-stage.mjs` must execute the stage's live/deployed assertions and emit a redacted JSON receipt tied to Git HEAD. The build runner reruns both and checks deployed `/healthz` matches that SHA. Final handoff includes the URL, draft PR, known limitations, and the user's few explicit manual checks. No separate project tracker, ceremonies, or agent framework is required.
