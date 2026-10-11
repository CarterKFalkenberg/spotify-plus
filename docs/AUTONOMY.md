# How the autonomous build works

After [setup](SETUP.md) and the bootstrap PR merge, start a native goal in this chat, or use this optional command from the clean main checkout. Do not run both routes concurrently:

```sh
./scripts/build
```

The accepted hosting budget is $0/month. The runner rejects positive budgets, paid-plan configuration and obsolete Railway targets. It supplies the configured Supabase credentials through environment variables and selects the Cloudflare account for Wrangler. Each build session must verify the actual provider plans/quotas before deploying; these local checks are not billing verification. Paid upgrades are never an automatic fallback.

It completes all remaining software milestones by default. `--one` runs one milestone, `--check` checks setup, and `--status` shows durable progress without starting Codex. You can also tell this chat “continue the build”; an agent must then read the same brief, decisions and stage ledger, use a worktree, and preserve the same verification boundaries.

The launcher uses ordinary `codex exec` with the configured default model, live web search, automatic approval review, a structured result schema and specific writable paths. This is a local CLI process, not a scheduled desktop automation, background promise, or additional OpenAI API integration. [Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

It creates/reuses `.worktrees/build` on `codex/build-mvp`, starting from the committed source checkout. `.local` is shared through a symlink so secrets are neither copied nor tracked. Main's files are untouched. Run from the same source checkout on subsequent invocations; do not launch a second runner from the build worktree itself.

For each stage, a fresh Codex invocation reads the complete product brief, researched contracts, ratified config and last stage result. It implements, checks, commits and deploys the exact commit. The launcher reruns `scripts/check` and `scripts/verify-stage.mjs`, requires a receipt for all three deployments and free-plan assertions, then independently checks `/healthz` for matching frontend, API and jobs SHAs. The implementation agent reviews the change using `code-review`, writes its PR using `pr-writing`, and waits for CI. After the independent local/live gates pass, the launcher verifies the PR and merges its exact tested head with a merge commit. A stage advances only after GitHub confirms the merge. There are three attempts total, with verification feedback after a failure. Merely saying “done” cannot advance the stage.

The stage verifier is application code to be implemented in the first stage; it must execute meaningful assertions, not replay stored receipts. The launcher tests exercise its control flow with simulated Codex/CLI processes. They do **not** prove future application tests, live Spotify behavior, or deployment work before credentials/setup exist.

Durable progress lives in ignored `.local/build/state.json`; private result/log files accompany it. A lock prevents concurrent builds. Each milestone has a reviewed PR merged into main autonomously, with the tested head and merge SHA recorded. Required CI and resolved review conversations are enforced by main protection; no human PR approval is required. Before further changes, sync the feature branch from origin/main. A native goal performs the same gates directly and may fast-forward the clean primary main checkout. Once software is ready, the runner stops for actual human phone/desktop acceptance rather than claiming those tests were performed.

Useful work resumes after interruptions: rerun the command and it skips verified stages whose commit SHAs remain in history. It preserves partial implementation on blockers; it does not reset the worktree. A timeout, exhausted account quota, lost external access or automatic review rejection leaves the current stage incomplete. Resolve the stated cause and run again. “Needs user” stops immediately instead of pretending a human authorization occurred.

On normal exit/Ctrl+C, check no child Codex remains running before restarting. If a hard kill left `.local/build/lock`, read its `pid`, confirm that process and its child are no longer running, and remove **only that stale lock directory**. Do not remove `.local/build/state.json` or the worktree. A different `codex/build-mvp` checkout already using that branch must be resolved by inspection, not forced removal.

The build runs while this machine stays awake, network access is available and Codex authentication/usage permit it. To keep it awake during the run:

```sh
caffeinate -i ./scripts/build
```

Supabase cron and deployed functions run independently after your Mac stops, subject to the free tier's pausing and quota limits described in [HOSTING.md](HOSTING.md). A permanent cloud build agent is not needed. The app runtime can continue while this Mac is off; the local build command cannot.
