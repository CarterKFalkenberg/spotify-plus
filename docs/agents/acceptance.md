# Milestone acceptance

The complete scope is `docs/PRODUCT-BRIEF.md`, amended by `docs/DECISIONS.md`. `.build/tasks.json` orders the implementation into four stages; its concise bullets do not discard requirements. `docs/PLAN.md` and the researched API/hosting notes guide implementation. Report a material contradiction rather than quietly narrowing the MVP.

## Gates for every implementation milestone

1. Satisfy each stage criterion with observable behavior, including its relevant error/empty/loading states. Record which automated or live assertion proves each criterion; do not mark a plan or stored receipt as proof.
2. Run `scripts/check` for typechecks, meaningful tests and the production build. CI's `verify` check runs synthetic checks without production secrets. The first stage must implement the application check and live verifier before declaring itself ready.
3. Run `scripts/verify-stage.mjs <stage-id>` against the configured account and deployment. Require a fresh redacted receipt matching Git HEAD, frontend/API/jobs health, actual Free plans and successful live assertions. Respect the separately authorized disposable-playlist scope.
4. Review the committed change with `code-review` against the pinned base and originating scope. Fix actionable Standards and Spec findings; repeat affected checks and review after changes. Use `pr-writing` for the final PR description, including actual evidence and limitations.
5. Merge only after required CI passes on the verified head and repository gates are satisfied. Record the PR, verified head, merge SHA and evidence. If anything fails or needs human input, preserve progress and leave the milestone incomplete.

These live/deployment gates apply to application milestones. Bounded implementation tickets may ship in several reviewed PRs, but a stage remains incomplete until every stage criterion and common gate passes against the integrated deployment. Each code PR still runs appropriate checks; the orchestrator owns shared live verification and deployment. Setup/workflow-only PRs instead require relevant setup/runner tests, skill/reference validation where affected, independent review and passing CI; they must not claim that the future application or live API already works.

## Required coverage across the stages

- **API proof:** authenticated owner-only access, prohibited Liked Songs writes, real acknowledged fixed-false publication commands, strict noncollaboration and playlist removal semantics, refresh-grant handling, disconnect purge, scheduled execution and deployment identity.
- **Core loop:** reliable complete library sync, immediate durable tagging, All/Any/None query truth tables and nested stored queries, zero-request previews, snapshot generation with acknowledged profile/search-hiding requests (publication readback is explicitly unverified), partial-write recovery and unattended expiry.
- **Fast tagging:** queue and bulk selection/undo semantics; tag normalization, rename/merge/query identity; safe input/IME shortcuts; first-run and returning-session routing; desktop and mobile layouts, including deep links.
- **Resilience:** ambiguous writes, pagination changes, retry limits, disconnect races, expiry/DST/month-end math, 90-day metadata purge with persistent assignments, recovery from free-tier pausing, encrypted annotation restore and quota checks.

Software completion requires all four stages verified and merged, followed by the independent architecture/repository review requested on October 11, 2026. Assess UI/domain/transport/persistence/job boundaries, transaction and race correctness, authorization/secrets, recovery, dependencies, coverage, Free quotas, accessibility, naming, duplication, dead code, formatting/linting, CI and operational instructions. Ticket concrete findings and fix them through the same reviewed PR gates; stop cleanup when no actionable findings remain rather than redesigning indefinitely.

After cleanup, rerun affected checks plus final end-to-end and deployed smoke verification, confirm the deployed revision corresponds to final merged code, and stop the temporary build-review automation. Record the URL, merged PRs/issues, actual test/live evidence, deployed revisions, operational limits and shutdown confirmation before marking the software goal complete.

Product acceptance additionally requires the user to perform the real phone flow in under a minute and the familiar-song tagging trial at roughly 3–5 seconds per song. Do not report emulation as those human checks or close overall MVP acceptance while they remain pending. The software-build goal may end after the preceding software gates with these human checks explicitly pending for the user's return.
