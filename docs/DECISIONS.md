# Accepted product decisions

## Playlist sources across the whole app — October 21, 2026

The human requested playlist ingestion through a Sources sidebar tab, all sources enabled by default, deduplication across playlists and equal title/artist Spotify tracks, bounded background batching and clear removal behavior. They explicitly selected **whole app** for source selection and **exclude app-generated playlists by default**, then requested the accepted plan be built and shipped with documentation and diagrams updated. See [Sources contract](SOURCES.md) and [issue #72](https://github.com/CarterKFalkenberg/spotify-plus/issues/72).

This extends the original Liked Songs-only scope. Source selection controls browsing, tagging and future playlist queries; it does not edit Spotify or existing generated snapshots. Memberships are independent, tags persist when the last enabled membership disappears, and incomplete sync is not evidence of removal. Exact normalized title/complete-artist grouping preserves meaningful version suffixes and original track identities. No new Spotify write capability, paid hosting, AI processing or human acceptance waiver is authorized.

The user confirmed these choices in chat on October 11, 2026:

- Default playlist retention: one calendar month, with the original 1 week / 1 month / 3 months / pinned picker.
- Purge removed-track cached metadata after 90 days.
- Tag assignments and the minimal identifier needed to restore them persist until “delete everything.”
- Returning desktop sessions open the queue; show the bulk-backlog shortcut above 100 untagged songs. First run opens groups by size.
- Regenerate preserves the playlist's current Spotify name.
- Disconnect deletes app data and credentials and keeps existing Spotify playlists. Cleanup stops after disconnect.
- Modified letter shortcuts while the tag input is focused; retain the specified number slots and empty-input arrow behavior.
- Keep the MVP as written, including deep links and snapshot playlists.
- Hosting must cost **$0/month**. Supabase was suggested for consideration; the implementation choice is Supabase Free plus Cloudflare Workers Free.

These answers settle product choices and the budget. They do not supply service credentials or consent to Spotify account writes. Setup retains separate, concrete deployment/repository/test-playlist authorization fields. `productDecisionsAccepted` is already true in the template; do not ask the user to ratify these same choices again. Final real-device product acceptance still happens after implementation.

## Repository and AI workflow — October 11, 2026

The user requested all work in worktrees/branches, all repository changes through PRs, and autonomous merges without per-PR human approval. Main remains a clean tracking checkout. Install Matt Pocock’s current `grill-with-docs`, `wayfinder` and `code-review` skills and their direct skill dependencies; add a project PR-writing skill. Preserve accepted product decisions when using the planning skills. The user accepts the documented $0 hosting trade-offs. See `agents/delivery.md` for the concrete workflow and `BEFORE-GOAL.md` for readiness and resumption.

## Autonomous native goal — October 11, 2026

The user subsequently requested the complete MVP build, deployment, verification and cleanup through a native goal in the main chat, while away. The remaining pre-build planning-readiness interview is explicitly waived; do not reopen settled product decisions or answer human questions on the user's behalf. This workflow is tracked in [delivery issue #4](https://github.com/CarterKFalkenberg/spotify-plus/issues/4) and [workflow issue #5](https://github.com/CarterKFalkenberg/spotify-plus/issues/5).

- Bounded delegation for implementation, research, testing and independent review is authorized, including communication between agents. This supersedes the earlier one-implementation-session-per-milestone and restricted-team convention. Each implementation task owns an isolated `codex/...` worktree and branch; establish interfaces and dependencies before parallel work.
- The user's model assignment is `gpt-6-astra` for implementation and per-PR Standards/Spec reviewers, and `gpt-6.1-sol` for the main orchestrator and scheduled reviewer. This is a workflow choice, not a change to global model settings.
- The orchestrator owns integration, verification and merges, and centrally coordinates shared migrations, deployments and Spotify mutations. It inspects evidence independently; a subagent's report cannot establish success or human approval.
- Dependency installation, local tests/containers, repository issues/branches/worktrees/PRs, autonomous reviewed merges, deployments to the configured Free targets, additive migrations, scheduled jobs, private annotation backups and tracked disposable “Tagger API test …” playlist operations are authorized. Continue reading the separate authorization flags and exact targets in `.local/config.json`; preserve existing credentials. No paid upgrades, Liked Songs writes, unrelated playlist changes, destructive production migrations or bypass of approval controls is authorized.
- Use the native goal as the sole build orchestrator. The shell runner remains optional for a separate run; do not launch it concurrently. Its `--check` preflight is permitted.
- Run an independent review automation every five minutes during the build. It may exchange task messages and post findings to relevant repository issues/PRs. It must use stable snapshots and a durable review ledger, prevent overlapping runs, deduplicate findings and verify fixes, remain quiet when nothing actionable changed, and leave active worktrees, merges, deployments and Spotify mutations to their owners. See [the automation record](AUTONOMY.md#independent-build-review).
- Every PR still requires the installed two-axis `code-review`, final `pr-writing`, passing CI and resolved conversations on the exact head, up-to-date integration checks and an expected-head merge. New changes invalidate affected review evidence. Application milestones still require deployment and redacted live verification; smaller task PRs do not complete a milestone by themselves.

Before software completion, perform a deep independent architecture/repository review, fix concrete findings through reviewed PRs, and rerun affected checks plus final end-to-end and deployed smoke verification. The final deployment must correspond to final merged code. Shut down the temporary review automation before ending the goal. Keep actual phone timing and personal tagging-speed acceptance pending for the user's return; they do not require an indefinitely running software-build goal. These instructions preserve the original MVP and all privacy, cost, authorization and product-acceptance constraints.

## Model roles and review heartbeat correction — October 11, 2026

The user later corrected the earlier native-goal model assignment: `gpt-6-astra`
owns orchestration and review, including both per-PR Standards/Spec axes and the
scheduled reviewer. Implementation exclusively uses `gpt-6.1-sol`. This supersedes
the earlier role assignment above; historical results and evidence remain unchanged.
The subsequent human correction sets Medium reasoning effort for every role,
including implementation, orchestration, both review axes and the scheduled reviewer.

The orchestrator replaced the standalone new-chat-per-run review cron with an
ACTIVE five-minute `spotify-plus-build-review` heartbeat in the existing dedicated
review chat `01a12ce4-03c8-7100-b8c3-f6faf1b10368`. The heartbeat inherits the chat's
model and effort, set to Astra/Medium through the supported tool. This records the reported supported
configuration change, not proof that a particular review ran; inspect actual
schedule state and the independent ledger when resuming. Ownership, privacy,
review gates and final automation shutdown requirements remain in force.

## Playlist publication requirement — October 11, 2026

The user resolved the access-privacy question with: **“Hidden from profile/search is sufficient.”** Manual Spotify “Make private” is not required. This amends the original brief's private-playlist wording: generated playlists must actually be hidden from the profile and search and remain noncollaborative; this does not promise link-access restrictions.

The human accepted the hidden outcome, not command acknowledgement as a substitute, and did not waive actual hiding. Actual profile/search hiding is **UNVERIFIED product acceptance** until independently established or expressly waived by the user.

Our software verification method uses acknowledged explicit `public:false` updates. Spotify acknowledges explicit publication updates, but deployed observations show contradictory `public` readback after population even when a fixed-false metadata PUT succeeds. Delivery evidence must distinguish an acknowledged publication command from independently verified hidden state. The runtime and live proofs retain ownership, noncollaboration, metadata, ordered membership, snapshot, ambiguous-write and expiry checks; they must not relabel a true/null readback as false or claim hidden state was verified. See [the publication contract](SPOTIFY-API.md#publication-command-contract--october-11-2026) and [issue #44](https://github.com/CarterKFalkenberg/spotify-plus/issues/44#issuecomment-6115988774).

## Ambitious visual redesign and optional dark mode — October 18, 2026

For [issue #63](https://github.com/CarterKFalkenberg/spotify-plus/issues/63), the user requested **“a large UI refactor”** and **“Make this look like it was designed by apple & spotify combined. Use their UI patterns as inspiration (dont copy exactly)”**, with **“each page should look night and day different compared to how it looks right now.”** They granted full design control and asked for consistent design patterns and critic agents to push back on common AI-looking patterns. This supersedes the earlier bounded visual-refinement direction; it preserves every product behavior and the original MVP boundaries.

The user additionally requested **“ensure dark mode is an option too”**. The implementation choice is a persistent device-level Light/Dark/System preference, initially following System. This three-choice control is an implementation judgment, not a claim that the user specified those exact choices. Both neutral light and graphite dark appearances receive full visual and accessibility review.

The user also requested **“detailed before and after visual proof-of-work on your PR(s), and show that same proof-of-work back to me once you're done”**. PR evidence and final delivery must include the same reviewable synthetic before/after comparisons, with source provenance and explanations. All actual Spotify content and credentials remain excluded from model-visible proof. Software verification and the existing human-only phone, tagging-speed and publication acceptance boundaries remain separate.

## Guided everyday workflows — October 21, 2026

For [issue #67](https://github.com/CarterKFalkenberg/spotify-plus/issues/67), the user requested a second substantial usability overhaul: reduce competing queue controls while preserving large artwork and fast tagging; explain the library's purpose, provide Songs/Artists/Albums/Decades browsing and bounded pages; replace the appearance select with a compact contextual control; guide playlist creation through explicit steps; and emphasize playlist identity, expiry, and Open in Spotify while moving maintenance into each playlist's context. Tags should be easier to scan and manage. The user explicitly preserves all existing behavior, keyboard/IME safety, exact selection/undo semantics, query correctness and durable playlist retry guarantees. Playlists with test-looking names must never be silently hidden, renamed, or removed.

The implementation uses Choose tags → Review songs → Name & keep, with live cached counts, optional Any/None refinements, Back/Continue navigation, and an explicit final Create action. These are design choices within the user's direction. Artist portraits and playlist covers use Spotify metadata when available, with honest absent/broken-image fallbacks. This changes presentation, not authorization or product scope. Synthetic visual critique and software checks remain distinct from the user's actual phone and tagging-speed acceptance.

## Queue listening in the webpage — October 21, 2026

For [issue #70](https://github.com/CarterKFalkenberg/spotify-plus/issues/70), the user explicitly selected Spotify Web Playback SDK audio **inside the webpage**, accepting a short-lived Spotify access token in browser memory. This supersedes deep-links-only audio for the focused tagging queue; it does not add remote-client controls or playback elsewhere in the app. The later SDK profile-scope exception is recorded below. Existing Open in Spotify remains available.

Play starts the current song at `floor(durationMs / 3)` and automatically pauses after 20 seconds of confirmed playback. Play more resumes from that point until manual pause or the song ends. A small Pause control remains available while listening. Changing songs, leaving the queue, closing the mobile song sheet, disconnecting or unmounting stops the owned browser player. Nothing automatically starts the next queue song. Tag input, shortcuts, IME and both appearances retain their behavior.

Playback is optional. Existing grants continue tagging and expose Enable playback on a deliberate listen attempt. The optional upgrade now requests `streaming`, `user-modify-playback-state`, `user-read-email` and `user-read-private` alongside the existing grant, under the explicit SDK exception below. This combined access token retains those existing library/playlist capabilities; it is not a streaming-only token. Only verified scope metadata permits browser delivery, refresh tokens remain server-side, and the access token is confined to the SDK/controller closure, never UI state, storage, URLs, logs or errors. This is a narrowly accepted exception to the earlier all-tokens-server-side architecture. The queue preloads the SDK script with a brief Loading audio state, without creating a device or requesting a token. Play creates the page’s single SDK player on first use and activates it synchronously in each click. Later queue controllers exclusively lease and reconnect that same instance; teardown still pauses/disconnects it and removes the old controller’s callbacks. See the [SDK lifecycle rationale](SPOTIFY-API.md#one-sdk-instance-per-document--october-21-2026).

Premium, browser encrypted-media support, Spotify application configuration and fresh consent remain prerequisites. The first implementation used streaming/control without profile scopes because the scope guide and SDK how-to differed; that initial restriction is superseded only by the explicit human decision below. Synthetic SDK tests establish our behavior, not live audio availability; authenticated live checks and actual listening remain separate evidence.

## Optional SDK profile-scope exception — October 21, 2026

The user explicitly answered **“Allow the SDK scopes and retest”** to the question naming `user-read-email` and `user-read-private` for optional webpage playback, with no storage or display of profile fields. This narrowly overrides the original brief's no-profile-scope rule for **Enable playback** only. Ordinary login/bootstrap keep their exact existing scope set. No new profile feature, profile lookup, email storage or profile display is authorized.

The optional grant must prove all four SDK/playback scopes before any access token reaches browser memory: `streaming`, `user-modify-playback-state`, `user-read-email`, `user-read-private`. Previously approved streaming/control-only grants require Enable playback consent again, while tagging remains available. Refresh credentials remain encrypted on the server; the combined access token remains memory-only and retains the already documented library/playlist capabilities plus the newly accepted profile-reading capabilities. Spotify's SDK may read permitted email/private profile fields; the app does not store or display them. The existing owner identity normalization still retains only the required account identifiers from the existing identity call.

The official [web-player how-to](https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player), reread October 21, lists streaming/email/private scopes. The orchestrator reported the deployed SDK rejected the prior grant with its fixed invalid-scopes authentication event. These motivate the authorized retest; they do not establish successful playback, prove that each scope is individually necessary, or authorize any further scopes. Live SDK playback remains a separate verification gate.
