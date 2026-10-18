# spotify-plus

Personal tags for Spotify Liked Songs, with boolean queries that create disposable private playlists.

The application is available on its configured hosting. Actual phone timing, tagging speed, and Spotify profile/search hiding remain pending human product acceptance.

- [Everyday UX flows and software acceptance](docs/UX-FLOWS.md)
- [Architecture handbook, diagrams and request walkthrough](docs/architecture/README.md)
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
