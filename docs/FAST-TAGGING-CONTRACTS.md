# Fast tagging contracts

Issue [#25](https://github.com/CarterKFalkenberg/spotify-plus/issues/25) extends
[CORE-CONTRACTS](CORE-CONTRACTS.md) for the full tagging stage. The shared
`contracts.ts` exports request parsers and response types. Existing owner session,
origin, epoch, body-size, immutable track identity and playlist-only Spotify write
boundaries remain authoritative. Every operation below uses only local cached
metadata and annotations, with zero Spotify calls.

## Library and queue

`POST /api/library/search` keeps `{filter,groupBy,cursor,limit}` and optionally adds
`sort` and `seed`. Sort is `newest` (default), `oldest`, `title`, `artist`, `album`,
`year` or `random`. Random requires a UUID seed; other sorts require null/absent
seed. The UI retains the seed for the traversal and a restart following a revision
conflict; deterministic hashing of seed and opaque track key orders every page.
Advancing a queue is a UI operation, not an implicit save or acknowledgement.

The existing filter extends with optional fields:

| Field | Values / semantics |
| --- | --- |
| `album` | null/absent means unrestricted; otherwise an opaque `album:` prefix plus 64 lowercase hexadecimal characters, returned by album groups/facets. It is SHA-256 of the complete cached name under NFC, whitespace collapse and case normalization. There is no synthetic Spotify album ID. |
| `decade` | null/absent means unrestricted; integer multiple of ten (0–9990) selects that decade; `"unknown"` explicitly selects unavailable release years. |
| `latestSyncOnly` | false/absent is unrestricted; true selects active tracks whose addition run is the last completed stable sync. Unlike `newOnly`, acknowledging arrivals does not remove them from this mode. It is invalid with removed membership. |

`library_state.completed_run_id` is independent of the current import's
`latest_run_id`. A new stable completion advances the library revision even if its
walk changed no cached metadata. Newly imported tracks remain browsable before
completion, but do not replace the last completed run's queue. The quiet new badge
continues to count unacknowledged active arrivals, including additions seen while a
sync is incomplete. Re-likes are additions; ordinary refreshed rows are not.

GroupBy accepts `artist`, `album`, `decade` or null. Groups order by distinct
filtered track count descending then value. Each group supplies `value`, `name`,
`trackCount`, `taggedCount`, and its complete revision-bound filter selection.
Artist groups additionally retain `artistId` for compatibility. Album groups use
the same bounded identity as album filtering. Hashing the complete normalized name
keeps empty and arbitrarily long cached names selectable without truncation or a
display-name input limit. Empty/whitespace names form an `Album unavailable`
group with its own concrete identity, distinct from null's unrestricted filter.
Clients pass returned identities verbatim and retain `name` only for display.
Unknown decade is a real group.
Artist groups never widen an already selected artist, including collaborations.

`POST /api/library/facets` accepts `{filter,facet,cursor,limit}` where facet is
artist/album/decade. `LibraryFacetsResponse` contains `facet`, `revision`,
`options: [{value,name,trackCount}]`, `totalOptions` and `nextCursor`. Counts are
distinct tracks under the complete current filter; facets follow the group order.
Convert numeric decade values to numbers when adding them to a filter, retaining
`"unknown"` as a string. Search and facet cursors are separately bound to their
route, complete filters, grouping/sorting/seed and both library revisions.
Changing any bound input or either revision rejects the cursor with 409
`stale_revision`. Select-all evaluates the same distinct complete filter in the
mutation transaction; cursor position and display ordering do not affect its set.

## Vocabulary and picker

Existing `GET /api/tags` ranks case/NFC/whitespace normalized exact matches first,
then prefixes, substrings, and edit-distance near matches. Near matches permit at
most two character edits for inputs of at least three characters. This preserves
accents, emoji, punctuation and digits; there is no stemming or hierarchy.
Within a match class active usage counts and normalized names break ties. Empty
search returns the most used vocabulary. The UI always places a distinct create
row last, and Enter selects an existing suggestion before a create affordance.

`POST /api/tags/vocabulary` accepts `{search,sort,cursor,limit}`. Sort is `name`,
`mostUsed`, `lastUsed` or `unused`; `TagVocabularyResponse` extends the existing
search response with `nextCursor`. MostUsed is the quick-slot source. LastUsed
sorts latest first with never-used last. Unused means no present assignment across
any retained annotation, including removed/purged tracks: an active count of zero
alone does not mean the user's tag is unused. Existing TagDTO explicitly supplies
`activeTrackCount` and `lastUsedAt`. Vocabulary cursor bindings include search,
sort, epoch and both revisions.

`POST /api/tags/selection` accepts `{selection,tagIds,expectedRevision}` and returns
`TagSelectionResponse`: `revision`, `selectedCount`, and ordered
`tags: [{tag,assignedCount,state}]`. State is `all`, `some`, or `none`; an empty
filter selection returns none. Both explicit and filter selections require the
current expected revision for this inspection. All counts are exact in the same
owner-locked transaction. A subsequent Add is idempotent and moves some to all;
Remove remains the explicit clearing action. Existing atomic name-based Add and
its changed-only undo remain unchanged.

## Preview and commit vocabulary changes

`POST /api/tags/manage-preview` and `POST /api/tags/manage` accept the same intent
and `expectedRevision`:

| Action | Intent fields |
| --- | --- |
| rename | `tagId`, `name` |
| merge | distinct `sourceIds` (1–200), `targetId` outside those sources |
| delete | `tagId`; commit additionally requires `confirmedAssignmentCount` |

`TagManagePreviewResponse` contains `revision`, `assignmentCount`,
`activeTrackCount`, `unionCount`, and nullable `collisionTag`. AssignmentCount
counts present edges across all included tag IDs and retained annotations.
ActiveTrackCount counts distinct active cached tracks, with merge overlaps counted once. UnionCount counts
**distinct retained tracks**, including removed/purged annotations, so overlaps
are never double-counted in merge impact. Merge includes destination and all
sources in its preview counts. Delete's confirmation uses assignmentCount, not
active count. Stale previews fail before changes. Rename onto an existing
normalized name returns collisionTag and makes no change; the UI offers a new
merge preview instead of overwriting vocabulary.

`TagManageResponse` adds nullable `actionId`, `changedCount` and nullable `tag`.
Successful rename, merge and delete record session action IDs; rename collision or
no-op returns null. ChangedCount measures changed assignment edges plus renamed/deleted vocabulary
identities. Merge includes source removals and destination additions; internal
destination version fencing is not counted. This is not a song count; use preview
unionCount for merge impact. The returned tag is the retained destination/renamed
identity, or null after delete.

Merge unions assignments, tombstones sources, and rewrites every matching leaf
of arbitrarily nested stored playlist queries atomically. Playlist query revisions
and list revisions advance. Existing playlist names, Spotify description notes,
track counts and frozen membership do not change. Captured in-flight operation
queries, labels and targets retain their original consistent intent; a later
Regenerate uses the updated stored query.

Delete tombstones the UUID, releases its normalized name as SQL null, and removes only its
present assignments. Stored query leaves remain unchanged and explicitly fail
with `unknown_tag`, including NOT branches, until undo restores the identity or
the user edits the query. Lookup/search exclude deleted tags. No placeholder name
is returned as live vocabulary and no implicit query simplification occurs.

## Session undo and lifecycle

All actions use existing `POST /api/tag-actions/:id/undo` with `{}`. The server
checks current epoch and unexpired originating owner session. Assignment undo
continues to restore only edges whose versions match the recorded changed edges;
undo of an assignment to a subsequently deleted tag skips those edges.

Rename/merge journal vocabulary versions, edge before-states and resulting edge
versions, plus before/after stored queries and resulting playlist revisions.
Every merge advances the destination vocabulary version even when all its destination edges were already present, fencing older dependent merges. Contributed already-present destination edges also advance their versions, fencing earlier ordinary assignment undo without inventing a changed presence edge. Vocabulary identities must still match recorded versions and their prior names
must be available before dependent restoration. Otherwise the complete dependent
vocabulary restoration is skipped, protecting later names and reused identities.
With safe identities, later assignment edits and playlist edits each skip
independently. Query restoration requires both its recorded after-query and
playlist revision; even a later unrelated playlist action conservatively skips
that query. Existing frozen snapshot membership never changes during undo.

For vocabulary undo, restoredCount/skippedCount count journal units (identity,
assignment edge, or stored query), rather than only tracks. Delete undo preserves
its existing assignment-edge counts; restoring an unused deleted identity still
advances the annotation revision. A reused normalized name rejects delete undo
with `request_conflict`; no later identity is overwritten. Repeat undo is a no-op.

Daily durable maintenance removes action journals for expired sessions. Once a
deleted identity has no remaining delete recovery journal, its display spelling
is erased to a fixed private tombstone label. UUID tombstones remain solely to
keep deleted stored references invalid; they cannot be searched or recovered in
another session. Disconnect purges tombstones and all journals through existing
transactional deletion/cascades. All schema additions are migration
`20261011000600_fast_tagging.sql`; runtime tables remain RLS-protected and public
RPC execution is granted only to service_role.

Synthetic checks are `deno test .../fast-tagging_test.ts` and
`node supabase/tests/database/run-fast-tagging.mjs`. The latter uses uniquely
named PostgreSQL/PostgREST containers on a private Docker network, no host ports,
and finally cleanup. Integrated stage10 UI, common gates, hosted deployment/live
assertions, and actual phone/tagging-speed acceptance remain separate work.
