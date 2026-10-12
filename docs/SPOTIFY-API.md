# Spotify API contract notes

Checked against official documentation on October 10, 2026. No authenticated Spotify request has been made in this session. **Documented** and **live verified** are separate statuses. The first build stage must record redacted real-response evidence.

## Changes to the supplied brief

- `external_ids`, including track ISRC, was restored in March. We still omit it because the MVP does not need it. [March changelog](https://developer.spotify.com/documentation/web-api/references/changes/march-2026).
- Use `account_id` for durable owner binding. It was added in May and is immutable; the older user `id` remains useful for API ownership and the one-time bootstrap check. [May changelog](https://developer.spotify.com/documentation/web-api/references/changes/may-2026).
- July increased the developer's Client ID limit to 25 and moved quota counting to shared developer-account buckets. Quota exhaustion can be identified by `error.reason = QUOTA_EXCEEDED` on 429. The numerical budget/reset schedule is not documented. [July update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates).
- The 2024 announcement specifically described loss of preview URLs in multi-get SimpleTrack responses. Do not expand that wording into proof that every possible preview field is universally absent. The MVP deliberately relies on no previews, audio features, analysis, recommendations or related artists. [2024 announcement](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api).
- Removing a playlist means unfollowing/removing it from Your Library. It is not permanent destruction of the Spotify playlist object; its URL or other followers may remain. Verify library absence, not a 404. [Playlist behavior](https://developer.spotify.com/documentation/web-api/concepts/playlists).

## Supported endpoint contract to implement

All API paths below are relative to `https://api.spotify.com/v1`.

| Purpose | Current route | Limit / behavior | Source |
| --- | --- | --- | --- |
| Owner identity | `GET /me` | Require returned `account_id`; do not depend on email/country/product | [Profile](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile) |
| Liked Songs | `GET /me/tracks` | ≤50/page, offset pagination, `total`, `added_at`, track metadata | [Saved tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks) |
| Request hidden publication | `POST /me/playlists` | Explicit `public:false`; do not use `/users/{id}/playlists` | [Create](https://developer.spotify.com/documentation/web-api/reference/create-playlist) |
| Add playlist items | `POST /playlists/{id}/items` | ≤100 per request, ordered; POST is not idempotent | [Add](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist) |
| Replace playlist items | `PUT /playlists/{id}/items` | ≤100; clear/replace, then append remaining chunks | [Replace](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items) |
| Read ordered playlist | `GET /playlists/{id}/items` | ≤50/page; current response uses item naming, verify actual wrapper | [Read](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items) |
| Name/description metadata | `GET /playlists/{id}`, `PUT /playlists/{id}` | Write only description after creation; preserve user name | [Change details](https://developer.spotify.com/documentation/web-api/reference/change-playlist-details) |
| Saved membership | `GET /me/library/contains?uris=...` | ≤40 URIs; use for removal reconciliation | [Contains](https://developer.spotify.com/documentation/web-api/reference/check-library-contains) |
| Remove generated playlist | `DELETE /me/library?uris=spotify:playlist:...` | ≤40 URIs; adapter permits only app-managed playlist URIs | [Remove](https://developer.spotify.com/documentation/web-api/reference/remove-library-items) |

The migration guide still contains some superseded field/app-limit statements and the endpoint reference can retain legacy schema fields. Follow dated later changelogs and validate actual responses rather than generating a broad client blindly from a schema. New applications are subject to the narrower dev-mode surface. [Migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).

### Empty playlist-items pagination — October 11, 2026

The current [playlist-items reference](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items), read on October 11, describes the response `limit` as the maximum set by the request or default. The orchestrator's redacted live diagnostic for [issue #32](https://github.com/CarterKFalkenberg/spotify-plus/issues/32) nevertheless observed HTTP 200 for a newly created disposable playlist requested with `offset=0&limit=50`, returning `total:0`, `offset:0`, `limit:0`, `items:[]`, and `next:null`. Strict limit equality prevented the creation job from reaching population after it had recorded the remote playlist ID.

The adapter therefore accepts a zero response limit only for that empty first, terminal playlist-items page. It retains the actual returned limit and requires the requested offset to match. All other pages still require an echoed limit, bounded item counts, and validated same-endpoint next URLs. Saved-track and playlist-collection contracts and every write guard remain unchanged. Synthetic adapter negatives and a runner/real-adapter transport regression cover creation, this empty read, population, and full ordered verification; authenticated recovery and deployed proof remain the orchestrator's responsibility.

### Playlist description response escapes — October 11, 2026

For [issue #35](https://github.com/CarterKFalkenberg/spotify-plus/issues/35),
the orchestrator's read-only, redacted live observation reported a description
length of 247, an exact opening app marker, no exact closing marker, HTML
entities, and an encoded slash (`&#x2F;` or `&#47;`). No actual description or
playlist metadata entered model context. This supports an escaped closing marker
as the cause of failed exact confirmation followed by `description_capacity`;
it does not establish every entity variant or every user's note behavior live.

The current [GET playlist reference](https://developer.spotify.com/documentation/web-api/reference/get-playlist)
describes a nullable description; [create](https://developer.spotify.com/documentation/web-api/reference/create-playlist)
and [change details](https://developer.spotify.com/documentation/web-api/reference/change-playlist-details)
accept the description's displayed value. Read on October 11, these references
provide no explicit HTML-entity round-trip guarantee. The adapter consequently
normalizes the observed response representation into text once, on all playlist
responses (create, metadata GET, and current-user collection). It recognizes the
five XML/HTML escaping names (`amp`, `lt`, `gt`, `quot`, `apos`) and semicolon-ended
decimal/hex numeric Unicode scalar references. Unknown names and invalid scalar
references remain intact. This is escape decoding, not HTML parsing, percent
unescaping, whitespace normalization, or recursive decoding.

Descriptions sent to Spotify remain plain text. Canonical outside notes retain
exact characters, whitespace, punctuation and literal entity syntax: for example,
a literal `&amp;` note returned as `&amp;amp;` is decoded once to `&amp;`, never to
`&`. The preservation contract applies to this text representation, not Spotify's
response escape bytes. A provider response that leaves literal entity syntax
unescaped is inherently ambiguous; we do not guess by repeatedly decoding or
relaxing confirmation. Synthetic tests cover the assumed single escape layer,
numeric framing, literal entities, repeated regeneration, name preservation and
genuine description/snapshot changes. Live recovery and verification of the
round-trip contract remain the orchestrator's responsibility.

The domain replaces only the exact managed block in canonical text; it never
decodes again or truncates outside notes. Confirmation still compares exact
canonical descriptions and unchanged item snapshots. Managed-write ownership
and the saved-library write prohibition are unchanged.

### Publication command contract — October 11, 2026

The user accepted **“Hidden from profile/search is sufficient”**; manual client “Make private” is not required. See [the decision](DECISIONS.md#playlist-publication-requirement--october-11-2026). The current [playlist concepts](https://developer.spotify.com/documentation/web-api/concepts/playlists) defines `public:false` as hiding profile/search publication, while link-access privacy cannot be set through the Web API. The [change-details reference](https://developer.spotify.com/documentation/web-api/reference/change-playlist-details), reread October 11, documents explicit publication fields and an empty successful update response. Neither establishes a separate publication verification endpoint.

At revision `62729ba45c113fcd656e35f26a95a6aee803f868`, the orchestrator observed a false create response but true playlist GET and current-user collection readbacks after population, despite an accepted metadata PUT with literal `public:false`. All disposable fixtures were cleaned. This does not prove the playlist was hidden, explain the contradiction, or justify converting readback to false.

Each managed operation issues a fixed `public:false`/`collaborative:false` metadata PUT after verifying ownership and ordered contents. Even an identical disclosure requires a new successful command acknowledgement before completion. The adapter accepts only the expected success statuses; rejected, malformed-success-status and ambiguous writes remain failures and cannot make the operation ready. A later durable retry may repeat this idempotent PUT after rechecking the lease, ownership and remote state; it never replays ambiguous create/append writes blindly. Ready means content/disclosure verified and publication command acknowledged, **not independently verified profile/search hiding**. Exact canonical description, item-snapshot and strict noncollaboration confirmation remain required.

The normal metadata caller supplies only description text; the adapter adds fixed false fields and forbids arbitrary visibility or name changes. Reconciliation uses a separate publication-only fixed-false command, omitting description so current text, including null, survives without rendering scrubbed query labels. It verifies unchanged description/snapshot and owner/noncollaboration before completion. Expired incomplete reconciliation can be superseded safely after its job has no live lease; active leases, disconnected-owner checks and playlist-only removal remain protected.

Live receipts replace `privatePlaylist`/`privateSnapshot` claims with `publicationWriteAcknowledged:true`, `publicationReadbackVerified:false` and raw boolean/null `publicReadback` observations. The core receipt also reports `regeneratedPublicReadback`; these fields contain no metadata. Its acknowledgement follows exact-head worker operation completion; the API proof separately issues and acknowledges a publication-only PUT after ordered population. The isolated outside-rename helper sends fixed false fields, and regenerated contents, outside notes and name remain verified. Neither software receipts nor synthetic tests claim actual hidden state from contradictory provider responses. The user accepted actual profile/search hiding, not acknowledgement in place of that outcome. Actual hiding remains **UNVERIFIED product acceptance** until independently established or expressly waived by the user; this software contract does not narrow the requirement. Final human acceptance includes inspecting the generated playlist in Spotify for absence from the profile and search after creation/regeneration, with search absence alone recognized as nonexhaustive evidence.

## OAuth and scopes

Setup and initial implementation request exactly:

```text
user-library-read
playlist-read-private
playlist-modify-private
playlist-modify-public
user-library-modify
```

The final two are a **conservative initial cleanup grant**, not a verified claim that both are necessary for private playlist removal. The generic remove endpoint lists `user-library-modify`, `user-follow-modify`, and `playlist-modify-public`, while the scope guide still describes the classic private unfollow permission. Its per-entity requirements need the live private-playlist test. Request no follow/profile/player scopes. After proving the supported deletion scope combination, reduce unnecessary requested scope if possible and record whether reauthorization is required. Never use the granted library-write capability for tracks. [Remove reference](https://developer.spotify.com/documentation/web-api/reference/remove-library-items), [scope guide](https://developer.spotify.com/documentation/web-api/concepts/scopes).

Use PKCE and keep tokens server-side. Six-month lifetime is anchored to the authorization time; refresh-token rotation is not a new deadline. `invalid_grant` requires reconnect, not endless retries. The loopback callback is `http://127.0.0.1:3000/auth/spotify/callback`; production uses the exact HTTPS URL. `localhost` is forbidden. [Refresh](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens), [redirect rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).

Premium owner and allowlisting still apply; dev mode has up to five authorized users and suits this single-user project. A bare 403 does not distinguish missing allowlist from all other permission/account problems. Extended access remains aimed at organizations with substantial scale and is irrelevant here. [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

## Live proof checklist

Before calling cleanup supported, run code that asserts the bound `account_id`, usable `/me/tracks` fields and totals, `public:false` creation, chunk boundaries and ordered replacement, and playlist removal followed by false containment/absence from the saved playlists collection. A test may only remove its own recorded disposable playlist ID. A surviving direct URL is expected under unfollow semantics. Confirm description update limits and field wrappers empirically.

Observe saved-track ordering as a hint only. No library snapshot/delta/change-feed appears in the documented surface we reviewed. The consistency algorithm must work without assuming newest-first ordering. Reconnection, rate limiting and shared quotas require simulated contract tests plus a modest real smoke test; do not intentionally seek the platform's lockout limit. [Rate limiting](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).

No documented Web API revocation endpoint was found. Immediate local disconnection deletes credentials and stops calls; full grant revocation needs the user's [Spotify account Apps page](https://www.spotify.com/account/apps/). This is an unresolved platform capability, not a promise of programmatic revocation.

The current policy's model restriction includes ingestion as well as training. Keep actual Spotify strings/images out of AI prompts, tool outputs and screenshots. AI can work on code, public API docs and synthetic fixtures while real-data assertions return only redacted status/count evidence. Persistent minimal annotation linkage and metadata-retention numbers are product minimization choices, not Spotify-approved retention guarantees. [Developer policy](https://developer.spotify.com/policy), [terms](https://developer.spotify.com/terms).
