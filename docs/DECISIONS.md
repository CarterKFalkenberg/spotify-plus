# Accepted product decisions

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
