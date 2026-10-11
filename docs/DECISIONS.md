# Accepted product decisions

The user confirmed these choices in chat on October 11, 2026:

- Default playlist retention: one calendar month, with the original 1 week / 1 month / 3 months / pinned picker.
- Purge removed-track cached metadata after 90 days.
- Tag assignments and the minimal identifier needed to restore them persist until “delete everything.”
- Returning desktop sessions open the queue; show the bulk-backlog shortcut above 100 untagged songs. First run opens groups by size.
- Regenerate preserves the playlist's current Spotify name.
- Disconnect deletes app data and credentials and keeps existing Spotify playlists. Cleanup stops after disconnect.
- Modified letter shortcuts while the tag input is focused; retain the specified number slots and empty-input arrow behavior.
- Keep the MVP as written, including deep links and snapshot playlists.
- Hosting must cost **$0/month**. Supabase was suggested for consideration; the implementation choice is Supabase Free plus Cloudflare Workers Free.

These answers settle product choices and the budget. They do not supply service credentials or consent to Spotify account writes. Setup retains separate, concrete deployment/repository/test-playlist authorization fields. `productDecisionsAccepted` is already true in the template; do not ask the user to ratify these same choices again. Final real-device product acceptance still happens after implementation.

## Repository and AI workflow — October 11, 2026

The user requested all work in worktrees/branches, all repository changes through PRs, and autonomous merges without per-PR human approval. Main remains a clean tracking checkout. Install Matt Pocock’s current `grill-with-docs`, `wayfinder` and `code-review` skills and their direct skill dependencies; add a project PR-writing skill. Preserve accepted product decisions when using the planning skills. The user accepts the documented $0 hosting trade-offs. See `agents/delivery.md` for the concrete workflow and `BEFORE-GOAL.md` for remaining setup.
