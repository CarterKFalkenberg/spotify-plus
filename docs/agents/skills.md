# Installed skills

Skills are repository-local so a worktree based on this branch inherits the same instructions. Until the bootstrap PR merges, main does not contain this setup. If automatic discovery does not expose a skill in the current chat, open its entrypoint below explicitly; do not assume it was loaded. Upstream names differ from the user's shorthand: `grill-me-with-docs` is installed as `grill-with-docs`, and the requested codebase reviewer is `code-review`.

| Skill entrypoint | Use and dependencies |
| --- | --- |
| [grill-with-docs](../../.agents/skills/grill-with-docs/SKILL.md) | User-invoked planning interview; calls grilling and domain-modeling. |
| [wayfinder](../../.agents/skills/wayfinder/SKILL.md) | User-invoked map of unresolved decisions; uses grilling, domain-modeling, research and prototype, with tracker setup below. |
| [code-review](../../.agents/skills/code-review/SKILL.md) | Every PR; independent Standards and Spec review agents. |
| [grilling](../../.agents/skills/grilling/SKILL.md) | Human decisions and their prerequisites; never invent the user's answers. |
| [domain-modeling](../../.agents/skills/domain-modeling/SKILL.md) | Resolved vocabulary and consequential ADRs; includes both document formats. |
| [research](../../.agents/skills/research/SKILL.md) | Delegate a factual investigation to a background agent using primary sources. |
| [prototype](../../.agents/skills/prototype/SKILL.md) | Disposable logic or UI exploration; includes both reference guides. |
| [setup-matt-pocock-skills](../../.agents/skills/setup-matt-pocock-skills/SKILL.md) | Tracker/domain configuration; completed by the adjacent tracker and domain docs under the user's delegated process authority. |
| [pr-writing](../../.agents/skills/pr-writing/SKILL.md) | Project-authored title/body guidance grounded in the final diff and actual verification. |

The eight upstream skills retain their bundled references, invocation metadata and MIT license. The pinned source commit and installed names are in `.agents/skills/sources.json`; `pr-writing` is locally authored. Change upstream files only deliberately, recording the reason and provenance; a newly named optional skill is not permission to install it automatically.

## Review inputs

At the start of a change, record the current `origin/main` SHA as the review base. For this bootstrap, use main commit `3412a96cc41dae5e4ef9c23a6ff5e5dc57e336fe`. Commit the intended change before running the skill's three-dot diff so it includes all reviewable files. Give both reviewers the same base/head and spec; repository standards include `AGENTS.md` and the relevant `docs/agents/` rules. A build PR's spec is its milestone in `.build/tasks.json`, `docs/agents/acceptance.md`, and the relevant brief/accepted decisions. The bootstrap spec is the repository/AI setup in `docs/BEFORE-GOAL.md` and `docs/agents/delivery.md`. These defaults supply the review inputs without another user question.

## Project overrides

The user's accepted decisions and all-changes-through-PR instruction take precedence over upstream defaults. Preserve accepted answers during planning. Complete genuine human interviews while the user is available; an AFK run cannot resolve a HITL ticket by answering for them.

Research and prototype work use isolated `codex/...` branches/worktrees. Never push straight to main. If an upstream skill calls for a throwaway branch with no PR, open a draft PR for the retained artifact and label it as research/prototype, not production. Close it unmerged when obsolete; carry only the validated decision or implementation into the reviewed shipping PR. Keep tokens and real Spotify content out of these artifacts too.

Invoking a skill permits only its prescribed delegation (research or the two review axes), not an unrelated agent team. Do not start planning interviews, create remote issues or run the build merely because the skills were installed.
