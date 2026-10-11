# How the autonomous build works

The user started the native build goal on October 11, 2026, waived the remaining planning interview and authorized bounded delegation. [Delivery issue #4](https://github.com/CarterKFalkenberg/spotify-plus/issues/4) tracks the full MVP; [workflow issue #5](https://github.com/CarterKFalkenberg/spotify-plus/issues/5) records this change. Setup/preflight had passed before the goal request; revalidate access without recreating accounts or overwriting credentials. This workflow record does not establish a software milestone or human acceptance.

## Native goal and ownership

Following the later October 11 human correction, the main chat uses `gpt-6-astra` to orchestrate the goal. Implementation tasks use `gpt-6.1-sol`; independent per-PR Standards/Spec reviewers and the scheduled reviewer use `gpt-6-astra`. All roles use Medium reasoning effort. Each implementation task has a coherent issue, explicit ownership/dependencies and an isolated `codex/...` worktree. Define shared interfaces before parallel work. Symlink the primary ignored `.local` directory into each worktree; never copy secrets.

The orchestrator integrates, independently verifies and merges. It centrally owns shared migration ordering, deployments and Spotify mutations, assigning at most one operator for a shared external action. Subagents prepare implementation and synthetic evidence within their scope. Reports must be inspected and never substitute for human approval. [Delivery rules](agents/delivery.md#native-goal-ownership-and-continuity) define durable ownership and evidence in GitHub issues and `.local/build-coordination/state.json`.

Every PR requires the installed independent Standards/Spec `code-review` against its recorded base and current head, then `pr-writing`, passing exact-head CI, resolved conversations and current integration checks before an expected-head merge. Each application milestone also requires `scripts/check`, fresh redacted `scripts/verify-stage.mjs` evidence, actual Free-plan/usage checks and matching deployed frontend/API/jobs SHAs. Several task PRs may contribute to a milestone; none alone bypass its integrated live gates.

After feature verification, complete independent architecture/repository review and reviewed fixes, rerun affected checks and final end-to-end/deployed smoke verification, and stop the review automation before ending the software goal. The user's real phone and tagging-speed checks remain explicitly pending. See [acceptance.md](agents/acceptance.md).

## Independent build review

The temporary automation **`spotify-plus-build-review`** is now an **ACTIVE five-minute heartbeat** in the existing dedicated review chat `01a12ce4-03c8-7100-b8c3-f6faf1b10368`. It replaces the earlier standalone cron that created a new chat per run. Its model inherits that dedicated chat setting, which the orchestrator set to `gpt-6-astra` with Medium reasoning effort through the supported tool after the later October 11 human correction. Its prompt connects it to the orchestrator chat recorded in `.local/build-coordination/state.json`. This records verified schedule configuration, not a claim that a review ran or that every wall-clock interval is guaranteed. Consult actual automation state and the ledger when resuming. Local tasks require the computer and app to remain running with the project available. [Official scheduled-task documentation](https://learn.chatgpt.com/docs/automations).

The scheduled reviewer must:

1. Acquire `.local/build-review/run.lock` atomically, recording its PID/run identity. Skip while a live reviewer owns it; release in `finally`. Recover stale locks only after checking that the owner is no longer active. Never overlap runs.
2. Inspect coordination/issues, open PRs, active branches and relevant working diffs. Capture a stable snapshot outside active worktrees, excluding `.local`, credentials and real Spotify content. Include nonignored untracked code in the diff fingerprint. Compare fingerprints before and after inspection; changed files make the review partial rather than a claim about the latest tree.
3. Atomically maintain `.local/build-review/ledger.json`, keyed by branch, with base/head/merge-base, reviewed SHAs, snapshot/diff fingerprints, complete/partial status, findings and verified fixes. Review since the last successful snapshot with surrounding context. Detect rebases, force updates and changed bases, expanding to a full comparison when needed. Missing entries mean unreviewed work.
4. Report actionable bugs, regressions, security/privacy risks, races, spec gaps, weak tests and maintainability problems with severity, snapshot SHA/fingerprint, file/line, consequence and suggested correction. Deduplicate findings, verify fixes, post durable findings to the relevant issue/PR and message the orchestrator for delivery to the owning agent. Stay quiet when nothing actionable changed.
5. Never edit active worktrees, merge, deploy, mutate Spotify or run destructive tests. Periodic review supplements the mandatory independent per-PR Standards/Spec gate.

The orchestrator must disable/delete this automation through the supported scheduling tool after final cleanup and completion verification, verify shutdown and record it in coordination/handoff. If the goal ends early, stop the automation and preserve incomplete work and blockers. The reviewer should also stop itself when durable coordination records completion or shutdown. Do not leave it running after the goal ends.

## Optional shell runner

The shell runner is a separate alternative. `./scripts/build --check` may revalidate setup during the native goal; the ordinary command below starts an unattended build and is only for a separate run after the native goal is inactive:

```sh
./scripts/build
```

The accepted hosting budget is $0/month. The runner rejects positive budgets, paid-plan configuration and obsolete Railway targets. It supplies the configured Supabase credentials through environment variables and selects the Cloudflare account for Wrangler. Each build session must verify the actual provider plans/quotas before deploying; these local checks are not billing verification. Paid upgrades are never an automatic fallback.

It completes all remaining software milestones by default. `--one` runs one milestone, `--check` checks setup, and `--status` shows durable progress without starting Codex. You can also tell this chat “continue the build”; an agent must then read the same brief, decisions and stage ledger, use a worktree, and preserve the same verification boundaries.

The launcher uses ordinary `codex exec` with the configured CLI model, live web search, automatic approval review, a structured result schema and specific writable paths. Before a separately chosen runner session, verify its implementation model honors the corrected `gpt-6.1-sol`/Medium implementation policy; this documentation change does not alter global settings or runner code. It is a local CLI process, distinct from the temporary reviewer. [Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

It creates/reuses `.worktrees/build` on `codex/build-mvp`, starting from the committed source checkout. `.local` is shared through a symlink so secrets are neither copied nor tracked. Main's files are untouched. Run from the same source checkout on subsequent invocations; do not launch a second runner from the build worktree itself.

For each stage, a fresh Codex invocation reads the complete product brief, researched contracts, ratified config and last stage result. It implements, checks, commits and deploys the exact commit. The launcher reruns `scripts/check` and `scripts/verify-stage.mjs`, requires a receipt for all three deployments and free-plan assertions, then independently checks `/healthz` for matching frontend, API and jobs SHAs. The implementation agent reviews the change using `code-review`, writes its PR using `pr-writing`, and waits for CI. After the independent local/live gates pass, the launcher verifies the PR and merges its exact tested head with a merge commit. A stage advances only after GitHub confirms the merge. There are three attempts total, with verification feedback after a failure. Merely saying “done” cannot advance the stage.

The stage verifier is application code to be implemented in the first stage; it must execute meaningful assertions, not replay stored receipts. The launcher tests exercise its control flow with simulated Codex/CLI processes. They do **not** prove future application tests, live Spotify behavior, or deployment work before credentials/setup exist.

The runner's durable progress lives in ignored `.local/build/state.json`; private result/log files accompany it. Its lock prevents concurrent shell-runner builds, but does not enforce exclusion against the native goal. Inspect coordination state and active work before choosing either orchestrator. Each milestone has reviewed PRs merged autonomously, with tested head and merge SHA recorded. Required CI and resolved conversations are enforced by main protection; no human PR approval is required. Before further changes, sync from origin/main. The native goal performs equivalent gates directly and may fast-forward clean primary main. Human phone/desktop acceptance remains pending rather than being claimed by the runner.

Useful work resumes after interruptions: rerun the command and it skips verified stages whose commit SHAs remain in history. It preserves partial implementation on blockers; it does not reset the worktree. A timeout, exhausted account quota, lost external access or automatic review rejection leaves the current stage incomplete. Resolve the stated cause and run again. “Needs user” stops immediately instead of pretending a human authorization occurred.

On normal exit/Ctrl+C, check no child Codex remains running before restarting. If a hard kill left `.local/build/lock`, read its `pid`, confirm that process and its child are no longer running, and remove **only that stale lock directory**. Do not remove `.local/build/state.json` or the worktree. A different `codex/build-mvp` checkout already using that branch must be resolved by inspection, not forced removal.

The build runs while this machine stays awake, network access is available and Codex authentication/usage permit it. To keep it awake during the run:

```sh
caffeinate -i ./scripts/build
```

Supabase cron and deployed functions run independently after your Mac stops, subject to the free tier's pausing and quota limits described in [HOSTING.md](HOSTING.md). A permanent cloud build agent is not needed. The app runtime can continue while this Mac is off; the local build command cannot.
