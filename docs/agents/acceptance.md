# Milestone acceptance

The complete scope is `docs/PRODUCT-BRIEF.md`, amended by `docs/DECISIONS.md`. `.build/tasks.json` orders the implementation into four stages; its concise bullets do not discard requirements. `docs/PLAN.md` and the researched API/hosting notes guide implementation. Report a material contradiction rather than quietly narrowing the MVP.

## Gates for every implementation milestone

1. Satisfy each stage criterion with observable behavior, including its relevant error/empty/loading states. Record which automated or live assertion proves each criterion; do not mark a plan or stored receipt as proof.
2. Run `scripts/check` for typechecks, meaningful tests and the production build. CI's `verify` check runs synthetic checks without production secrets. The first stage must implement the application check and live verifier before declaring itself ready.
3. Run `scripts/verify-stage.mjs <stage-id>` against the configured account and deployment. Require a fresh redacted receipt matching Git HEAD, frontend/API/jobs health, actual Free plans and successful live assertions. Respect the separately authorized disposable-playlist scope.
4. Review the committed change with `code-review` against the pinned base and originating scope. Fix actionable Standards and Spec findings; repeat affected checks and review after changes. Use `pr-writing` for the final PR description, including actual evidence and limitations.
5. Merge only after required CI passes on the verified head and repository gates are satisfied. Record the PR, verified head, merge SHA and evidence. If anything fails or needs human input, preserve progress and leave the milestone incomplete.

These live/deployment gates apply to application milestones. The bootstrap setup PR instead requires the setup/runner tests, skill/reference validation, independent review and passing CI; it must not claim that the future application or live API already works.

## Required coverage across the stages

- **API proof:** authenticated owner-only access, prohibited Liked Songs writes, real private playlist creation/removal semantics, refresh-grant handling, disconnect purge, scheduled execution and deployment identity.
- **Core loop:** reliable complete library sync, immediate durable tagging, All/Any/None query truth tables and nested stored queries, zero-request previews, private snapshot generation, partial-write recovery and unattended expiry.
- **Fast tagging:** queue and bulk selection/undo semantics; tag normalization, rename/merge/query identity; safe input/IME shortcuts; first-run and returning-session routing; desktop and mobile layouts, including deep links.
- **Resilience:** ambiguous writes, pagination changes, retry limits, disconnect races, expiry/DST/month-end math, 90-day metadata purge with persistent assignments, recovery from free-tier pausing, encrypted annotation restore and quota checks.

Software completion requires all four stages verified and merged. Product acceptance additionally requires the user to perform the real phone flow in under a minute and the familiar-song tagging trial at roughly 3–5 seconds per song. Do not report emulation as those human checks or close the overall MVP acceptance while they remain pending.
