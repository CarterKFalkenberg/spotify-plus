# Autonomous PR delivery

The user explicitly authorized creating, reviewing and merging this project's PRs without per-PR human approval. This supersedes the earlier draft-only/manual-merge plan. Worktree changes, setup files, skills and implementation all ship through PRs.

## Repository baseline

Authenticate local `gh` as an account with repository write access; administrator access is needed once to configure Actions and branch rules. The connected GitHub app already reports admin/push access, but that does not sign the CLI in. At initial inspection on October 11, main was unprotected and no rulesets existed. CLI login has since been verified as CarterKFalkenberg with repository admin access, `repo` and `workflow` scopes, and Git credential integration. Check actual branch settings before changing protections.

Recommended CLI login: `gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow`, then `gh auth setup-git`. If already signed in, use `gh auth refresh --hostname github.com --scopes workflow` if workflow-file pushes lack scope. A fine-grained alternative needs Contents, Pull requests, Issues and Workflows write; Actions and Checks read; Administration write only for the initial repository-settings setup. Token scope never substitutes for the account's repository role.

Bootstrap PR #1 merged through review and `verify`. Main is configured to require PRs, the `verify` check, an up-to-date branch and resolved review conversations, with zero required human approvals and no CODEOWNER or last-push human approval. Preserve force-push/deletion protection and merge commits; revalidate actual settings before relying on them. GitHub's separate auto-merge feature is optional: the agent can merge immediately after gates pass.

Use `contents: read` for the CI workflow token. CI performs synthetic checks only; production hosting/Spotify secrets remain local/runtime secrets. Extend CI to the application's typecheck, tests and build when those exist. No human-approved deployment environment gate is part of this single-owner workflow.

## Each change

1. Work on a `codex/...` branch in an isolated worktree based on current main. Record its issue, owner, dependencies and base SHA. Finish a coherent change; do not edit or push main directly or modify another agent's active checkout.
2. Run the relevant checks and live assertions permitted by the accepted setup. Use `code-review` for the full PR against the recorded base and current head, with the originating ticket and milestone/spec paths. Independent Standards and Spec reviewers use `gpt-6-astra`; fix actionable findings and repeat affected checks/review after edits. Explain evidence-based disagreements. Periodic review does not satisfy this gate.
3. Use `pr-writing` to open/update the PR. Record review evidence and the reviewed head SHA. A draft may be used during work; mark it ready after review. Attach it to this chat when tools support that.
4. Wait for CI on that exact head and resolve review threads. Do not bypass checks with admin merge, force-push main or reduce protections to unblock a failure.
5. The orchestrator independently inspects the evidence and merges the tested head using a merge commit and an expected-head check. Merge commits preserve commit ancestry used by the runner's resume ledger. If main changes, update the branch and rerun affected review/checks before merging. A new head invalidates affected evidence; an agent report alone cannot pass a gate.
6. Verify GitHub says MERGED and record its merge SHA. Sync subsequent work from origin/main. Fast-forward the primary main checkout when clean; preserve unrelated local changes. Report merged PRs and deployment evidence at handoff.

Final phone/desktop product acceptance remains a human check after software delivery; it is not a gate requiring human review of every PR.

## Native goal ownership and continuity

The user's [October 11 decision](../DECISIONS.md#autonomous-native-goal--october-11-2026) authorizes bounded delegation and agent communication, superseding the former one-session-per-milestone limit. The main `gpt-6-astra` chat orchestrates; `gpt-6.1-sol` implementation tasks own coherent tickets in separate worktrees. All roles use Medium reasoning effort under the later human correction. Define interfaces and dependencies before parallel work. Share the primary ignored `.local` directory through a symlink, never copied credentials.

Only the orchestrator integrates branches, verifies delivery and merges. Shared migration ordering, deployments, scheduled runtime changes and Spotify mutations are coordinated centrally and executed by the orchestrator, or by one explicitly assigned operator at a time. Implementation agents prepare code and synthetic evidence; they must not race on shared targets. The scheduled reviewer cannot take that operator role. Read scoped authorization flags before external actions and preserve all existing privacy, Free-plan and playlist-only boundaries.

GitHub [parent issue #4](https://github.com/CarterKFalkenberg/spotify-plus/issues/4) and its child tickets record owners, dependencies, spec links, PRs, base/reviewed-head/merge SHAs, verification evidence, blockers and next actions. Close an implementation ticket only after its acceptance criteria pass and its changes merge. Keep human-only acceptance separate.

| Private durable record                 | Owner and required contents                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.local/build-coordination/state.json` | Orchestrator: active goal/chat, model roles, automation ID/status, ticket/agent/worktree ownership, dependencies, milestone evidence and external-action ownership; explicitly pending human acceptance. |
| `.local/build-review/ledger.json`      | Scheduled reviewer: branch base/head/merge-base, reviewed commit SHAs, stable working-diff fingerprints, snapshot identity, findings, fix verification and complete/partial review status.               |
| `.local/build/state.json`              | Optional shell runner only: its stage results and verified merge/deployment evidence. Do not treat this separate ledger as native-goal completion.                                                       |

Use atomic updates for private ledgers and preserve fields owned by other processes. Never store credentials or actual Spotify content in review/coordination evidence. Resume from issues and these records after interruption, then inspect actual Git, CI, deployment and automation state; a saved claim is not fresh verification. The native goal and unattended shell runner must not run together. See [AUTONOMY.md](../AUTONOMY.md) for periodic review locking, snapshots and shutdown.

## Skills and autonomy

Repo skills are checked in under `.agents/skills`, so new worktrees inherit them. Upstream provenance is recorded in `.agents/skills/sources.json`. `grill-with-docs` and `wayfinder` are human-invoked planning tools by upstream design. The user waived the remaining pre-build interview; proceed from accepted decisions without restarting it. The goal loop may research technical questions autonomously, but it must not answer human-interview questions on the user's behalf.

Exact entrypoints, dependencies, review inputs and project overrides are in [skills.md](skills.md). Shared implementation and bootstrap gates are in [acceptance.md](acceptance.md).

When a skill says "call the Skill tool," use Codex's supported skill invocation or read the named SKILL.md and follow it; do not call a nonexistent tool. Read each applicable skill before use. The native goal has explicit user authorization for bounded delegation beyond a skill's prescribed subagents; assign useful tasks with clear ownership rather than creating an unrelated team.

Use the app's existing automatic approval review for workspace/worktree commands and required network operations. AGENTS.md records intent; it cannot grant OS, network, GitHub or billing permissions. Do not rewrite global safety configuration or bypass denied actions. Verify actual access in preflight; leave a precise blocker if managed policy prevents it.
