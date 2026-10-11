# Installed skills

Skills are repository-local so each worktree inherits the same instructions. Bootstrap PR #1 merged this setup. If automatic discovery does not expose a skill in the current chat, open its entrypoint below explicitly; do not assume it was loaded. Upstream names differ from the user's shorthand: `grill-me-with-docs` is installed as `grill-with-docs`, and the requested codebase reviewer is `code-review`.

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

At the start of a change, record the current `origin/main` SHA as the review base. Commit the intended change before running the skill's three-dot diff so it includes all reviewable files. Give both independent `gpt-6-astra` reviewers the same pinned base/current head and originating ticket/spec; review the full PR. Repository standards include `AGENTS.md` and the relevant `docs/agents/` rules. A build PR's spec includes its milestone in `.build/tasks.json`, `docs/agents/acceptance.md`, and the relevant brief/accepted decisions. Workflow PRs use the corresponding user decision in `docs/DECISIONS.md` and issue acceptance. New changes invalidate affected evidence and require affected checks/review again. These defaults supply the review inputs without another user question.

## Project overrides

The user's accepted decisions and all-changes-through-PR instruction take precedence over upstream defaults. The October 11, 2026 native-goal instruction waives the remaining pre-build planning-readiness interview. Preserve accepted answers and do not restart grilling. A genuinely new human-only decision remains a blocker for its dependent work; an AFK run cannot resolve a HITL ticket by answering for the user.

Research and prototype work use isolated `codex/...` branches/worktrees. Never push straight to main. If an upstream skill calls for a throwaway branch with no PR, open a draft PR for the retained artifact and label it as research/prototype, not production. Close it unmerged when obsolete; carry only the validated decision or implementation into the reviewed shipping PR. Keep tokens and real Spotify content out of these artifacts too.

The native goal separately authorizes bounded delegation and agent communication. Implementation and per-PR review tasks use `gpt-6-astra`; the orchestrator and periodic reviewer use `gpt-6.1-sol`. Follow [delivery ownership](delivery.md#native-goal-ownership-and-continuity), retain independent Standards/Spec reviews for every PR, and do not modify upstream skills just to encode this project override. Installation alone does not start an interview or build; this run is authorized by the user's explicit goal request.
