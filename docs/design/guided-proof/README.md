# Guided usability proof

Matched before/after source: `34b6ac775e4aa2404f4198cf50488e589c09eae7` → `c3af630d95c485289898057fb4ffa68f6c43021f`. Application tree at capture: `54b8d4f1078cca9f7e31b37f9355166976e63b02`. The gallery commit adds proof only; the captured application tree is unchanged.

30 comparisons from 184 original screenshots. Both themes use identical synthetic API fixtures, fictional metadata, generated artwork, viewport sizes and capture helpers per set. Served build metadata and clean, stable Git state were checked. No real Spotify content or images appear here.

The 3,000-song / 180-artist scene is a synthetic stress fixture. Artist portraits and covers demonstrate layout. Actual endpoint and image availability is a separate redacted live gate; these screenshots do not establish it. Ordinary 360×740 creation steps fit; expanded refinements, management, long text and enlargement may require vertical scrolling.

[Original screenshots, manifests and capture harness](original-captures.zip) · [SHA-256 and provenance manifest](manifest.json). Run the bundled helpers from the relevant clean checkout with Node 24, its locked Playwright dependency and the matching local Vite server; set `PROOF_ORIGIN` and `PROOF_PHASE`. All nonlocal requests are mocked or blocked.

The 2× text scene doubles pre-collected computed font sizes and records a ratio for every HTML element; it does not claim native browser zoom, OS font settings, a visible software keyboard, or actual phone acceptance. Browser regression tests independently cover scrolling, focus, error recovery and mutation semantics. Actual phone timing, personal tagging speed and profile/search hiding remain human acceptance.

### Tag queue — light

Nine quick tags stay visible; song actions, ordering and editing are disclosed. Next is the main action.

![Tag queue: before and after in light](desktop-queue-light.png)

### Large artist library — light

Same 3,000-song / 180-artist fixture: bounded 12-group pages, portraits and aligned contextual actions replace a long page of repeated inputs.

![Large artist library: before and after in light](1440-library-large-light.png)

### Library songs — light

Purpose and browse modes are explicit; song tagging uses one contextual editor.

![Library songs: before and after in light](desktop-library-light.png)

### Your tags — light

Tag names, active-song counts and Edit are aligned; global rename/merge/delete remain available.

![Your tags: before and after in light](desktop-vocabulary-light.png)

### Appearance — light

A labeled control opens System / Light / Dark choices.

![Appearance: before and after in light](desktop-appearance-light.png)

### Phone: choose tags — light

360×740 viewport. Choose tags and see the live match; Review songs is the prominent next action.

![Phone: choose tags: before and after in light](360-builder-choose-light.png)

### Phone: review songs — light

The guided second step gives songs their own review space and an explicit Playlist details action.

![Phone: review songs: before and after in light](360-builder-review-light.png)

### Phone: name and keep — light

Name, retention, expiry and Create fit the ordinary viewport; details remain available by disclosure.

![Phone: name and keep: before and after in light](360-builder-details-light.png)

### Your playlists on a phone — light

Healthy playlists show cover, expiry, Open and Manage; pending and incomplete states remain explicit.

![Your playlists on a phone: before and after in light](360-playlists-light.png)

### Tag queue — dark

Nine quick tags stay visible; song actions, ordering and editing are disclosed. Next is the main action.

![Tag queue: before and after in dark](desktop-queue-dark.png)

### Large artist library — dark

Same 3,000-song / 180-artist fixture: bounded 12-group pages, portraits and aligned contextual actions replace a long page of repeated inputs.

![Large artist library: before and after in dark](1440-library-large-dark.png)

### Library songs — dark

Purpose and browse modes are explicit; song tagging uses one contextual editor.

![Library songs: before and after in dark](desktop-library-dark.png)

### Your tags — dark

Tag names, active-song counts and Edit are aligned; global rename/merge/delete remain available.

![Your tags: before and after in dark](desktop-vocabulary-dark.png)

### Appearance — dark

A labeled control opens System / Light / Dark choices.

![Appearance: before and after in dark](desktop-appearance-dark.png)

### Phone: choose tags — dark

360×740 viewport. Choose tags and see the live match; Review songs is the prominent next action.

![Phone: choose tags: before and after in dark](360-builder-choose-dark.png)

### Phone: review songs — dark

The guided second step gives songs their own review space and an explicit Playlist details action.

![Phone: review songs: before and after in dark](360-builder-review-dark.png)

### Phone: name and keep — dark

Name, retention, expiry and Create fit the ordinary viewport; details remain available by disclosure.

![Phone: name and keep: before and after in dark](360-builder-details-dark.png)

### Your playlists on a phone — dark

Healthy playlists show cover, expiry, Open and Manage; pending and incomplete states remain explicit.

![Your playlists on a phone: before and after in dark](360-playlists-dark.png)

### Edit all nine quick slots — light

Slot 9 editing and tag suggestions are available on demand.

![Edit all nine quick slots: before and after in light](desktop-quick-tag-edit-light.png)

### Bulk selection — light

Two selected songs retain one bulk editor with suggestions. No Spotify library writes occur in this visual fixture.

![Bulk selection: before and after in light](desktop-library-selection-light.png)

### Tag deletion preview — light

The assignment count, consequence, confirmation and cancel path remain visible before a synthetic deletion.

![Tag deletion preview: before and after in light](360-tag-delete-confirmation-light.png)

### All / Any / None refinements — light

All three distinct synthetic tags are selected. Expanded content uses vertical scrolling; the viewport image is not a claim that all refinements fit at once.

![All / Any / None refinements: before and after in light](360-builder-refinements-light.png)

### Playlist management — light

Retention, Pin, Extend, Regenerate and Delete remain available after Manage is opened. Expanded content can scroll.

![Playlist management: before and after in light](360-playlist-manage-light.png)

### Measured 2× text enlargement — light

Every HTML element’s pre-collected computed font size is doubled and measured. This is synthetic text enlargement at 320px, not native browser zoom or a real phone acceptance test.

![Measured 2× text enlargement: before and after in light](320-builder-text-200-light.png)

### Edit all nine quick slots — dark

Slot 9 editing and tag suggestions are available on demand.

![Edit all nine quick slots: before and after in dark](desktop-quick-tag-edit-dark.png)

### Bulk selection — dark

Two selected songs retain one bulk editor with suggestions. No Spotify library writes occur in this visual fixture.

![Bulk selection: before and after in dark](desktop-library-selection-dark.png)

### Tag deletion preview — dark

The assignment count, consequence, confirmation and cancel path remain visible before a synthetic deletion.

![Tag deletion preview: before and after in dark](360-tag-delete-confirmation-dark.png)

### All / Any / None refinements — dark

All three distinct synthetic tags are selected. Expanded content uses vertical scrolling; the viewport image is not a claim that all refinements fit at once.

![All / Any / None refinements: before and after in dark](360-builder-refinements-dark.png)

### Playlist management — dark

Retention, Pin, Extend, Regenerate and Delete remain available after Manage is opened. Expanded content can scroll.

![Playlist management: before and after in dark](360-playlist-manage-dark.png)

### Measured 2× text enlargement — dark

Every HTML element’s pre-collected computed font size is doubled and measured. This is synthetic text enlargement at 320px, not native browser zoom or a real phone acceptance test.

![Measured 2× text enlargement: before and after in dark](320-builder-text-200-dark.png)
