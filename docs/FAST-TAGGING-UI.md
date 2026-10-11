# Fast-tagging frontend

Issue [#29](https://github.com/CarterKFalkenberg/spotify-plus/issues/29) implements
`PRODUCT-BRIEF.md` and the accepted October 11 routing/shortcut choices, using
[FAST-TAGGING-CONTRACTS](FAST-TAGGING-CONTRACTS.md). The frontend uses cached
owner API data only; it performs no Spotify transport or metadata analysis.

The first desktop visit leads with artist groups ordered by backend group size.
The dismissible explanation records only a local preference. Returning desktop
visits lead with the queue; more than 100 untagged songs adds a bulk shortcut.
Mobile leads with the playlist builder. The quiet new badge opens the queue's
card list and a song sheet with slots, autocomplete, Spotify links and swipe
advance. “Mark arrival reviewed” explicitly acknowledges the current song for
that badge; browsing/navigation never silently acknowledges arrivals. Bulk controls and keyboard shortcuts are desktop only.

The queue loads a revision-bound traversal into a session sequence. Navigation
never submits a form; skip moves only the current song to the tail. Saving a tag
does not replace the sequence with the newly shortened untagged result. Cached
membership refresh updates its existing tracks without admitting new arrivals or
sorting them again. Existing-ID saves/acknowledgements advance the covered
annotation revision only for their exact owned increment, with unchanged library
revision; concurrent changes and name-based creation require reconciliation.
Orders include newest/oldest liked, last completed sync and
seeded random. Explicit browser selections retain their track keys; filter
selections require their captured revision before queue admission. Random retry
retains its traversal seed.

Quick slots start from most-used vocabulary. Session pins retain explicit tag
identities. Enter favors established suggestions; new tags have a distinct last
row. Input is never repurposed for bare letter commands, even while empty.
Alt/Option letters use physical key codes, including macOS characters such as
Option+S producing `ß`, to trigger the accepted actions; non-composing empty input also
accepts 1–9 and left/right navigation. Repeated keys, control/meta combinations,
nonempty input arrows and IME Enter/number keys remain outside these actions.
Autocomplete supports up/down suggestion navigation and preserves focus/drafts
through saves and failures. The existing durable playlist intent/reconnect
handling remains intact.

Library sorting, search, untagged and artist/album/decade facets use backend
identities. Album display names are never constructed into filters, including
`Album unavailable`. Shift ranges preserve selected keys from other pages.
Select-all and group selections retain their captured filters and revisions;
a refresh warns instead of silently renewing them. The sticky bar reports exact
server tri-state inspection and separates idempotent Add from explicit Remove.
Selection choices can be searched and paginated across the complete vocabulary.
Both autocomplete pickers inspect their displayed IDs against the captured
selection before exposing all/some/none counts. Empty vocabulary makes no invalid
empty-ID inspection; a failed/stale inspection cannot submit a guessed choice.
Facet refresh invalidates the displayed options and cursor as one context, so
sync/tag changes cannot leave stale facets or reuse a prior revision's cursor.
Management preview errors and recovery remain inside the active dialog while
preserving the rename draft.
Mutation toasts report changed assignments and changed-only session undo.

Vocabulary supports name/usage/last-used order and the truly unused view. Rename,
merge and delete preview before committing. Rename collisions offer a separately
previewed merge into the existing UUID. Merge impact uses backend distinct union
counts, including retained annotations; delete submits the displayed retained
assignment count. Session undo delegates version fences and query restoration to
the transactional backend. No client-side sum or guessed vocabulary identity is
used.

## Synthetic evidence

- `tests/frontend/tagging.test.ts`: letters/IME/repeats, numeric slot eligibility,
  reverse range selection, skip preservation, opaque facets, exact union and
  malformed response rejection.
- `tests/browser/fast-tagging.spec.ts`: queue shortcuts/near-match Enter/pins/order,
  tri-state fill and clearing, range selection, frozen stale mutation drafts,
  collision union confirmation, retained delete counts, session undo,
  unused/last-used, mobile sheet swipe and first-run/returning home.
- Existing `tests/browser/core.spec.ts`: durable create/lifecycle UUID replay
  through reconnect/reload, preview failure recovery, import typing/focus and
  frozen selections, unavailable/empty states and synthetic layouts.

All fixtures are synthetic; external network requests are aborted. Hosted stage
verification, final software checks/review and the actual phone and familiar-song
performance trials belong to the orchestrator/human acceptance gates. Browser
emulation is not evidence of the user's under-one-minute phone flow or 3–5-second
personal tagging speed.
