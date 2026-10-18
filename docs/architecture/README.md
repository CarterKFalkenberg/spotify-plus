# Architecture guide

A source-based map of Spotify Plus, preserved from the October 14, 2026 guide at
commit [`7cfd663a3766ae694041d1c170705820f49c4ff6`](https://github.com/CarterKFalkenberg/spotify-plus/tree/7cfd663a3766ae694041d1c170705820f49c4ff6).
This documents that implementation snapshot; it is not a new production health,
billing, deployment or product-acceptance report. Examples are synthetic.

- [Architecture handbook](handbook.html): 16 chapters covering runtime boundaries,
  source ownership, OAuth, data, import, tagging, queries, playlist lifecycle,
  recovery, UI, backups, integrations, tests, delivery and operations. Includes all
  17 rendered diagrams, their editable source, enlargement and SVG download.
- [Interactive request walkthrough](walkthrough.html): eight flows with Previous,
  Next and flow selection: login, import, bulk tagging/undo, preview, creation,
  lost response, expiry and disconnect.

GitHub's HTML file view shows source rather than executing these pages. Download
an HTML file (or clone this repository) and open it in a browser. Both pages are
standalone, work without network access, and need no server, application login,
Mermaid runtime or npm installation. Keep both HTML files together for their
navigation links; keep this directory for the documentation index. Source links
inside the handbook intentionally open GitHub at the pinned commit and need a
network connection.

## Diagrams

SVG files can be viewed directly on GitHub or downloaded. Mermaid (`.mmd`) files
are the editable diagram source; their numbers match the handbook figures.

| Figure | Diagram | Editable source | Rendered SVG |
| --- | --- | --- | --- |
| 01 | Deployment and trust boundaries | [Mermaid](diagrams/01.mmd) | [SVG](diagrams/01.svg) |
| 02 | Dependency map | [Mermaid](diagrams/02.mmd) | [SVG](diagrams/02.svg) |
| 03 | Hosted OAuth | [Mermaid](diagrams/03.mmd) | [SVG](diagrams/03.svg) |
| 04 | Core physical relationships | [Mermaid](diagrams/04.mmd) | [SVG](diagrams/04.svg) |
| 05 | Lifetimes | [Mermaid](diagrams/05.mmd) | [SVG](diagrams/05.svg) |
| 06 | Stable import algorithm | [Mermaid](diagrams/06.mmd) | [SVG](diagrams/06.svg) |
| 07 | A bulk add and its Undo | [Mermaid](diagrams/07.mmd) | [SVG](diagrams/07.svg) |
| 08 | Synthetic example: chill AND (drive OR roadtrip) AND NOT sad | [Mermaid](diagrams/08.mmd) | [SVG](diagrams/08.svg) |
| 09 | Preview and create share the query but have different effects | [Mermaid](diagrams/09.mmd) | [SVG](diagrams/09.svg) |
| 10 | Playlist states | [Mermaid](diagrams/10.mmd) | [SVG](diagrams/10.svg) |
| 11 | Creation and recovery | [Mermaid](diagrams/11.mmd) | [SVG](diagrams/11.svg) |
| 12 | Scheduled execution and lease recovery | [Mermaid](diagrams/12.mmd) | [SVG](diagrams/12.svg) |
| 13 | Component and interaction ownership | [Mermaid](diagrams/13.mmd) | [SVG](diagrams/13.svg) |
| 14 | Visibility-aware polling | [Mermaid](diagrams/14.mmd) | [SVG](diagrams/14.svg) |
| 15 | Backup, restore and disconnect have separate authority paths | [Mermaid](diagrams/15.mmd) | [SVG](diagrams/15.svg) |
| 16 | Evidence layers | [Mermaid](diagrams/16.mmd) | [SVG](diagrams/16.svg) |
| 17 | Delivery gates | [Mermaid](diagrams/17.mmd) | [SVG](diagrams/17.svg) |

## Keeping the guide synchronized

The repository's product brief, accepted decisions and current source remain the
authority. This guide is a pinned explanatory snapshot, not generated API
reference. When intentionally updating it to describe newer code:

1. Check the affected claims against implementation and accepted decisions; update
   the date, commit and pinned source links in both HTML documents together. Do
   not present historical verification evidence as a fresh check.
2. Edit the corresponding `diagrams/NN.mmd` and its matching **Diagram source**
   block in `handbook.html` together. Render that Mermaid source to
   `diagrams/NN.svg` using a Mermaid-compatible renderer, then replace the matching
   inline SVG in the handbook with the same rendered SVG. Keep SVG IDs unique
   across figures. No renderer is needed to read the delivered documents.
3. Synchronize the prose, captions, walkthrough steps and this index when a flow
   or responsibility changes. Keep walkthrough state browser-local and preserve
   the absence of runtime network dependencies and account data.
4. Open both HTML files offline at desktop and phone widths. Check all 17 figures,
   source disclosures, enlargement/SVG downloads, internal links, and all eight
   walkthrough flows in both directions. Verify diagram sources match the embedded
   source and that exported SVGs match the embedded figures.

The retained artifacts exclude the original machine-specific renderer, preview
wrappers, screenshot/QA helpers, PNGs, archive and vendored Mermaid bundle. Changes
ship through the repository's normal PR and review workflow.
