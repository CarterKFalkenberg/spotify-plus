# Local readiness — October 11, 2026

The local portion of setup step 4 is complete. Account provisioning, provider login and real deployment remain later steps; these checks used synthetic data and created no cloud resources or Spotify playlists.

## Select this project's tools

Run in every new build shell before the setup helpers, tests, Wrangler or the optional runner:

```sh
source /Users/carterfalkenberg/.local/share/spotify-plus/tooling/env.sh
```

The environment adds the project-specific Node and npm-tool directories to PATH. It leaves the machine's existing Node 22 installation and shell defaults intact. Agents must source it in their execution command as well; a previous shell's export does not persist into a later tool call.

Node 24.21.0 was installed from the official `nodejs.org` macOS ARM64 archive after verifying its SHA-256 against the release's SHASUMS256.txt. Homebrew's Node installation hit a repeatable dependency-lock error; no locks were deleted and no unrelated processes were terminated. Wrangler 4.149.0 is installed under the same project tools directory. These machine-local files are outside Git; CI selects Node 24 independently, and application dependencies will be pinned during implementation.

## Observed checks

| Capability | Result |
| --- | --- |
| Node / npm | Node 24.21.0 runs; npm package downloads and installs succeed. |
| Deno | 2.9.7 executes a JavaScript smoke check. |
| Supabase CLI | 2.120.0 executable responds. |
| Wrangler | 4.149.0 bundles a synthetic Worker with `deploy --dry-run`; nothing uploaded. |
| Docker | Desktop started; engine 28.4.0 pulled and ran ARM64 `hello-world`, removing the container afterward. |
| Browser tests | Playwright 1.64.0 launched Chromium desktop and WebKit with iPhone emulation; both loaded a local HTTP page and passed input/click assertions. |
| Git/worktrees | Feature-branch writes, commits, pushes, reviewed PR merge and clean main fast-forward demonstrated by bootstrap PR #1. |
| GitHub / Codex | GitHub CLI has repository admin, repo/workflow scopes and Git credentials configured; Codex CLI reports logged in using ChatGPT. |

Playwright and its readiness harness are installed under the project tools directory; browser binaries use the normal Playwright cache. A different application-pinned Playwright version may require its matching browser download. Emulation is not personal phone acceptance.

The session's current execution policy allowed these operations without permission prompts. This does not guarantee future sessions have the same policy, credentials remain valid, or account usage remains available. The complete Supabase local stack and application integration tests will run after scaffolding; the Docker smoke check does not prove them. Provider permissions are checked after the free accounts are configured.

## Supabase access verification — October 11, 2026

Supabase setup is verified: the configured project is healthy, its organization is on Free with the spend cap enabled, and the project-scoped token can read project/function/secret-management/storage configuration and execute a read-only SQL query. CLI linking succeeded in an isolated temporary directory. A separate TLS PostgreSQL connection verified the saved database password with `SELECT 1`; `pg_cron` and `pg_net` are available to install during the build.

Credential files are owner-only, ignored and untracked. These checks created no tables, migrations, functions or cloud resources. Actual function deployment, storage writes, scheduler execution and application tests remain the first build milestone. No additional Supabase credential or MCP connection is needed now; refresh the short-lived token if it expires before the build.
