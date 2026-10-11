# Spotify Plus

Read `docs/PRODUCT-BRIEF.md`, `docs/DECISIONS.md`, `docs/PLAN.md`, `docs/HOSTING.md`, `docs/SPOTIFY-API.md`, and `docs/SETUP.md` before implementation. The original brief and accepted human decisions define scope; `.local/config.json` supplies targets and action authorizations. Never infer human approval from an agent's output.

- Work only in a separate worktree on `codex/...`. All repository changes ship through PRs. The user authorized autonomous review and merge after checks pass; follow `docs/agents/delivery.md`. Never commit or push directly to main. Fast-forward the primary main checkout when clean; preserve unrelated edits.
- Complete each useful stage from `.build/tasks.json`, including the common gates in `docs/agents/acceptance.md`, deployment and live verification. An API proof is internal setup, not a library-browser release. The milestone list does not narrow the original MVP requirements.
- One user. Spotify OAuth is login. No profile scopes, audio features, playback integration, AI features, or extra product scope.
- The Spotify adapter must reject every saved-library write except `DELETE /me/library` with validated `spotify:playlist:` URIs for app-managed playlists. Test this boundary. Never like or unlike tracks.
- Read current primary Spotify docs before choosing endpoint contracts. `account_id` is owner identity. `/items` and `/me/playlists` are the current playlist routes. Docs are not proof of a live response.
- Keep real Spotify content out of model context: no raw response dumps, names, library samples, real-data screenshots, committed fixtures, or uploaded metadata. Run live assertions in code; return only counts, statuses and schema booleans. Use synthetic fixtures for browser QA. This follows the brief's AI constraint and the current policy's broader ingestion wording.
- Hosting costs must remain $0/month. Use Supabase Free and Cloudflare Workers Free only. Verify actual plans/usage before deployment; no paid upgrades, trial conversions, purchased domains or add-ons. A quota failure is a blocker or optimization task, never spending permission.
- Credentials belong in ignored `.local/` files, Supabase function secrets/Vault, or the Cloudflare proxy secret. Never print them or put them in shell arguments, code, logs, tests, prompts, PRs, or browser bundles. A new worktree receives a symlink to `.local`, not copies of secrets. Management credentials stay out of the runtime.
- Read authorization flags before external actions. Repository setup, issues, feature pushes, PR review and merges are already authorized for this repository. Hosting/dependency/disposable-playlist permissions remain separately scoped in config. User data purge tests use isolated data; real deletion requires the product's explicit confirmation.
- Run `scripts/check` plus the current stage's `scripts/verify-stage.mjs`. Repair real failures; do not weaken assertions to advance a stage. Missing real credentials or permissions are blockers, not passing tests.
- Use durable SQL jobs with leases/retry timestamps, invoked through pg_cron/pg_net and bounded Supabase functions. Do not rely on a permanent process or self-invocation chain. Do not claim cron prevents free-project pausing, offset pagination is a snapshot, or checkpoints make POST writes idempotent.
- Make updates additive and preserve user tags. No destructive production migrations without explicit authorization. Existing Spotify names and non-Tagger description text survive regeneration.
- Automatic approval review may still reject an action. Do not bypass the sandbox, change global permission settings, or treat a denied operation as success. Preserve work, identify the action/reason, and record the required user action.
- Use the native goal with bounded delegated tasks, explicit ownership and one isolated worktree/branch per implementation task. The user's October 11, 2026 instruction supersedes the earlier one-session-per-milestone and restricted-team convention. Define interfaces/dependencies before parallel work; never edit another agent's active checkout.
- Implementation and per-PR Standards/Spec reviewers use `gpt-6-astra`; the main orchestrator and scheduled reviewer use `gpt-6.1-sol`. The orchestrator owns integration, verification, merges, shared migration ordering, deployments and Spotify mutations. Agent reports are evidence to inspect, never proof of acceptance or human approval.
- Keep durable coordination in GitHub issues and `.local/build-coordination/state.json`; the independent scheduled reviewer owns `.local/build-review/ledger.json`. Follow `docs/AUTONOMY.md` for review automation and shutdown. Do not run the optional unattended shell runner alongside the native goal; `scripts/build --check` is permitted.
- When final software checks pass, stop for the user's actual phone and tagging-speed acceptance. Software readiness and product acceptance are distinct.

## Agent skills

- Skills are installed in `.agents/skills`. Read `docs/agents/skills.md` for exact entrypoints and dependencies, and `docs/agents/delivery.md` for autonomy boundaries. Open each applicable SKILL.md before following it; a mention in this file is not a substitute for its instructions.
- Planning: the user waived the remaining pre-build planning-readiness interview on October 11, 2026. Preserve accepted decisions and proceed; do not restart grilling or invent human answers. Use `grill-with-docs` or `wayfinder` only when further planning is actually requested.
- Every PR: use `code-review` against the recorded base and current head with the originating spec, fix actionable findings, then use `pr-writing` for the final title/body. The native orchestrator independently verifies and merges the exact tested head; the optional CLI launcher performs equivalent gates when it is the sole orchestrator. Periodic review never replaces per-PR review.
- Issue tracker: GitHub Issues in this repository; see `docs/agents/issue-tracker.md`.
- Domain docs: single context with lazy `GLOSSARY.md` and `docs/adr/`; see `docs/agents/domain.md`.

## Implementation standards

- Use the smallest implementation that meets the accepted scope. Keep Spotify transport, domain behavior and UI concerns separate where they change independently; do not introduce an agent framework, generic provider layer or future-feature abstraction.
- Validate external inputs at boundaries. Keep durable state transitions and changed-only undo transactional; never use client state as authorization or treat an ambiguous remote write as confirmed success.
- Test behavior and failure recovery with synthetic data. Prefer meaningful invariants over tests that mirror implementation details. Keep live verification redacted and separate from CI.
- Update the relevant spec or decision when behavior intentionally changes. For an accepted product change, cite the user's decision; for a technical choice, record its rationale when it would otherwise surprise a future maintainer.
