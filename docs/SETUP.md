# Setup checklist — $0 hosting

Updated October 11, 2026. The user's [product choices](DECISIONS.md) are accepted. Use **Supabase Free and Cloudflare Workers Free**. This replaces the Railway checklist. No application or external account has been created during planning.

## 1. Prepare the local machine

```sh
cd /Users/carterfalkenberg/.codex/worktrees/planning-and-build-workflow/spotify-plus
brew install node@24 gh deno supabase/tap/supabase
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm install -g wrangler
```

Use Homebrew's printed Node path if different. `node --version` should show 24; setup helpers also support 22+. Node builds the frontend, Deno checks backend functions, Supabase CLI handles the database/functions, and Wrangler deploys the frontend/proxy. Project dependencies will be pinned during the build. [Supabase CLI](https://supabase.com/docs/reference/cli/introduction), [Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/general/).

Authenticate:

```sh
codex login
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
```

If already signed in, `codex login status` is sufficient. The runner uses existing Codex account access and its configured model; no OpenAI API key is needed. GitHub CLI needs branch-push/draft-PR access to `CarterKFalkenberg/spotify-plus`. The GitHub plugin does not automatically authenticate `gh`. [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [GitHub login](https://cli.github.com/manual/gh_auth_login).

Start Docker Desktop for a disposable local Supabase stack and integration tests. Its executable is present; daemon readiness has not been established. No cloud Docker host or manually created local database is needed.

```sh
node scripts/init-local.mjs
```

This creates ignored `.local/config.json` and `.local/runtime-keys.json` with private permissions. Accepted decisions and budget `0` are already in the template. Existing files are preserved. If you previously initialized the Railway template, update hosting fields to match `.build/config.example.json` and remove the old `railway...` keys/authorization. Preserve keys and Spotify credentials; never overwrite secret files with a template. The runner rejects obsolete hosting configuration.

## 2. Create the Supabase Free project

1. Create/sign in to [Supabase](https://supabase.com/dashboard). Create a **Free organization**, then a `spotify-plus` project in it. If your current organization is paid, use a separate Free organization. A free project slot must be available.
2. Choose a region near New York, preferably US East. Generate a strong database password and save it in your password manager. Wait for provisioning to finish.
3. Project Settings → General: copy the project reference ID, also visible in its dashboard URL. Set `supabaseProjectRef` in `.local/config.json`. The API origin will be `https://PROJECT_REF.supabase.co`; no custom domain or IPv4 add-on is needed.
4. Save only the database password in `.local/supabase-db-password`: no variable name, quotes or extra lines.
5. Supabase account → Access Tokens: generate a personal access token named `spotify-plus-builder`. Save only its value in `.local/supabase-access-token`. It is a management credential, not an API key for the app. It may access more than this project, so build commands must explicitly select the configured project. Never deploy this token into the app.
6. Confirm organization Billing shows **Free**, without add-ons/trial. Keep pause/quota emails enabled. Do not upgrade if a free slot is unavailable; resolve the free-account limit first.
7. Do not configure the Supabase Auth Spotify provider. The app implements Spotify PKCE directly, with no second login. Never expose a database secret/service key to the frontend.
8. Leave PITR, paid backups, Realtime and image transformations off. The build configures migrations, `pg_cron`/`pg_net`, Vault and the private annotation-backup bucket with their permissions.

```sh
chmod 600 .local/supabase-access-token .local/supabase-db-password
```

No manual `supabase link` is needed now. The runner passes these values through `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`; the first milestone links its separate worktree. [CLI reference](https://supabase.com/docs/reference/cli/introduction).

## 3. Create the free frontend URL

1. Create/sign in to [Cloudflare](https://dash.cloudflare.com/), using an account on **Workers Free**. Do not buy a domain or upgrade Workers. An existing paid Workers account would defeat this project's $0 requirement.
2. Workers & Pages → Create application → create a Worker using the Hello World starter. Name it `spotify-plus`, or another available name, and deploy it. This placeholder obtains the callback URL before the real app exists.
3. If prompted, choose your free `workers.dev` subdomain. Copy the resulting HTTPS URL into `appUrl`, without a trailing slash: typically `https://spotify-plus.YOUR-SUBDOMAIN.workers.dev`.
4. Copy the account ID from the dashboard into `cloudflareAccountId`; set the exact `cloudflareWorkerName`.
5. Keep `workers.dev` reachable without Cloudflare Access login. Spotify is the only product login. This design needs no D1, KV, R2, Queues or Cloudflare scheduled jobs.
6. Run `wrangler login`, finish browser consent, then verify with `wrangler whoami`. The build uses saved CLI authentication and the configured account/Worker. No Global API Key is needed.

[Dashboard setup](https://developers.cloudflare.com/workers/get-started/dashboard/), [Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/).

## 4. Create the Spotify developer app

1. Sign in to the [Developer Dashboard](https://developer.spotify.com/dashboard) with your Premium account; accept its terms.
2. Create `Spotify Song Tagger`. Description: `Personal tags for my Liked Songs and private playlists that expire. Never changes my Liked Songs.`
3. Choose **Web API**, keep Development Mode, and leave Playback SDK/mobile integrations unchecked.
4. Register exactly `http://127.0.0.1:3000/auth/spotify/callback` for setup/local use.
5. Register your exact hosted `appUrl` followed by `/auth/spotify/callback`, e.g. `https://spotify-plus.YOUR-SUBDOMAIN.workers.dev/auth/spotify/callback`. No wildcard, `localhost`, or HTTP hosted callback. [Redirect requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
6. If asked for Website, enter the HTTPS origin. The build publishes `/privacy` and `/terms`; configure policy links when those pages exist. Do not describe the placeholder as an already-published policy.
7. Settings → Users Management → Add new user: your name and **Spotify account email**. Add yourself even though you own the app, and allowlist no one else. [Development mode](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
8. Set `spotifyClientId` from the dashboard. PKCE needs no client secret. The helper requests scopes; they are not selected in the dashboard. See [SPOTIFY-API.md](SPOTIFY-API.md).
9. Own Spotify profile → Share → Copy link: take the ID after `/user/`, without query parameters, as `spotifyExpectedUserId`. The helper checks the initial browser account; the app then binds to Spotify's immutable `account_id`.

## 5. Configuration and credentials

Check `.local/config.json`: Spotify identifiers, Supabase reference, Cloudflare account/Worker, HTTPS origin, both plans `free`, and budget exactly `0`. Your product answers are already accepted; `productDecisionsAccepted` is true.

| Value | Local source | Destination |
| --- | --- | --- |
| Identifiers, URL, decisions | `.local/config.json` | Non-secret runtime configuration |
| Supabase management token | `.local/supabase-access-token` | Build subprocess environment only |
| Database password | `.local/supabase-db-password` | CLI linking/migrations only |
| Cloudflare login | Wrangler saved authentication | Build CLI only |
| Session/token/annotation keys | Generated `.local/runtime-keys.json` | Supabase function secrets |
| Proxy/cron/backup encryption secrets | Generated by first milestone | Cloudflare proxy secret, Supabase secrets/Vault as appropriate |
| Spotify refresh grant | Bootstrap helper | Encrypted PostgreSQL row |
| Server database/storage credentials | Injected Supabase function environment | Backend only |

The build transfers secrets using a private ignored env file with `supabase secrets set --env-file ... --project-ref ...` and Wrangler stdin. No values in command arguments, Git, model output or browser bundles. [Supabase secrets](https://supabase.com/docs/guides/functions/secrets).

The first milestone imports the Spotify grant once, preserves its original authorization date, removes the local raw grant, and leaves a non-secret `.local/spotify-bootstrap-consumed.json` receipt. Back up runtime encryption/annotation keys in your password manager; losing them prevents recovery. Never paste secret files into chat.

## 6. Authorize the concrete build scope once

Set these remaining configuration flags to true when accepting the described actions:

- `installDependencies`: install dependencies/browser binaries, run local Supabase/test containers and checks, and write in this repository's worktrees.
- `pushFeatureBranchesAndCreateDraftPR`: commit/push `codex/...` branches and open/update a draft PR in this repository. You review the merge.
- `deployToConfiguredFreeHosting`: deploy to only the configured Supabase project and Cloudflare account/Worker; configure secrets, additive migrations, cron and a private backup bucket; verify restore using isolated synthetic data. **No paid plan, add-on or purchased domain**, even if a quota is exceeded. No project deletion or destructive production migration.
- `createAndRemoveDisposableTestPlaylists`: read your library and create/change/remove tracked playlists named `Tagger API test ...`. Never alter Liked Songs, unrelated playlists or real tag assignments. Production playlist changes follow your explicit UI actions.

These authorize operations without bypassing automatic approval review or provider logins. A denied action or expired credential can still stop a run with preserved progress and a recorded fix. [Codex permissions](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## 7. Connect and build

```sh
node scripts/connect-spotify.mjs
```

Open the printed URL, verify the Spotify account and consent. Keep port 3000 free. The helper validates state/account/scopes and saves `.local/spotify-bootstrap.json` with mode 600. It reads only account identity and makes no playlist changes.

```sh
./scripts/build --check
./scripts/build
```

Use `caffeinate -i ./scripts/build` to keep the Mac awake. The separate `codex/build-mvp` worktree progresses through verified milestones. Preflight checks configuration/access; the first live milestone proves actual free plans, quotas, API behavior and scheduled execution. See [AUTONOMY.md](AUTONOMY.md).

## Free-tier operation and remaining human checks

Supabase can pause a Free project after low activity. Daily sync and cleanup are useful activity, but cron does not guarantee exemption. Keep pause emails enabled. If paused, dashboard → project → Resume; reconnect if Spotify authorization has expired. Cleanup catches up after recovery. See [HOSTING.md](HOSTING.md) for quotas and backup limitations.

You must create accounts, accept terms, supply credentials, and complete browser logins/2FA and Spotify consent. Hosting needs no paid account; your existing Spotify Premium and Codex access are assumed.

After the build, use your phone to time query → preview → private playlist → Open in Spotify: under one minute. At a desk, tag 20–30 familiar songs and judge the 3–5-second pace. Confirm a disposable playlist expires with the browser closed, and a Spotify rename survives Regenerate. Emulation cannot replace these checks. Actual six-month expiry cannot be observed this session; reconnect behavior can be fault-tested. Fully revoke the grant through Spotify's account Apps page after disconnect.
