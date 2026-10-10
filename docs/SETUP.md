# Setup checklist

Do these steps in order. The repository already exists and the original working folder already tracks `main`. Planning files and setup helpers are in the separate `codex/planning-and-build-workflow` worktree. This checklist sets up the external services and one-time authorizations; it does not claim the application exists yet.

## 1. Ratify the product decisions

Read [PLAN.md](PLAN.md), especially the decisions table. The choices asked in chat are recorded in the template `.build/config.example.json`. Accept or change the one-month expiry, 90-day metadata archive, persistent annotations, returning home, name preservation, disconnect playlist policy, keyboard policy and budget. Keep the full MVP, deep links and snapshot playlists unless you explicitly change them.

## 2. Prepare the local machine

Use this planning worktree in Terminal:

```sh
cd /Users/carterfalkenberg/.codex/worktrees/planning-and-build-workflow/spotify-plus
```

Node 22 and the bundled Codex CLI are present on this machine. The application will target Node 24 LTS. GitHub CLI and Railway CLI were not found during planning. Use existing Homebrew to install the missing tools:

```sh
brew install node@24 gh
npm install -g @railway/cli
```

Ensure `node --version` shows Node 24 for the build; Homebrew may require adding its `node@24/bin` directory ahead of the existing Node 22 path. On this machine that is normally `/opt/homebrew/opt/node@24/bin`; use the path printed by Homebrew. Setup helpers themselves work with Node 22+.

Authenticate the CLIs:

```sh
codex login
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
railway login
```

If Codex is already authenticated, `codex login status` is sufficient. Codex CLI uses its own saved authentication; desktop sign-in is not assumed to imply CLI readiness. The build uses the configured default model. No OpenAI API key is required by the product or this local account-authenticated runner. Current CLI automation supports `codex exec`, structured output and explicit permissions. [OpenAI non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode).

