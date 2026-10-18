# Visual redesign: before and after

Reviewable visual evidence for [issue #63](https://github.com/CarterKFalkenberg/spotify-plus/issues/63). These are the same comparisons intended for the PR and final delivery, rather than a separate set of promotional mockups. The screenshots show the running application with matched fixtures, viewports and actions.

## Provenance and limits

| Evidence                     | Source                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Before                       | Clean `2fc191f5a41dfc758100492c742896c6c05313af`                                                                 |
| After                        | Clean `31670e64a6dd2c6489a3792c66b938a194d19f63`                                                                 |
| Captured application subtree | `a998e03ab02dad71a5fbdf29894fa81b637abf71` (`31670e6:app`)                                                       |
| Committed gallery            | 22 PNG compositions; source pairs and SHA-256 hashes in [manifest.json](manifest.json)                           |
| Full capture sets            | 41 states per new appearance, plus viewport supplements; retained outside source control for the delivery bundle |

All metadata is fictional synthetic data. Cover studies are locally generated vector illustrations fulfilled by mocked image routes. Every API route is mocked; nonlocal network requests are blocked rather than fetched. No real Spotify library content, account metadata, artwork or credentials appear in these images. The richer collection contains eighteen fictional tracks, while some query/lifecycle states deliberately use the smaller synthetic fixtures that exercise exclusions, long tags and pending/incomplete records.

Before/after pairs use the same viewport and action sequence. The old interface had one cream appearance; the principal comparisons show that baseline beside the redesigned **explicit Dark choice**. The final two comparisons show the redesigned Light and Dark options side by side. Dark is optional: a fresh device starts with **System**, follows the operating system, and can persist either explicit choice. These pictures do not imply that Dark is forced or initially selected.

This gallery is an assets/documentation follow-up to the captured source commit. The application subtree must remain identical to the value above; the documentation commit itself is not presented as the capture source, avoiding a circular provenance claim. Image captions explain observable interface changes, not backend or production acceptance.

## Shared patterns and independent critique

The shared system replaces cream cards and broad navigation bands with a neutral canvas, compact rail on desktop, bottom navigation on phones, a consistent type scale, ruled collection rows, clear field boundaries and flat uncolored tags. Green identifies principal actions and active accents. Artwork supplies the broader color. Each task has its own composition: queue identity/tagging desk, library table/group ledger, query composer/preview, playlist ledger and vocabulary dictionary.

Two independent rendered critics rejected the first draft's account/appearance overlap, squeezed group Browse target, excessive phone chrome, sparse vocabulary treatment, scattered playlist metadata and repeated preview counts. The bounded revision separated header targets, aligned group actions, moved phone tasks upward, introduced compact dictionary rows and explicit merge selection, clustered playlist facts, exposed the selected retention in a compact disclosure, and kept one prominent live match count. Both critics accepted the second rendered pass. Their acceptance is visual review evidence; it does not stand in for software checks or human product acceptance.

## Desktop workspaces

### Focused queue

Before, modest artwork sits within a single large card above a wide quick-tag row. After, large artwork and track identity anchor one side; current tags, input and nine numbered slots form a precise desk beside it. Previous/Next/Skip are separate from occasional tools. Immediate save, count-up feedback, deep links and keyboard behavior remain part of the flow.

![Focused queue before and after](queue-before-after.png)

### Library table

The collection occupies the available work area, with compact artwork/identity rows and aligned metadata, tags and editing. Search, membership and untagged filtering remain visible; optional facets expand in place. Selection and editing retain their existing behavior.

![Library browsing before and after](library-before-after.png)

### Artist groups and bulk tagging

Independent artist cards become compact ledger rows. Artist identity and counts sit beside the tag picker, selection and an intentionally sized Browse action. Group tagging, frozen matching selections and undo continue to operate on the same synthetic data.

![Artist grouping before and after](groups-before-after.png)

### Compose and preview

The three query buckets become ruled query rows on the left, with the live count and song preview on the right. Playlist details follow both. The preview remains local to the cached library; unavailable-song exclusions, visible retention, publication qualifications and snapshot consequences remain in the workflow.

![Playlist builder before and after](builder-before-after.png)

### Playlist collection

Names, query tags, status, count, expiry and creation date now form a coherent ledger entry. Open in Spotify leads the action group; retention and management actions remain subordinate. Ready, pending and incomplete records retain literal state labels. Ready does not assert independently verified profile/search hiding.

![Playlist collection before and after](playlists-before-after.png)

### Vocabulary dictionary

The dictionary aligns tag names and last-use metadata with usage counts and named management actions. Merge source selection is an explicit mode instead of a repeated instruction on every resting row. Tags remain flat strings with no added colors, hierarchy or inferred meaning.

![Tag dictionary before and after](tags-before-after.png)

## Phone flows

### Build a playlist

A compact header and fixed bottom destinations replace the large navigation block. The live match count leads compact All/Any/None rows; preview and creation details follow in document order. The same deliberately long synthetic tag checks wrapping rather than relying on short idealized content.

![Phone playlist builder before and after](mobile-builder-before-after.png)

### Open and retain a playlist

The task and first ready playlist appear substantially earlier in the viewport. A compact disclosure shows the currently selected Extend/Unpin period; per-playlist action hints keep its consequence visible. Status, count and expiry sit together, and the first Spotify action clears the bottom navigation.

![Phone playlist collection before and after](mobile-playlists-before-after.png)

### New arrivals

Arrival cards share the collection's edge alignment and restrained identity treatment. The new-arrival count remains a quiet route into review; opening the list does not silently acknowledge a song.

![Phone new arrivals before and after](mobile-arrivals-before-after.png)

### Tagging sheet

The native sheet keeps track identity, current tags, autocomplete, quick tags and Spotify access together. Desktop bulk tools and keyboard help remain absent from the phone flow. This is a tagging sheet, not a music player.

![Phone tagging sheet before and after](mobile-sheet-before-after.png)

### Manage tags

Compact dictionary rows show several entries within the phone viewport. Usage and last-use information remain available, while contextual Manage actions and explicit merge selection reduce repeated chrome.

![Phone tag dictionary before and after](mobile-tags-before-after.png)

## Connection, account and supporting pages

### Connect Spotify

The connection view uses the same typography and neutral materials as the workspace. It explains tagging, previews and retention directly, without a large marketing slogan or numbered feature ceremony. The single-account login and promise never to change Liked Songs remain explicit.

![Connect Spotify before and after](connect-before-after.png)

### Account and connection

Account access remains a named disclosure within compact chrome. Expanded details join the same surface system, retaining reconnect and disconnect behavior rather than introducing a separate settings product.

![Account and connection before and after](account-before-after.png)

### Disconnect confirmation

The native modal retains an explicit destructive confirmation, a safe cancellation action, and the distinction between deleting app data, keeping existing Spotify playlists and revoking the Spotify grant separately.

![Disconnect confirmation before and after](account-confirm-before-after.png)

### Privacy

The privacy page uses the same header, appearance choice, type and text measure. Its data, backup, retention and provider-boundary statements remain readable product information.

![Privacy page before and after](privacy-before-after.png)

### Terms

The terms page follows the same reading layout, retaining playlist publication/link-access qualifications and free-hosting limitations.

![Terms page before and after](terms-before-after.png)

### Unknown route

The recovery page belongs to the same system and offers a direct route back to the app. It does not add a separate decorative error illustration or product feature.

![Unknown route before and after](not-found-before-after.png)

## Errors and confirmation states

### Spotify connection error

The connection error retains its concrete fix and distinct failure identity. Neutral chrome and an attention surface provide hierarchy without implying success or claiming the wrong Spotify failure reason.

![Connection error before and after](auth-error-before-after.png)

### Tag mutation failure

The song sheet keeps the failed mutation's explanation and recovery action visible within the task. An error does not turn into a success state or erase the tagging context.

![Tag mutation failure before and after](error-before-after.png)

### Tag deletion confirmation

The impact preview and explicit deletion action retain their place in a named native modal. The redesign changes its typography and materials while preserving the assignment count, confirmation and undo semantics.

![Tag deletion confirmation before and after](confirm-before-after.png)

## Light and Dark parity

Both appearances use the same component structure, spacing, controls and behavior. Light uses cool neutral surfaces and near-black text; Dark uses graphite surfaces and warm-white text. Neither appearance gives individual tags color identity. The normal Appearance select offers Light, Dark and System on every page.

![Desktop Light and Dark appearance](themes.png)

![Phone Light and Dark appearance](mobile-themes.png)

## Verification boundary

The implementation passed formatting, typecheck, 151 frontend tests and a production build. The final local browser run recorded 172 passes and 41 intentional skips, with one timeout in Playwright's fixed-navigation scroll step; that unchanged reconnect case then passed all six focused repeat runs across desktop and phone projects. Earlier focused runs passed the strict frozen-selection regression, all four 600/720px feedback/dock cases, and both-theme contrast, focus, popup, merge and geometry checks. No assertions or timeouts were weakened to make that transient failure disappear.

The orchestrator still owns final exact-head `scripts/check`, independent Standards/Spec review, CI, deployment and redacted live verification. Those pending gates must not be inferred from these images. Actual phone timing, the familiar-song tagging-speed trial and actual Spotify profile/search hiding remain **pending human product acceptance**. Browser emulation and acknowledged publication commands do not establish those outcomes.
