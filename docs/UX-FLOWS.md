# Spotify Plus: everyday flows

Implementation and software acceptance for [UX issue #57](https://github.com/CarterKFalkenberg/spotify-plus/issues/57), October 18, 2026. The [original brief](PRODUCT-BRIEF.md) and [accepted decisions](DECISIONS.md) remain the scope. This refresh changes the interface, without changing API contracts, playlist safety, membership, or annotation semantics.

## Design response

A warm cream canvas, dark forest controls, restrained lime status accents, system typography, and consistent borders create a music workspace with a clear task hierarchy. Connected screens lead with the task, while the signed-out screen introduces the product. Library status and sync sit above navigation; account details are discoverable in the header. Mobile prioritizes playlist creation, existing playlists, and new arrivals, with Library and Tags in a secondary row.

The independent initial critique and the one rendered-design response round produced these decisions:

| Recommendation | Response |
| --- | --- |
| Reduce connected marketing and supporting controls | Adopted: compact connected chrome, inline queue order, collapsed optional library facets. First bulk tag input and daily song/slots/input/Next fit the unscrolled 1280×800 test view. |
| Keep query feedback near editing and shorten phone creation | Adopted: sticky count/duration, loading/zero/exclusion feedback, expandable song preview, then name/retention/Create. Review songs opens the list explicitly. |
| Connect accepted creation to progress | Adopted: View playlist progress opens Your playlists. An accepted request never claims readiness. |
| Put the song and tag input at the center of desktop work | Adopted: compact song panel, all nine stable quick slots, one Edit quick tags action, immediate save feedback. |
| Make mobile triage a complete modal | Adopted: native modal, background inertness, scroll lock, focus restoration to the originating card, visible Previous/Next and swipe, local error recovery and explicit arrival acknowledgement. |
| Remove phone-only clutter | Adopted: populated mobile quick tags only, without keyboard numbers. Desktop keeps all nine slots and pin editing. |
| Make library browsing dense and aligned | Adopted: compact rows with metadata/tags, explicit inline Edit tags, frozen bulk selection, range selection and changed-only undo. |
| Consolidate grouping | Adopted: one Group rows control; results describe artists, albums or decades according to the actual response. |
| Explain retention next to the action and expose its setting early | Adopted: duration selector before the playlist grid, per-card effective Extend/Unpin duration, Open in Spotify as the primary action. Cleanup warnings wait for a loaded response. |
| Add persistent quick-tag layouts or new preferences | Deferred: the accepted MVP specifies automatic slots and session pinning only; a new settings contract would expand scope. |
| Use new fonts, imagery or animation | Deferred: system fonts and existing cover-art behavior suffice; no new dependency or external asset is needed. Reduced-motion preferences remain respected. |

The choices apply [progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) to secondary controls and [recognition rather than recall](https://www.nngroup.com/articles/recognition-and-recall/) to visible tags, durations and actions. Keyboard focus, reflow, gesture alternatives and tap targets are grounded in [WCAG 2.2](https://www.w3.org/TR/WCAG22/). These sources guide design; the tests below do not constitute a complete WCAG conformance audit.

## First connection and bulk backlog

1. Connect the registered Spotify account. Initial import starts automatically.
2. Read deterministic import status. Browse and tag arriving songs while first-sync verification gates playlist creation.
3. On first desktop use, see the biggest artist groups and a short dismissible explanation: no need to finish, begin with a large artist, and new songs arrive quietly.
4. Enter a tag on a group, choose the established match or explicitly create a new tag, and apply it to the exact frozen group.
5. Read the affected-song feedback and use Undo if needed. Dismissing guidance makes later desktop sessions open the queue.

Empty library guidance says to like songs in Spotify and sync. Filtered empty results offer Reset filters. The archive explains preserved tags and cached metadata retention, and offers Back to Liked Songs. Loading and retry states preserve drafts and selection; stale matching selections require explicit reselection rather than silently adopting a new revision.

## Daily desktop tagging

1. Open the queue, defaulting to untagged newest-liked songs. Choose oldest, latest completed sync, random, or send a frozen library filter/selection to the queue.
2. Read the current song, artist, album, year, duration and liked date together.
3. Type a tag and press Enter, or use a visible number slot on an empty input. A mutation saves immediately; navigation does not commit a form.
4. Read specific saved/already-applied feedback. Use Undo for the actual changed assignment, preserving later edits.
5. Press arrows to move, or use visible Next/Previous. Skip requeues. Open in Spotify, artist jump and hotkey help remain available.
6. Open Edit quick tags to change session pins; close it to return focus to tagging. Frequent-tag reranking after saves does not rearrange number keys; deletion leaves an empty slot. Explicit pin changes may rearrange the unpinned slots, as before.

Text, IME composition and repeated-key safeguards remain unchanged. Empty queues explain the next action. Refresh queue recovers failed loads; failures from quick tags, removal and undo stay reachable inside an open phone modal as well.

## Phone: query to Spotify

1. Open Make a playlist. Use All of, Any of and None of with the shared tag picker. A new vocabulary has a direct Tag your library path.
2. Watch the nearby cached-library count and duration. A changed query clears the old result immediately. Loading, zero playable matches, excluded unavailable songs, and errors remain explicit.
3. Open Review songs to inspect the scrollable preview. The list is expanded on desktop and initially collapsed on phones to keep the next step close.
4. Edit the prefilled name and visible retention (default one calendar month), then Create.
5. If acceptance is confirmed, choose View playlist progress. The managed row remains Queued/working or Incomplete until the server confirms completion. Open in Spotify is the primary listening action.

An ambiguous response retains the original request UUID/body across retries and reloads. Reconnect and Retry saved create request preserve this intent. Stale previews return to editing; an incomplete first import and zero playable results cannot create a playlist. Preview requires no Spotify request.

## Phone: new arrivals

1. Choose New arrivals to open song cards.
2. Tap a card to open the native song modal. Background interaction and scrolling are blocked while it is open.
3. Apply a populated quick tag or type a tag, then read immediate saved feedback. The input draft survives a viewport change.
4. Use Previous/Next or swipe to advance. Only Mark arrival reviewed acknowledges the arrival.
5. Close the sheet to return focus to the originating card. Closing, changing views, or losing the final current song releases the modal and body scroll lock.

Errors and Refresh queue are inside the modal. Content scrolls within the available dynamic viewport and includes bottom safe-area spacing. Software tests simulate narrow viewports; the actual phone keyboard and one-minute triage acceptance remain human checks.

## Keep a playlist, or let it go

1. Open Your playlists. Read loaded lifecycle status and the expiry date/countdown or Pinned.
2. Choose the shared Extend/Unpin duration above the grid. The affected card states the effective duration beside its actions.
3. Open in Spotify to listen, Pin to keep, Extend to reset a clock, or Unpin to start a new selected clock. Regenerate preserves the Spotify name and follows the existing retention.
4. Delete now opens a named confirmation describing removal from Your Library; confirm explicitly or keep the playlist.

An empty list explains where playlists appear. Loading does not show a premature cleanup-delay warning. Incomplete writes retain Retry, ambiguous actions retain their saved intent, blocked work explains recovery, and overdue rows remain visible until removal is confirmed. Publication acknowledgement does not establish actual profile/search hiding.

## Account recovery and deletion

Open Account & connection in the header. A renewal warning or expired grant expands the reconnect explanation and shows Reconnect Spotify. Disconnect & delete app data opens a native named modal with Keep my data focused first. Confirmation preserves the existing server reconciliation and purge behavior; existing Spotify playlists stay and cleanup stops. Lost replies never locally assert deletion.

## Software acceptance and remaining human acceptance

`tests/browser/core.spec.ts`, `fast-tagging.spec.ts` and `connection.spec.ts` retain broad lifecycle, selection, undo, retry, input and disconnect coverage. Added checks cover:

- Query feedback and direct accepted-request progress navigation; loaded-only cleanup warnings and visible effective retention.
- Long tag reflow at 320, 360, 390, 430, 768 and 1280 CSS pixels; focused inputs retain visible outlines.
- Unscrolled 1280×800 positions for the first bulk tag input and daily song/slots/input/Next, so autofocus scrolling cannot create a false pass.
- Native `:modal` behavior, scroll lock, originating-card focus restore, explicit navigation, local failure recovery, final-song removal, and breakpoint draft preservation.
- Stable number slots after usage reranking and deletion; existing IME, selection, tri-state and changed-only undo invariants.
- Hidden skip link during normal work, visible intentional keyboard access, and reduced-motion styling.

Optional `UX_CAPTURE=1` browser tests write only synthetic screenshots to ignored `.local/ux/`. They are local inspection evidence, not committed metadata. Typecheck, meaningful frontend tests, production build and full repository checks remain delivery gates; the orchestrator owns deployment and redacted live verification.

Actual phone query-to-Spotify under one minute, familiar-song tagging at roughly 3–5 seconds per song, and actual profile/search hiding remain **pending human product acceptance**. Emulation and command acknowledgement do not replace these checks.