GitHub CLI must be able to push branches and open draft PRs in `CarterKFalkenberg/spotify-plus`. The connected GitHub plugin remains useful in this chat, but it does not automatically authenticate `gh` in a separate CLI run. Browser authorization stores CLI credentials; do not paste tokens into chat. [GitHub CLI login](https://cli.github.com/manual/gh_auth_login), [Railway CLI authentication](https://docs.railway.com/cli).

Initialize the private local configuration now:

```sh
node scripts/init-local.mjs
```

This creates ignored `.local/config.json` and runtime keys, with private permissions. Existing files are preserved. You will fill the hosting fields in step 3 and Spotify/product fields in steps 4–6.

Install/start Docker Desktop (the `docker` executable is present; daemon readiness was not established). It provides a disposable local PostgreSQL database and isolation for integration tests. I will supply the compose configuration and install npm/browser dependencies during the first milestone. Do not create a local database manually. No Python, Redis, Supabase, Vercel, email service, LLM account or custom domain is needed.

## 3. Create the Railway project and reserve the public URL

1. Create a [Railway account](https://railway.com/) and select Hobby with billing enabled. Keep the workspace dedicated to this app if you want its spend limit to apply only to this app.
2. Create an empty project named `spotify-plus` with a `production` environment. Use one region near New York, with all three services in the same region.
3. Add the PostgreSQL service from Railway's database option. Keep its generated password. Name it `Postgres`.
4. Add two empty services named `web` and `worker`. They will be deployed with the CLI from the build branch. Do not link auto-deploys from `main` yet; main remains the stable tracking checkout.
5. On `web`, open Settings → Networking/Public Networking → Generate Domain. Use target port `3000` if requested. Save the HTTPS URL, without a trailing slash, as the future `appUrl`. If domain creation requires an initial deployment, use step 12 below after copying the IDs/token. A custom domain is optional.
6. `web` and `worker`: one replica each, sleep/serverless **off**, restart on failure. Initial resource caps: 512 MB web, 256 MB worker; adjust only if measured failures require it and remain within the chosen budget. Database: start small, roughly 512 MB if configurable.
7. For both app services add `DATABASE_URL` with Railway's reference value `${{Postgres.DATABASE_URL}}`. Runtime uses private networking. Do not copy the password into Git. [PostgreSQL](https://docs.railway.com/databases/postgresql), [variable references](https://docs.railway.com/variables).
8. Set a compute usage email alert at $15 and a hard ceiling at your ratified amount, e.g. $20. Review Railway's displayed billing calculation/minimum. The ceiling takes workloads offline when reached, including playlist cleanup; use $30 if uninterrupted availability is worth the margin. This is a spend control you choose, not a promise the bill will be $5. [Cost controls](https://docs.railway.com/pricing/cost-control).
9. Leave backups and PITR disabled during setup. The API-proof milestone will verify scoped backup listing/deletion, then enable daily backups. No weekly/monthly snapshots: they hold Spotify-derived data longer and complicate disconnect. [Backup behavior](https://docs.railway.com/volumes/backups).
10. Copy project ID, production environment ID, and web/worker service IDs from the dashboard; Cmd+K offers “Copy Project ID,” “Copy Service ID” and “Copy Environment ID.”
11. Project Settings → Tokens: create an environment-scoped project token for `production`, named `spotify-plus-builder`. Use the project token rather than an account/workspace-wide API token. Its value goes into the ignored local file below. This token will also support the app's narrowly implemented backup cleanup after an explicitly confirmed disconnect. [Railway token types](https://docs.railway.com/integrations/api).
12. Fill the Railway IDs/budget in `.local/config.json`; save the project token in `.local/railway-token` (only its value), then `chmod 600 .local/railway-token`. If you accept deploying to this project, set `authorization.deployToThisRailwayProject` to `true`. If step 5 could not generate a domain, run `node scripts/reserve-domain.mjs`. It deploys only a two-file setup stub to `web` and prints its URL. Set `appUrl` before proceeding to Spotify setup. This helper is supplied now; it does not require the application to have been built.

Link this folder interactively once:

```sh
railway link
```

Select this project, `production`, and `web`. The runner will give each build session the configured IDs and require it to link its separate worktree to the same project. It never needs unrelated projects.

## 4. Create the Spotify developer application

1. Sign in to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) with your Premium account and accept the developer terms.
2. Create an app named `Spotify Song Tagger`. Description: `Personal tags for my Liked Songs and private playlists that expire. Never changes my Liked Songs.`
3. Choose Web API. Leave Web Playback SDK, Android/iOS integrations and other API products unchecked. Keep Development Mode.
4. Register exactly `http://127.0.0.1:3000/auth/spotify/callback` for setup/local use.
5. Register `https://YOUR-RAILWAY-DOMAIN/auth/spotify/callback` for production, replacing the domain with the reserved URL. The callback must match the final URL exactly; no wildcard, `localhost`, or HTTP hosted callback. If needed, use the setup stub described in step 3 to obtain the domain before completing this registration. [Redirect requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
6. If asked for a Website, enter the same HTTPS origin. If asked for privacy policy/terms links, the build will serve `/privacy` and `/terms`; configure those URL paths as needed once deployed. Do not invent a published policy that does not exist yet.
7. Settings → Users Management → Add new user: enter your name and the **email associated with your Spotify account**. Do this even though you own the app; only this account belongs on the allowlist. [Allowlisting instructions](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
8. Copy the Client ID. **No client secret is needed** for the selected PKCE flow; do not expose or rotate one for this setup. OAuth scopes are requested by our helper/application, not configured as a list in this dashboard. The exact initial five scopes are in [SPOTIFY-API.md](SPOTIFY-API.md); cleanup scope necessity will be empirically tested.
9. Open your own Spotify profile → Share → Copy link. Take the ID after `/user/`, without query parameters. It is the bootstrap `spotifyExpectedUserId`, used once to ensure your browser did not authorize the wrong account. The helper will obtain `account_id` and the app will bind to that immutable value.

## 5. Put configuration and credentials in the right place

The ignored `.local/config.json` and `.local/runtime-keys.json` were initialized in step 2. You can rerun `node scripts/init-local.mjs` safely if needed; it never overwrites existing keys/configuration.

Edit `.local/config.json`: fill the Spotify Client ID/profile user ID, Railway project/environment/service IDs, HTTPS `appUrl`, and monthly budget. Set the `product` choices to your ratified values. Change the five `authorization` fields to `true` only when you approve the concrete scope in the next section. Supported alternative strings are shown in the build script and plan; the default file already has the recommended choices.

Confirm the Railway project token from step 3 is in `.local/railway-token`; the file contains only the token, with no quotes or variable assignment. Its permissions should be:

```sh
chmod 600 .local/railway-token
```

Do not paste this file's contents into chat or shell arguments. The runner reads it directly and passes it through the child process environment. If you prefer saved `railway login` auth, local operations can use that, but the backup-cleanup runtime still needs an environment-scoped project token.

Runtime secrets will be configured by the first build stage using stdin/native secret interfaces, without echoing values. You do **not** need to manually transfer them. The inventory is:

| Value | Source | Final destination |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | Developer Dashboard | web + worker variables |
| `SPOTIFY_OWNER_ACCOUNT_ID` | Verified bootstrap `/me` | web + worker configuration |
| `APP_URL`, redirect URI, timezone, retention settings | Local config | web + worker configuration |
| `SESSION_SECRET` | Generated runtime keys | sealed web variable |
| `TOKEN_ENCRYPTION_KEY` | Generated runtime keys | sealed web + worker variable |
| `ANNOTATION_KEY` | Generated runtime keys | sealed web + worker variable |
| `DATABASE_URL` | Railway service reference | web + worker |
| Refresh token + original authorization time | Bootstrap helper | encrypted authorization row in PostgreSQL |
| Backup cleanup project token + volume/environment IDs | Railway project token/verified database volume | sealed worker secret + scoped configuration |

The first stage must consume the bootstrap grant once, remove local raw bootstrap credentials after successful import, and leave a non-secret `.local/spotify-bootstrap-consumed.json` receipt for subsequent runner checks. It must not reset the authorization clock while importing. Keep runtime keys backed up in your password manager; losing the annotation key breaks restoration of old assignments, and losing the token key requires Spotify reconnect. Secret values remain out of Git and build logs. [Railway sealing](https://docs.railway.com/variables).

## 6. Approve the build's specific scope

The config authorizations mean:

- Ratified product defaults may be implemented without repeated design questions.
- Install dependencies/browser binaries, build containers, run local services/tests, and write within this repository and its worktrees.
- Create `codex/...` branches, commit/push them, and open/update a draft PR in this repository. Main merges remain your review step.
- Deploy web/worker, run additive migrations, configure secrets and inspect redacted logs in **this Railway project/environment**, within the budget. Verify backup cleanup with a disposable test backup before enabling it. Do not delete the project or perform destructive production migrations.
- Read your Spotify library and create/change/remove **disposable test playlists only**, named `Tagger API test ...` and tracked by ID. The production app may create/manage the playlists you explicitly generate in its UI. Tests never modify your Liked Songs, other playlists, or real tag assignments.

The command uses Codex's automatic approval reviewer in a workspace sandbox, with access to the specific worktree and ignored local configuration. It does not disable the sandbox or bypass denied actions. Permissions are human intent, not a guarantee that every platform/OS reviewer will allow every operation. A denial or new login requirement can still stop a run with a recorded action/reason. Managed app permission policy may override CLI flags. [OpenAI command/permission docs](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## 7. Complete the one browser authorization, then walk away

```sh
node scripts/connect-spotify.mjs
```

Open the printed Spotify authorization URL in your browser, ensure it is the intended account, and approve consent. The helper binds only `127.0.0.1:3000`, validates state, checks the expected user and immutable account ID, and writes the grant to `.local/spotify-bootstrap.json` with mode 600. It never requests songs or changes playlists. Keep port 3000 free while it runs. An invalid callback, allowlist/Premium issue, consent denial or wrong account prints the relevant fix without dumping the response/token.

Then:

```sh
./scripts/build --check
./scripts/build
```

The setup check inspects local configuration/authentication; it is not yet the real API proof. The build reuses a separate `.worktrees/build` checkout on `codex/build-mvp`, starts fresh Codex milestone sessions, verifies/deploys each, and continues until software readiness or a genuine blocker. Use `caffeinate -i ./scripts/build` if you want to prevent this Mac sleeping during the invocation. Power/network availability and Codex usage limits still matter. See [AUTONOMY.md](AUTONOMY.md).

## What still needs you

You must create/pay for accounts, accept terms, add allowlists/redirect URIs, complete Spotify/CLI browser sign-ins and any 2FA, and ratify scope. Those are personal authorizations, not work an agent can reliably complete for you. Domain reservation may require the one small callback update described above.

After the build, open the deployed URL on your actual phone and complete Spotify login there. Browser emulation does not establish the phone deep-link, keyboard, swipe or consent experience. Time one query → preview → real private playlist → open-in-Spotify flow; it must be under a minute. At a desk, tag 20–30 familiar songs using slots/bulk and judge whether the 3–5-second pace feels achievable. Confirm a deliberately disposable expired playlist disappears from your Spotify library, and check a renamed playlist stays renamed after Regenerate. The software will not be marked product-accepted until those checks pass.

Fault injection can prove reconnect handling now; we cannot wait six months to test the actual calendar deadline this session. Real absence of undocumented platform behaviors remains a live verification task, not something official docs alone settle. Complete grant revocation requires you to remove the app on Spotify's account Apps page after disconnect. No scheduled Codex automation has been created: this is an on-demand local build command.
