# Autonomous PR delivery

The user explicitly authorized creating, reviewing and merging this project's PRs without per-PR human approval. This supersedes the earlier draft-only/manual-merge plan. Worktree changes, setup files, skills and implementation all ship through PRs.

## Before the build goal

Authenticate local `gh` as an account with repository write access; administrator access is needed once to configure Actions and branch rules. The connected GitHub app already reports admin/push access, but that does not sign the CLI in. At initial inspection on October 11, main was unprotected and no rulesets existed. CLI login has since been verified as CarterKFalkenberg with repository admin access, `repo` and `workflow` scopes, and Git credential integration. Check actual branch settings before changing protections.

Recommended CLI login: `gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow`, then `gh auth setup-git`. If already signed in, use `gh auth refresh --hostname github.com --scopes workflow` if workflow-file pushes lack scope. A fine-grained alternative needs Contents, Pull requests, Issues and Workflows write; Actions and Checks read; Administration write only for the initial repository-settings setup. Token scope never substitutes for the account's repository role.

Bootstrap this planning branch through a PR, run its `verify` workflow, review it, and merge with a merge commit. Once the check has run, configure main to require PRs, the `verify` check, an up-to-date branch and resolved review conversations. Require zero human approvals and no CODEOWNER or last-push human approval. Keep force pushes/deletion disabled. Allow merge commits. GitHub's separate auto-merge feature is optional: the agent can merge immediately after gates pass.

Use `contents: read` for the CI workflow token. CI performs synthetic checks only; production hosting/Spotify secrets remain local/runtime secrets. Extend CI to the application's typecheck, tests and build when those exist. No human-approved deployment environment gate is part of this single-owner workflow.

## Each change

1. Work on a `codex/...` branch in a worktree based on current main. Finish a coherent change; do not edit or push main directly.
2. Run the relevant checks and live assertions permitted by the accepted setup. Use `code-review` against the recorded base commit, with the current milestone/spec path. Its Standards and Spec review agents are permitted; fix actionable findings and repeat affected checks after edits.
3. Use `pr-writing` to open/update the PR. Record review evidence and the reviewed head SHA. A draft may be used during work; mark it ready after review. Attach it to this chat when tools support that.
4. Wait for CI on that exact head and resolve review threads. Do not bypass checks with admin merge, force-push main or reduce protections to unblock a failure.
5. Merge the tested head using a merge commit and an expected-head check. Merge commits preserve commit ancestry used by the runner's resume ledger. If main changes, update the branch and rerun affected review/checks before merging.
6. Verify GitHub says MERGED and record its merge SHA. Sync subsequent work from origin/main. Fast-forward the primary main checkout when clean; preserve unrelated local changes. Report merged PRs and deployment evidence at handoff.

Final phone/desktop product acceptance remains a human check after software delivery; it is not a gate requiring human review of every PR.

## Skills and autonomy

Repo skills are checked in under `.agents/skills`, so new worktrees inherit them. Upstream provenance is recorded in `.agents/skills/sources.json`. `grill-with-docs` and `wayfinder` are human-invoked planning tools by upstream design. Finish genuine human decisions before AFK execution. The goal loop may research technical questions autonomously, but it must not answer human-interview questions on the user's behalf.

Exact entrypoints, dependencies, review inputs and project overrides are in [skills.md](skills.md). Shared implementation and bootstrap gates are in [acceptance.md](acceptance.md).

When a skill says "call the Skill tool," use Codex's supported skill invocation or read the named SKILL.md and follow it; do not call a nonexistent tool. Specific skills can authorize their described research/review subagents. This does not request a broad agent team for every change.

Use the app's existing automatic approval review for workspace/worktree commands and required network operations. AGENTS.md records intent; it cannot grant OS, network, GitHub or billing permissions. Do not rewrite global safety configuration or bypass denied actions. Verify actual access in preflight; leave a precise blocker if managed policy prevents it.
