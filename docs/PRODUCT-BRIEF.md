# Spotify Song Tagger — Product Brief

Amendment: the October 11, 2026 [accepted publication decision](DECISIONS.md#playlist-publication-requirement--october-11-2026) resolves “private playlist” below as hidden from profile/search, without link-access restrictions. The October 21 [queue-listening decision](DECISIONS.md#queue-listening-in-the-webpage--october-21-2026) additionally authorizes optional in-webpage SDK listening for tagging. The original brief is retained below.

I'm starting this project fresh. This document is the complete product intent; everything about how it gets built is yours to decide.

## What it is

A personal, single-user web app for tagging my own Spotify Liked Songs with free-form tags, and generating real Spotify playlists from boolean tag queries — where the generated playlists clean themselves up automatically after a retention window I choose.

The problem: Spotify gives me one undifferentiated pile of ~3,000 liked songs and no way to say "the chill instrumental stuff I drive to." I want to annotate my library once, then spin up disposable playlists on demand without accumulating permanent playlist clutter.

I am the only user, forever. There is no signup, no multi-tenancy, no sharing. "Log in" and "connect my Spotify account" are the same action.

**Device split that matters:** tagging is a desk/keyboard activity; playlist generation happens on my phone, usually right before I want to listen to something.

## The core loop

Five stages. Remove any one and the payoff breaks — a tagger with no playlists is data entry; playlists with no expiry leak the exact clutter the app exists to prevent. So all five are in the MVP, each in its plainest defensible form.

1. **Connect** — OAuth against my Spotify account.
2. **Ingest** — sync my Liked Songs into the app's own store (track metadata + when I liked it).
3. **Tag** — apply free-form tags to tracks, fast.
4. **Generate** — build a boolean tag query, preview the matches, create a real private Spotify playlist from it.
5. **Expire** — generated playlists are deleted from Spotify automatically when their retention window elapses, unless I pin or extend them.

## MVP scope

### Auth & session
- Spotify OAuth. The app is registered to exactly one Spotify account; if a different account authorizes, reject it with a clear message rather than silently creating a second user.
- Spotify's refresh tokens expire 6 months after the original authorization and cannot be extended by refreshing. This is a scheduled event, not an edge case: warn me as the deadline approaches, and when a refresh fails, park the app in a clear "reconnect Spotify" state that resumes cleanly afterward.
- Distinct error screens for the real failure modes (consent denied; wrong Spotify account; account not allowlisted in the Spotify developer dashboard) — each naming the actual fix. Spotify's own errors here are unhelpful.

### Library sync
- First auth kicks off the initial import automatically — no "start import" button to forget. Show deterministic progress ("1,240 of 3,187 imported"); the first page of the API response includes the total.
- Import must be resumable and survive me closing the tab. It should also make progress unattended so an abandoned first run finishes eventually.
- Ongoing sync is ambient: on app open (debounced), cheaply probe whether anything changed; if so, re-walk. Plus a manual "Sync now" for the "I just liked three songs on my phone, show me them" moment, and an unattended backstop so the library is never more than ~a day stale.
- **Spotify is the source of truth for library membership; the app is the source of truth for tags.** There are no merge conflicts by construction.
- **Removals are soft.** When I unlike a song, it disappears from the library, the tagging queue, and playlist results — but its tags are never cascaded or deleted. A low-prominence "Removed from Spotify" archive view shows those tracks with their tags and explains that re-liking restores them. No notification, no inbox, no decision demanded of me.
- New additions surface as a quiet count badge ("12 new") that opens the tagging queue filtered to them. That badge is the entire notification system — no email, no push, no interstitials.
- **During the initial import:** browsing and tagging are available immediately (tags attach to tracks that exist; more arriving invalidates nothing). Playlist *generation* is gated until the first complete sync, because a query over a half-ingested library produces a silently wrong playlist — the worst possible failure mode, since I can't tell a 40-song result from a should-have-been-90-song one.
- Handle the empty-library case as its own state, not a 0/0 progress bar.
- Handle the mid-import mutation case: if I like a song on my phone while the import is paginating, pagination can skip or duplicate. Make writes idempotent, and re-verify completeness after the walk before declaring first sync done.

### Tagging — the make-or-break flow
The economics of the whole product live here. At ~20 seconds per song, a 3,000-song backlog is 16 hours and the app dies. At ~3-5 seconds per song plus bulk moves, it's a few evenings and then a two-minute daily habit. Design for the latter.

Two surfaces, each doing what the other is bad at:

**A focused queue (desktop, the daily loop).** One song at a time, filling the surface: large album art, title, artist, album, year, duration, its current tags, and a tag input that always has focus. Keyboard-driven end to end:
- type + Enter → autocomplete and apply a tag; input clears, focus stays
- number keys → apply a "quick slot" tag (a visible row of ~9 chips bound to 1-9, auto-populated from my most-used tags, pinnable for a session — "tonight 1=low energy, 2=mid, 3=high"). This is the single biggest accelerator: most songs become `2`, `7`, `→`, about one second.
- arrows → next/previous song. Advancing commits nothing; every tag mutation saves immediately. There is nothing to lose by wandering off mid-song.
- keys for: skip (re-queue, stay untagged), undo last action, remove last-applied tag, open the song in Spotify, jump to the browser filtered to this artist, hotkey help overlay.
- Letter hotkeys must only fire when the input is empty — typing `sad` must type, not trigger `s`-for-skip. Easy to implement wrong; test it.
- Default queue: untagged, **newest-liked first** — those are the songs I can tag from memory without listening, which maximizes tags-per-minute. Switchable to oldest-first, new-since-last-sync, random, or "send this filter to the queue" from the browser.
- Header shows a **count-up** ("31 tagged this session", "214 songs tagged"), never a percentage or "0 of 3,187." The goal is not 100%; playlists work fine over a partially tagged library.

**A library browser/table (bulk).** Art, title, artist, album, year, tags, date added; sortable; free-text search; filters including **untagged as a first-class filter**; artist/album/decade facets. Multi-select with shift-click ranges and — the workhorse — "select all N matching this filter." Sticky action bar: add tags, remove tags, send to queue.

**Group-by is the backlog killer.** Group rows by artist (or album, or decade) with per-group tag actions: "Khruangbin · 43 songs · 0 tagged → tag all 43." One decision covers dozens of songs.

**First-run experience answers "how does a 100% untagged library not feel hopeless?"** Lead the first run with the bulk/group-by view sorted by group size, not the one-at-a-time queue (2,000 × 10s of serial decisions is a dead app). Include a short dismissible explainer establishing: (1) you never need to finish — untagged is a filter, not an error; (2) bulk-tag your biggest artists first; (3) new songs queue up automatically from now on, so the backlog only shrinks. The queue becomes the default entry point after that.

**Bulk semantics must be exactly right** — this is where silent data-mangling bugs live. Applying a tag that part of the selection already has is idempotent. The picker shows tri-state chips (all / some / none of selection); one action moves *some → all*, a second, explicit action clears. Report as an undoable toast: "Added `funk` to 43 songs · Undo."

**Audio during tagging:** MVP is deep links only — a hotkey opens the current track in the Spotify client, I listen there, I tag here. In-app or remote-controlled playback is the designated fast-follow, not MVP.

**Mobile tagging is a deliberate lite mode**, not a shrunken clone: the "12 new" badge → a card list → tap a song for a sheet with quick-slot chips, the autocomplete input, and open-in-Spotify. Swipe to advance. No bulk, no group-by, no hotkeys. The correct mobile experience is clearing the new-arrivals inbox in under a minute.

### Tag vocabulary
- **Tags are flat strings. No hierarchy, ever** — not in the UI, not in the data model. For a vocabulary of one, tags are personal shorthand, not an ontology. Prefix conventions (`mood:chill`, `sit:driving`) get passive support (autocomplete groups shared prefixes) and nothing more. The "Any of" query bucket already covers ~90% of what hierarchy queries actually do.
- Anything goes as a tag: genre, mood, situation, tempo, energy, an inside joke. Emoji, accents, `&`, `/` all fine. No stemming or singularization — `driving` and `drive` are different tags, and guessing otherwise is how tag systems get uncanny.
- **Sprawl prevention belongs at the input, not in cleanup.** Case-insensitive identity with whitespace normalization; display casing preserved as first typed. Autocomplete aggressively surfaces near-matches with usage counts (`chill · 84`) so the established tag is visually authoritative, and "create new tag" is always the last, visually distinct row — never the default Enter target when an existing tag matches.
- **Tag management ships in the MVP, not later.** Rename, merge, delete, usage counts, last-used, and a subtle "unused tags" section for gardening. Free-form tagging without merge is a trap that poisons the vocabulary during exactly the highest-volume period. Rename is global and instant. Merge unions assignments and states its impact before committing ("`chillout` (12) + `chil` (3) → `chill` (84) — 99 songs will carry `chill`"). Renaming onto an existing name offers merge instead. Delete confirms with a count and is undoable for the session.
- Rename and merge must not break previously stored playlist queries. Tag identity is not its name.

### Playlist generation (mobile-first)
- **Query builder: three buckets** — *All of* (AND), *Any of* (OR), *None of* (NOT). Tap-to-add tag chips, same autocomplete as tagging. This composes `A AND B AND (C OR D) AND NOT (E OR F)`, which covers the overwhelming majority of real queries ("chill AND (drive OR roadtrip) NOT sad" fits exactly).
- The *stored query representation* should support arbitrary AND/OR/NOT nesting even though the MVP UI only emits this constrained shape. Nothing downstream should know the UI was limited. Later, a free-form builder or a natural-language input becomes just another producer of the same query — that's the only forward-compatibility I care about here.
- **Preview before create is non-negotiable.** A debounced match count ("87 songs · 5h 12m") above a scrollable preview list, updating live as chips change. The count is the primary feedback loop for building a query, and it catches both failure modes: 0 matches (say "no songs have all of these tags" prominently, don't just render an empty region) and 1,900 matches (I see the monster before I create it). Preview must cost zero Spotify requests.
- **Create screen:** name (pre-filled from the query, editable), retention picker (1 week / 1 month / 3 months / **Pinned — never expires**, defaulting to a setting), Create. Playlists are created **private**.
- Write the query *and* the expiry date into the Spotify playlist description — e.g. "Created by Tagger from: chill + (drive OR roadtrip) − sad · expires Sep 1, 2026." Cheap, and it's how I see this information inside the official Spotify client where I actually encounter the playlist.
- **Membership is a snapshot at creation.** Tag edits afterward don't touch an existing playlist. These are disposable artifacts, not maintained views. There is a manual **Regenerate** action that re-runs the stored query, replaces the contents of the same Spotify playlist in place, and resets the expiry clock.
- Handle partial failure: playlist created but a chunk of track-adds fails → retry with backoff; if it still fails, keep the record in an "incomplete — retry" state rather than orphaning a half-filled playlist the app has forgotten about. Track position so retries are idempotent.

### Expiry & cleanup
- A playlists list is the cleanup UX centerpiece. Each row: name, track count, created date, the stored query rendered as chips, and **"expires in 12 days"** (or "Pinned"). Actions: **Open in Spotify** (the primary action — I listen in Spotify, not here), **Extend** (reset the clock), **Pin/Unpin**, **Regenerate**, **Delete now**.
- Expired playlists get deleted from Spotify by an unattended cleanup pass. Because that pass runs periodically rather than to the minute, **the UI promises dates, never times**, and shows "expired — will be removed" in the gap.
- Surprise deletion of something I've grown attached to is the one way this feature reads as a bug. Retention is always chosen or defaulted visibly at creation, counted down in the app, and disclosed in the Spotify description. Pin is the sanctioned "I've grown attached to this one."
- Reconcile against reality: if I delete a generated playlist inside Spotify myself, the app should notice and drop the row rather than erroring forever. If I manually edit a generated playlist's tracks in Spotify, those edits are invisible to the app and will be overwritten by Regenerate or destroyed by expiry — the description line is the disclosure.

### Disconnect / delete everything
A single action that revokes access and deletes all Spotify-derived data. This is both a Terms obligation (5 days to delete on disconnect) and — more practically for me — the nuke-and-resync escape hatch I'll want the first time a sync goes wrong. Build it early, while the data model is young.

## Hard constraints (Spotify platform reality)

These were verified in August 2026 and shaped the whole product. **Re-verify the ones marked ⚠ against live docs and against real API responses during the build — several contradict what older tutorials and training data assume.**

- The app lives in Spotify's **development mode permanently**. Extended quota requires a registered business with 250,000+ MAU; individuals cannot apply. Dev mode is capped at **5 users**, which makes a public version structurally impossible — fine, since there's one user.
- ⚠ **The app owner must hold an active Spotify Premium subscription** for a dev-mode app to function (Feb 2026 change). I have Premium.
- Users must be allowlisted by name + Spotify email in the developer dashboard, or they get 403s.
- ⚠ **Audio features, audio analysis, recommendations, and related-artists are permanently gone** for apps created after Nov 2024. There is no replacement. **No part of this design may assume danceability/energy/valence/tempo exist.** The obvious auto-tagging input does not exist for this app and will not.
- ⚠ **30-second preview URLs are gone** for new apps. That's why MVP audio is deep links.
- ⚠ Fields stripped from dev-mode responses (Feb 2026) include track `popularity`, `external_ids` (so **no ISRC** — there is no clean join key to third-party metadata sources), `available_markets`, album `label`, and user `email`/`country`/`product`. What survives per track is ample for tagging: id, uri, name, artists, album name + images + release date, duration, explicit.
- ⚠ Do **not** request profile scopes (`user-read-private`/`user-read-email`) — the fields they gate were removed anyway, so they buy nothing but a scarier consent screen.
- ⚠ **There is no webhook, delta, or change-feed mechanism of any kind** for the library, and no ETag/snapshot for it. Sync is re-pagination. At this scale that's cheap: a 3,000-track library is ~60 requests, a few seconds. There is no engineering pressure to be clever here — and incremental-only sync *cannot detect removals*, so a full re-walk is the correctness backstop.
- ⚠ The library endpoint's result ordering is **not documented**. Long-observed behavior is newest-liked first. Verify empirically and treat it as an optimization hint only — never build correctness on it.
- ⚠ Spotify has **no true "delete playlist"** operation — unfollowing your own playlist is how deletion works, and that is how the official clients do it. The current path for this is the library-removal endpoint (which costs an extra scope); the classic unfollow endpoint still exists but is marked deprecated. **Verify at build time that removing an owned playlist this way actually deletes it** before any UI copy says "deleted."
- Rate limits are undocumented, computed per-app over a rolling 30-second window. Community reports suggest sustained hammering can earn ~24-hour lockouts. A modest client-side throttle plus honoring `Retry-After` on 429s makes this a non-issue.
- Redirect URIs must be HTTPS except for loopback, and **`localhost` is banned as a hostname** — use the explicit loopback literal.
- Chunk limits exist on the write endpoints (adding playlist items, library removals, saved-track containment checks) — look them up rather than assuming.
- ⚠ **Never train or fine-tune any model on Spotify-sourced data.** This is unambiguous in Spotify's policy and is settled and permanent for this project. Whether sending Spotify-sourced strings (artist/track names) to an LLM at *inference* time is permissible is a genuine gray area that I'll decide if and when auto-tagging is ever scheduled — the MVP needs nothing here.
- Storage posture: cache only the metadata fields the product actually uses, never raw response dumps, and don't keep removed-from-library track metadata indefinitely. **My tags are my own data and are not subject to those restrictions** — they're the valuable permanent thing; Spotify-sourced metadata is a re-syncable cache.
- Link each track back to its Spotify page (which I want anyway for play-this-song), and show cover art from Spotify's URLs rather than re-hosting copies.

## Explicitly out of scope — will not build

- **The app never writes to my Liked Songs.** No like/unlike UI will ever exist. Library-write access is held *only* for the playlist-deletion path. The landing copy makes this promise to me, and nothing else may ever call a library-write endpoint. This is what makes the scary-sounding scope defensible.
- No tag hierarchy machinery, in any form.
- No multi-user product surface — no invites, sharing, or permission UI.
- No anything derived from audio features. They don't exist for this app.
- No social, discovery, or recommendation features. The app organizes a library I already curate; Spotify does discovery.
- No in-app music player as a product goal. Playback integration, if it ever lands, exists only in service of tagging — this never becomes an alternative Spotify client.
- No tag colors, emoji, descriptions, weights, or confidence scores. No tagging streaks or achievements — the count-up stat is the entire motivation system.
- No live/auto-updating "smart" playlists in the MVP.
- No natural-language playlist requests and no auto-tagging in the MVP. If either ever happens, NL arrives as another producer of the same stored query (landing in the same preview-before-create screen, which is the natural human checkpoint on model output), and auto-tagging arrives as a producer of *suggestions* that appear as pre-highlighted chips in the queue awaiting explicit acceptance. Neither needs anything built now.
- No heuristic auto-tags (decade, duration, explicit) even though they'd be cheap: their output is derivable at query time anyway, and fake tags pollute a vocabulary that's supposed to be mine. If I want decade filtering in playlists, the honest shape is a metadata facet in the query builder, not invented tags.

## Deferred, in rough priority order

Not MVP, but real candidates. Each has a trigger:
1. **In-app or remote-controlled audio during tagging** (controlling my already-running Spotify client is the better-looking option than in-browser playback, and much lighter; ⚠ verify those player endpoints actually work for a post-Feb-2026 dev-mode app — the migration guide is silent on them). *Promoted the first week that backlog tagging stalls on "I can't remember this one."*
2. **Advanced query mode** — arbitrary nesting, i.e. `(chill AND jazz) OR (upbeat AND electronic)`, which the three-bucket UI genuinely cannot express. Workarounds today: two playlists, or a broader query. State the limitation rather than hiding it. *Promoted when the three-bucket shape demonstrably pinches on a real query.*
3. **Saved queries** — re-run a favorite without rebuilding it.
4. **Live/smart playlists** — auto-regenerate on tag change. *Promoted only if Regenerate becomes a reflex.*
5. **Saved quick-slot layouts** ("energy pass", "mood pass") — MVP ships auto-populated slots plus session pinning only.
6. **Tag export** (JSON of my tags keyed by track + artist + title).
7. **Library/tagging stats** — tag co-occurrence, coverage over time.
8. **Offline/installable shell** for the mobile triage flow, only if the phone flow feels sluggish in practice.

## Open product decisions — ask me during planning

1. **Retention defaults.** Proposed: 1 month default playlist expiry (with the 1w/1m/3m/pinned picker), and hard-deleting the cached metadata of removed-from-library tracks after ~90 days. Your call to propose final numbers; mine to ratify.
2. **Do my tag assignments survive the hard-delete of a removed track's cached metadata?** I want "tags persist" to mean *persist* — if I re-like a song two years later, I'd like its tags back. There's a tension with keeping Spotify-sourced data minimal. Propose a position.
3. **Should the bulk/group-by view also front the experience for a returning session with a large untagged backlog** (say >100 untagged), or only on first run?
4. **Does Regenerate preserve a playlist's name if I renamed it in Spotify?** Proposed: never touch the name after creation — only contents and the expiry line in the description.
5. Anything in the MVP cut above you think is wrong. The two I hold least firmly: deep-link-only audio, and snapshot-rather-than-live playlists.

## MVP acceptance bar

> I can, on my phone, in under a minute, build a boolean tag query over my synced ~3,000-track library, preview it, and end up holding a real private Spotify playlist that will clean itself up — and I can, at a desk, sustain tagging at a few seconds per familiar song.

Everything above exists to hit that sentence. "Done" means that sentence is true against my real Spotify account and my real library, deployed somewhere I can reach from my phone — not that tests pass locally.

A note on build order: I don't want a big-bang release, but I also don't want to be handed a read-only library browser and told it's v0.1 — that's Spotify's own library page, worse. Ship in stages if you like, with each stage deployed and real; "MVP" names the scope line above, not a release event.

---

## What I want from this session

I have deliberately given you **no** opinions about stack, architecture, hosting, database, framework, testing strategy, repo layout, project management, or process. Those are entirely yours. Previous attempts over-engineered the planning and under-delivered the product, and that's why I'm starting over — so weigh getting a working thing in front of me heavily over rehearsing problems I don't have at a scale of one user.

Three things, in order:

1. **Plan thoroughly.** Take as long as you need. Ask me the open product questions above, plus anything else that would change what you build. Research the current Spotify API surface yourself — don't trust your training data on it, and don't fully trust my constraint list either; it's a year old by my reckoning and the API has been churning. Then tell me the plan.

2. **Then give me a complete setup checklist** — everything I personally have to do before you can work autonomously, in the order I should do it, with exact steps: accounts to create (Spotify developer app and its exact settings, hosting, database, anything else), credentials to generate and where to put them, repo creation, any tooling or integrations you want available, and what permissions you need from me so you don't stall waiting for approval mid-build. Be exhaustive and specific; assume I'll do it all in one sitting and then walk away. Tell me explicitly what you will *not* be able to verify without me (anything requiring a real browser login or my phone, for example) so I know what's coming back to me for manual checking.

3. **Then set yourself up to build it autonomously.** I want to be able to invoke a single command that makes you pick up the next piece of work, build it, verify it, and keep going without me steering — and I want to review the result when it's done, not supervise the middle. Design that mechanism however you think is best and tell me how to use it.
