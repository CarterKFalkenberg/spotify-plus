# spotify-plus

Personal tags for Spotify Liked Songs, with boolean queries that create disposable private playlists.

The product is currently in planning/setup. No live account or deployment has been verified yet.

- [Product brief](docs/PRODUCT-BRIEF.md)
- [Build plan](docs/PLAN.md)
- [Accepted product decisions](docs/DECISIONS.md)
- [$0 hosting research and limits](docs/HOSTING.md)
- [Current Spotify API research](docs/SPOTIFY-API.md)
- [Complete setup checklist](docs/SETUP.md)
- [Autonomous build command](docs/AUTONOMY.md)

After setup, run `./scripts/build`. Use `./scripts/build --check` first, or `--status` to inspect progress. All application work happens on a separate worktree/branch; the primary folder stays on `main`.

Test the setup/runner code with `node --test tests/*.test.mjs`.

Start with the [before-goal checklist](docs/BEFORE-GOAL.md). Repository skills, review and autonomous PR merges are defined in [AGENTS.md](AGENTS.md) and [delivery rules](docs/agents/delivery.md).
