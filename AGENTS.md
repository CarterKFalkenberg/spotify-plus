# Spotify Plus

Read `docs/PRODUCT-BRIEF.md`, `docs/PLAN.md`, `docs/SPOTIFY-API.md`, and `docs/SETUP.md` before implementation. The original brief defines scope; recorded human decisions in `.local/config.json` refine it. Never infer human approval from an agent's output.

- The primary checkout stays clean on `main`, tracking `origin/main`. Work only in a separate worktree on `codex/...`. Do not merge, reset, or commit on main automatically.
- Complete each useful stage from `.build/tasks.json`, including deployment and live verification. An API proof is internal setup, not a library-browser release.
- One user. Spotify OAuth is login. No profile scopes, audio features, playback integration, AI features, or extra product scope.
- The Spotify adapter must reject every saved-library write except `DELETE /me/library` with validated `spotify:playlist:` URIs for app-managed playlists. Test this boundary. Never like or unlike tracks.
- Read current primary Spotify docs before choosing endpoint contracts. `account_id` is owner identity. `/items` and `/me/playlists` are the current playlist routes. Docs are not proof of a live response.
- Keep real Spotify content out of model context: no raw response dumps, names, library samples, real-data screenshots, committed fixtures, or uploaded metadata. Run live assertions in code; return only counts, statuses and schema booleans. Use synthetic fixtures for browser QA. This follows the brief's AI constraint and the current policy's broader ingestion wording.
- Credentials belong in ignored `.local/` files or Railway secrets. Never print them or put them in shell arguments, code, logs, tests, prompts, PRs, or browser bundles. A new worktree receives a symlink to `.local`, not copies of secrets.
- Read authorization flags before external actions. They authorize only this repository, Railway project/environment, dependency installation, feature-branch pushes/draft PRs, and disposable playlists named `Tagger API test ...`. User data purge tests run on isolated data; real deletion requires the product's explicit confirmation.
- Run `scripts/check` plus the current stage's `scripts/verify-stage.mjs`. Repair real failures; do not weaken assertions to advance a stage. Missing real credentials or permissions are blockers, not passing tests.
- Use durable SQL jobs with leases/retry timestamps; avoid Redis or additional services. Do not claim offset pagination provides snapshot consistency or cursor checkpoints make POST writes idempotent.
- Make updates additive and preserve user tags. No destructive production migrations without explicit authorization. Existing Spotify names and non-Tagger description text survive regeneration.
- Automatic approval review may still reject an action. Do not bypass the sandbox, change global permission settings, or treat a denied operation as success. Preserve work, identify the action/reason, and record the required user action.
- No subagents are requested for this project. Use one sequential build session per milestone.
- When final software checks pass, stop for the user's actual phone and tagging-speed acceptance. Software readiness and product acceptance are distinct.
