# Core loop contracts

[Issue #18](https://github.com/CarterKFalkenberg/spotify-plus/issues/18) freezes the
small shared interface for library, tagging, local query preview and managed
playlists. The [brief](PRODUCT-BRIEF.md), [accepted decisions](DECISIONS.md) and
[plan](PLAN.md) remain authoritative. This ticket adds types and pure validation;
it does not implement routes, transactions, sync, jobs, Spotify writes or stage
acceptance. Existing session, OAuth and disconnect routes retain their semantics.

[`contracts.ts`](../supabase/functions/_shared/contracts.ts) has no runtime imports
and can be used by the browser and Deno. Request parsers accept `unknown`, reject
unknown fields and non-JSON object shapes, and return fresh normalized objects.
`ContractError` identifies a fixed field without echoing supplied content. Response
DTOs describe explicit server projections; they are not validators for raw database
or Spotify responses. Never spread either raw source into a response. The API and
provider owners must validate those boundaries and test their projections.

## Queries and limits

Stored queries use `{version: 1, root}` with recursive nodes:

```ts
{ op: "tag", tagId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
{ op: "and", children: [/* one or more nodes */] }
{ op: "or", children: [/* one or more nodes */] }
{ op: "not", child: /* one node */ }
```

`compileQueryBuilder({all, any, none})` emits
`AND(all leaves, OR(any leaves), NOT(OR(none leaves)))`. Empty individual buckets
are omitted; an entirely empty builder fails. Duplicate IDs within a bucket are
canonicalized. A tag appearing in All and None is a valid zero-match query. None
alone matches active tracks without any excluded tag, including untagged tracks.
The exported `queryMatchesTags` defines pure truth semantics for already validated
queries; it cannot decide whether a tag still exists or a track belongs in a
library. SQL evaluation must use these semantics and separately limit membership.

| Boundary | Limit and reason |
| --- | --- |
| Query tree | Version 1, root depth 1, maximum depth 12 and 128 total nodes; bounds recursive validation and later SQL evaluation while allowing arbitrary operator nesting |
| Mobile builder | At most 64 supplied tag entries across all buckets, counted before deduplication; emitted tree fits the query budget |
| IDs | Standard UUID syntax with version 1–8 and RFC variant, canonicalized to lowercase; names are never tag identity |
| Track keys | Exactly 64 lowercase hex characters; opaque to the browser, with server-only derivation and ownership lookup |
| Revisions | Canonical decimal strings from `0` through PostgreSQL's signed bigint maximum; JSON numbers would lose precision |
| Explicit selection / acknowledgement | 1–200 distinct keys; use a filter selection for larger bulk actions, and batches for acknowledgement |
| Pages | 1–100 rows or groups; first cursor is `null`, later opaque base64url cursor is 16–512 characters |
| Search | At most 200 Unicode code points after NFC and whitespace normalization |
| Tag / playlist name | Nonempty; at most 80 / 100 normalized Unicode code points, preserving display casing, punctuation, accents, digits and emoji |

These are application limits, not claims about Spotify quotas. Input text also has
a raw UTF-16 length cap of eight times its normalized limit to bound normalization;
control characters remaining after whitespace collapse and unpaired surrogates
fail. HTTP integration retains the existing 16 KiB JSON body cap, content-type,
origin and owner checks. The caps fit an explicit 200-key action plus its wrapper.
GET handlers must reject duplicate/unknown query parameters and parse decimal
limits strictly before calling the numeric parsers; `undefined` is not a valid
substitute for an optional field's absence. JSON objects may have a null prototype;
classes, inherited data, symbols, hidden/accessor properties, sparse arrays and
array subclasses fail. No error should include raw input or provider content.

## Identity, selection and revisions

`TrackAnnotationDTO` contains only `trackKey` and `tagIds`. `TrackDTO.metadata` is a
separate nullable cache containing title, artists, album/release date, duration,
explicit flag, artwork URL, Spotify URL/playable URI, liked/removed dates and the
new-item acknowledgement date. `null` means the metadata has been purged, not that
annotations disappeared. Such records need not appear in normal browser results.
Re-liking restores the same annotation identity after metadata has expired. Null
display fields represent unavailable source values; they do not synthesize titles
or permit playlist writes. A server may return a valid Spotify deep link while the
playable URI remains null. Retained keys are pseudonymous app data and are deleted
on disconnect together with other app data, as already decided.

The library revision is `{library, annotations}`. Transactions increment `library`
for changes affecting membership, ordering, displayed metadata or generation
eligibility; increment `annotations` for assignments, tag vocabulary and new-item
acknowledgements. Avoid revision changes for a no-op. A single shared revision pair
may invalidate more pages than strictly necessary, which keeps the first loop
simple and correct. A preview and all its pages represent one such pair. Tag
editing remains available during import; initial stable completion gates playlist
creation only. An in-progress preview must visibly indicate that limitation.

Explicit selections freeze the supplied key list. Filter selections carry the
complete filter and `expectedRevision`; the mutation transaction compares both
revisions, evaluates the filter and freezes its distinct keys before changing tags.
A stale filter is rejected instead of silently selecting new arrivals. Explicit
keys still need current owner/annotation checks. Tags attach to known annotations,
including soft-removed or purged records; incoming IDs never create a new annotation.
No selection can specify a raw Spotify URI or arbitrary SQL. Adding an existing
assignment is a no-op. Undo identifies a server-recorded action and restores only
its changed edges that have not been superseded by later edits; counts distinguish
restored and skipped edges. It never accepts a client-provided previous snapshot.

The core filter is explicit active/removed membership, normalized free text,
untagged, new-only, and an optional exact Spotify artist ID. Search matches cached
track title, artist names and album locally, case-insensitively; persistence owns
the escaped/parameterized implementation. `newOnly` means unacknowledged active
additions, not the separate later queue mode for latest-sync additions. Removed +
new-only fails. Artist groups inherit the current filter and add their artist ID;
group selections carry the response revision. When an artist filter is already
set, return only that artist's group; replacing it with a collaborator's ID would
widen the selection. A multi-artist track may occur in
several groups, but selections/counts within each group use distinct track keys.
Tracks without an identifiable artist remain accessible in ungrouped search.
Group pages sort by descending group size, with artist ID as a deterministic tie;
ungrouped search and previews sort by descending liked-at then ascending track key.
Album/decade facets, further sort modes, queue and vocabulary-management operations
belong to the already required fast-tagging stage, not speculative fields here.

## Route seams

Paths are product API paths behind the existing same-origin proxy. These names
reserve interfaces, not deployed endpoints. `parseId` validates UUID path IDs.
All routes still require the existing owner session/proxy boundary; mutations also
require the existing origin check. `GET library/status` has no parameters. The
remaining GET defaults are applied by their handlers as noted below.

| Method / path | Request parser | Response |
| --- | --- | --- |
| `GET /library/status` | No input | `LibraryStatusDTO` |
| `POST /library/sync` | `parseLibrarySync`, reason `app-open` or `manual` | `LibraryStatusDTO` reflecting queued/coalesced work |
| `POST /library/search` | `parseLibrarySearch` | `LibrarySearchResponse`, either tracks or artist groups |
| `POST /library/acknowledge` | `parseAcknowledge` | `AcknowledgeResponse` |
| `GET /tags?search=&limit=20` | `parseTagSearch`; defaults empty search and 20 | `TagSearchResponse` with `hasMore` |
| `POST /tags` | `parseCreateTag` | `CreateTagResponse`, returning an existing identity on normalized-name collision |
| `POST /tag-actions` | `parseTagAction`, explicit `add` or `remove` | `TagActionResponse` with server action ID and changed count |
| `POST /tag-actions/:id/undo` | `parseUndoTagAction`, empty JSON object | `UndoTagActionResponse` |
| `POST /query/preview` | `parseQueryPreview` | `QueryPreviewResponse` |
| `GET /playlists?limit=50` (optional cursor) | `parsePageRequest`; handler defaults absent cursor to null and limit to 50 | `PlaylistListResponse` |
| `POST /playlists` | `parseCreatePlaylist` | `PlaylistMutationResponse` |
| `POST /playlists/:id/actions` | `parsePlaylistAction` | `PlaylistMutationResponse` |

No DTO contains tokens, session IDs, account IDs, owner epochs, leases, management
keys or raw provider payloads. Timestamps are UTC ISO instants. `expiresOn` is a
calendar `YYYY-MM-DD` date in America/New_York, valid through that date; null means
pinned. Retention defaults to `month` in the visible UI, but a create request must
send the user's explicit displayed value. Extend and Unpin require `week`, `month`
or `threeMonths`; Pin, Regenerate, Delete and Retry reject a retention field.
Regenerate uses the existing retention and resets its clock only on success.
Unpin starts a fresh clock. Date arithmetic and lifecycle transition checks remain
server responsibilities, including month-end clamping and DST tests.

## Obligations for integration owners

- Syntactic validation does not authorize any ID. In the transaction, verify owner
  connection/epoch, every referenced tag's existence, selected annotation ownership
  and managed-playlist identity. Deleted leaves fail explicitly, even under NOT or
  in a branch that could short-circuit. Merges rewrite stored leaves atomically.
  Tag name identity must use consistent NFC, whitespace and case normalization in
  database uniqueness and lookup; preserve the first display spelling.
- Preview uses only cached data and makes zero Spotify calls. Its full counts are
  `matchedCount = playableCount + excludedCount`; `durationMs` sums playable
  targets, and pages include matched tracks so unavailable exclusions are visible.
  All counts, rows and duration come from the same revision. Generation freezes only
  the ordered playable targets. Reject a zero-playable result rather than reporting
  creation success for an unintended empty playlist.
- Create checks stable initial sync completion, all query references and the
  preview revision in the same transaction that re-evaluates the submitted query
  and freezes membership. The revision covers both library and tag edits; neither
  it nor a browser `generationReady` value is authorization. A revision alone does
  not prove the human viewed that exact query: the UI must invalidate its preview
  on every builder change and await the matching response before enabling Create.
- Cursors are opaque server-issued tokens bound to route, normalized query/filter,
  grouping, revision and ordering; validate that binding before use. A format-valid
  token is not trusted SQL or a trusted offset. A stale page requires restarting
  the preview/search. The playlist listing similarly needs a stable cursor over
  its selected ordering and must surface stale state rather than mix snapshots.
- Playlist `expectedRevision` checks serialize actions with cleanup/regeneration.
  Client request UUIDs deduplicate durable intent transactionally: the same ID and
  same intent return the existing operation; reusing one with different input is a
  conflict. Deduplication is scoped to the connected owner and survives retries.
  Check for an existing identical request before rejecting its now-stale expected
  revision. Request IDs and saved chunk positions do not make Spotify POSTs
  idempotent; ambiguous remote writes still require marker/membership reconciliation.
- `pending` covers queued/running intent, `incomplete` preserves unconfirmed or
  partially failed work, `removing` awaits confirmed library removal, and `ready`
  means confirmed remote contents/disclosure. `trackCount` is the frozen target size;
  pending/incomplete status must not imply that every target has reached Spotify.
  Never turn an ambiguous response into
  success. An unknown Spotify URL stays null until confirmed; Retry operates on the
  recorded target. List status includes last successful cleanup and any blocking
  reason so a paused/quota-limited backend cannot appear current.
- A playlist mutation responds with the durable operation, ordinarily HTTP 202;
  confirmation comes from later list state. Contract failures map to 400; missing
  tags to an explicit `unknown_tag` 409; stale revisions/cursors to `stale_revision`
  409; unstable initial import to `initial_sync_incomplete` 409; an empty playable
  result to `no_playable_matches` 409. Existing authentication errors stay intact.
  Handlers must not serialize raw thrown errors or provider bodies.

Provider integration must preserve current Spotify names and non-Tagger description
text after creation, hardcode private creation, and preserve the playlist-only
library-write guard. Official [saved-track fields](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks)
and [create-playlist fields](https://developer.spotify.com/documentation/web-api/reference/create-playlist)
were checked October 11, 2026; the latter still defaults `public` to true, so privacy
must be explicit server behavior. No live Spotify assertion is part of this ticket.
Full integrated checks await the API/tooling ticket; milestone acceptance still
requires deployment, redacted live evidence and the user's later phone/speed trial.

## Library implementation (issue #19)

Migration `20261011000400_library_annotations.sql` and the library API/worker now
implement the library routes above. Product URLs include the existing `/api`
prefix (for example `/api/library/status`). The worker uses the guarded adapter's
`GET /me/tracks` at 50 items per page; the official saved-track and immutable
`account_id` references were checked again on October 11, 2026. This is a source
contract check, not live account evidence.

The shared SQL seam is `app.require_owner(epoch, connected := false)`, which
locks the account then library state. Transactions for playlist creation must
pass `true`, check `initial_sync_complete`, compare `app.library_revision()` and
call `app.query_targets(query)` within that lock. Targets return `track_key`,
nullable `playable_uri`, `liked_at` and `duration_ms`, ordered by liked date
(descending) then key. Preview includes unavailable matches; playlist writes must
freeze only non-null playable URIs in that same deterministic order. The evaluator
validates all referenced tag IDs, including branches whose truth could otherwise
short-circuit. `app.tags.name` is the preserved display spelling. Identity and
lookup both use PostgreSQL NFC normalization and lowercase, independent of display.

Each connected epoch stores its own random HMAC key, encrypted with the runtime
`ANNOTATION_KEY` wrapping key and authenticated context `annotation-key:<epoch>`.
Only leased library workers can initialize/read its ciphertext. Track identifiers
are HMACs under that random key. Disconnect deletes that ciphertext together with
annotations; retaining a deployment wrapping key does not retain the deleted
account's annotation identity. The next epoch gets a new random key. Backups must
include the per-account annotation key under their existing encryption if they
restore annotation identities; the later backup/restore ticket owns that extension.

A page transaction saves its metadata and exact resume position together. A
completed pass is eligible for comparison only when totals stayed consistent,
received and distinct identifiable counts match the total, and no duplicate or
unidentifiable entries occurred. Two adjacent eligible passes must have identical
key/liked-at sets. Null/identity-less source entries stay unresolved and prevent
completeness claims; identified unavailable/local tracks remain browsable and
excluded from playable results. Continuous mutation can postpone verification.
Annotations remain editable while the worker retries. A worker processes at most
ten pages with a deadline reserve; durable SQL jobs resume later through cron.
No browser or permanent process is required.

App-open hints debounce for 15 minutes and compare the first page plus total.
Manual sync and the 24-hour maintenance backstop always walk the whole library.
Stable runs soft-remove missing metadata without deleting annotations. Maintenance
purges removed metadata after 90 days; re-import reconnects it to the retained
HMAC identity. Acknowledgement is explicit, and `added_run_id` preserves the later
fast-tagging queue's latest-sync additions separately from the unread badge.

Pagination tokens are random server records bound to epoch, route, normalized
filter/query/grouping, both revisions and a 30-minute expiry. They contain no SQL
or trusted client offsets. Tag actions freeze explicit keys or a revision-checked
filter inside one transaction. Assignment tombstones carry edit versions, so undo
restores only actually changed edges that have not been edited later. Undo is
bound to the originating authenticated session and retained for 24 hours. Queue
navigation, album/decade facets, extra sort modes and vocabulary rename/merge/delete
remain required fast-tagging work; this backend does not declare those delivered.

Synthetic evidence lives in `supabase/tests/database/library.sql`, the library
worker/API tests, and the existing guarded transport tests. Integrated deployment,
real-response assertions, backup extension and complete stage acceptance remain
with the orchestrator; this bounded backend ticket alone cannot satisfy them.
