# Sources and the shared song pool

Accepted October 21, 2026 in the Sources planning chat; tracked in [issue #72](https://github.com/CarterKFalkenberg/spotify-plus/issues/72). This specification extends the original Liked Songs scope. Implementation and live verification remain separate from this accepted plan.

## Product contract

Sources defines the shared song pool for the library, tag queue, query preview, generated playlists and queue listening. Liked Songs and accessible Spotify playlists start enabled, including newly discovered playlists. App-generated playlists start disabled but can be explicitly enabled. Saved choices survive rediscovery. Switches never modify Spotify or delete annotations; existing generated playlists remain snapshots.

The sidebar and mobile navigation open a searchable bounded Sources list with identity/artwork, enabled switch, song count, last successful sync and explicit pending/error/unavailable states. Select all/Deselect all apply across matching accessible sources, not just the visible page. The global count represents unique songs; per-source counts overlap. Skip local files and non-song items with counts. No enabled sources is an intentional empty state with a Sources action.

A song stays active while it belongs to any enabled source. Removing it from one playlist or unliking it removes only that membership after a verified sync. Losing the last enabled membership removes it from active browsing, tagging and future query results while retaining tags. Re-enabling or rediscovering it restores assignments. Incomplete scans and transient access failures cannot prove removal of confirmed membership. If a never-confirmed first import fails, its provisional songs leave the active pool while their tags survive; failed partial content must not become eligible for generation when the import gate opens. Metadata retention and disconnect purge still apply.

For already-active songs, playlist page ordering and addition-date changes do not reset acknowledgment or arrival identity. New tracks and actual pool reentry remain arrivals.

Newest added uses the latest known Spotify addition date among enabled memberships, with first discovery as the fallback when Spotify omits dates. The latest-sync queue mode uses arrivals in each enabled source’s most recent verified pass, excluding in-flight passes; an unchanged successful pass advances its checkpoint. Source selection changes invalidate affected selections, queries and current-song state; an ineligible song cannot continue queue playback or start stale generation.

## Song identity

The same Spotify track ID appears once even if repeated within/across sources. Different IDs group into one song when NFC/case/whitespace-normalized titles and complete artist identity match. Artist IDs take precedence when available, normalized names provide fallback. Meaningful qualifiers such as Live, Acoustic and Remix remain part of identity. No fuzzy or audio-derived matching.

Grouping is a heuristic, not proof of recording equivalence. Preserve underlying identities and original annotations. Union existing tags for the logical song; subsequent edits and changed-only Undo act consistently on it. Keep the representative while eligible/playable, otherwise choose a deterministic eligible replacement. Generated playlists contain one representative per matching song. Representative changes cannot lose tags or revive disabled memberships. When known title/artist metadata later diverges, split the known identities without losing existing tags; missing metadata alone is not evidence to split retained opaque links. Undo must preserve later component changes rather than recreate stale groups.

An annotation without an explicit song-group row is a singleton for both vocabulary-action snapshots and Undo comparisons. Creating its unchanged singleton row does not count as a component change; a new alias still fences Undo for the whole affected song.

## Sync and interfaces

Add source records and independent memberships, migrating the existing Liked Songs cache/annotations safely. Load cached data immediately. Durable leased jobs discover playlists and scan enabled sources in bounded pages with batched persistence and shared pacing/cooldown. Snapshot markers allow unchanged-source skips and before/after validation; they do not make offset pagination a snapshot. Disabled sources stop content scanning. Browsing/tagging remain available during import; generation waits for enabled sources' initial complete imports.

Discovery verifies two complete passes using ordered playlist IDs, per-playlist item counts and ownership/collaboration eligibility, plus page offsets, received counts and the overall playlist count. Names and artwork URLs refresh for display on every page but do not participate in that comparison: expiring artwork URLs and renames cannot keep an otherwise stable discovery pending indefinitely. In-flight pages from the older full-metadata signature require another matching pass after the additive migration.

Authenticated source endpoints:

- `GET /api/sources?search=&offset=&limit=`: bounded source page plus aggregate enabled count, unique track count, importing state and revision.
- `POST /api/sources/selection`: explicit source IDs and enabled boolean; atomic changes, unknown-ID validation and revision invalidation.
- `POST /api/sources/sync`: enqueue background work, never fetch all content in the request handler.
- `POST /api/sources/enable`: begin the optional collaborative-read consent upgrade.

Source selection accepts at most 10,000 explicit IDs in one transaction. Only this route permits a 256 KiB JSON body; the other existing routes retain their 16 KiB bound. Library status includes a source-selection revision so other clients invalidate affected frozen selections without treating normal song arrivals as a preference change.

Spotify currently documents playlist-content access only for owned/collaborative playlists. Persist discovered followed playlists and show actual access failures honestly; documentation is not proof of account access. Unavailable sources with no confirmed cache contribute no songs and do not permanently block generation. A failed read never deletes previously confirmed membership. Optional Sources consent adds playlist-read-collaborative through an explicit authenticated Enable action, preserving ordinary login/bootstrap and any verified optional playback permissions. Preserve the saved-library write guard.

If strict playlist metadata validation fails, the source worker rechecks selection and its lease before one bounded contents-access probe. Only an actual contents 403/404 establishes unavailable status; a successful or malformed probe retains the original response failure, while retry/reconnect failures keep their normal handling. The probe imports nothing and never proves a completed sync. Managed-playlist transport validation remains strict.

## Verification and delivery

Test overlap, repeated entries, different-ID grouping, meaningful suffixes, existing tag union/edit/Undo, representative replacement, removal/return, switches and stale workers, interrupted/changing scans, rate/access failures, partial-import generation gates, retention, backups and disconnect. Large synthetic fixtures establish bounded requests/writes/browser payloads. Verify light/dark desktop/mobile, keyboard and IME behavior.

Ship through independent Standards/Spec review, exact-head CI, reviewed merge, additive migrations and exact-merged deployment/live verification on configured Free targets. Synchronize product/technical docs, glossary and architecture guides/rendered diagrams with final code. Actual phone, tagging-speed and playlist profile/search hiding remain human acceptance.
