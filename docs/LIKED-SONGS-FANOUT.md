# Liked Songs playlist review

Accepted November 21, 2026 after the human-led grill-with-docs interview begun November 15. The user confirmed the consolidated design, including Undo limitations: **“yes, this captures what I want.”** Tracked in [issue #83](https://github.com/CarterKFalkenberg/spotify-plus/issues/83). This is an accepted specification; implementation, deployment and live verification remain outstanding. It does not itself authorize operator mutations of the real library for testing.

## Purpose

The user likes new songs before having time to decide which playlists they belong in, sometimes leaving them liked while deciding whether they truly like them. Review the backlog oldest-liked first, choose existing destination playlists, and unlike each track once handled. The user expects this to become their most-used workflow. Keep tagging intact; possible future retirement is context, not a requested change.

## Accepted answers

- **Q1 — Done:** Select the destination playlists, then explicitly press Done. Unlike only after all selected playlist additions succeed. If an addition fails, retain the like and keep the review incomplete.
- **Q2 — Other outcomes:** Skip for now keeps the track liked for later review. Discard unlikes it without adding it to any playlist.
- **Q3 — Creation:** Choose existing playlists. Playlist creation is separate from this workflow.
- **Additional human requirement — Destination configuration:** Persist a selection of playlists to offer during review. Do not show every playlist as a destination option; many existing playlists are effectively archived for the user. This describes their usage, not a new Spotify archive status.
- **Q4 — Initial selection:** Start with no configured destinations; the user explicitly selects the playlists they maintain.
- **Q5 — Skip duration:** A skipped track stays out of the remainder of the current review session and becomes eligible in the next session. Q15 defines the session boundary.
- **Q6 — Eligibility and order:** Include all currently liked tracks with no minimum age, ordered by when they were liked, oldest first.
- **Q7 — Existing membership:** Show Already added for a track already in a configured destination. Do not add another copy or offer removal through this workflow. Done can finish a track already present everywhere the user wants it.
- **Q8 — Listening:** Reuse the tagging queue's optional in-page listening behavior: Play starts one-third into the track, plays 20 seconds, and Play more continues. Never automatically start the next track.
- **Q9 — Track identity:** For now, review each liked Spotify track separately. Add and unlike only that specific version, even if another liked track represents the same song.
- **Q10 — Interrupted selection:** Persist unfinished destination selections across closing and reopening the app. They remain a draft; selecting playlists sends no Spotify writes before Done.
- **Q11 — Discard confirmation:** Require a quick confirmation before Discard unlikes a track. Done retains its single explicit click.
- **Q12 — Ownership:** Only playlists owned by the user can be destinations. Exclude collaborative playlists owned by someone else.
- **Q13 — Sources independence:** Use the Liked Songs backlog and its own destination configuration regardless of enabled tagging Sources. Selecting a destination does not automatically enable it as a Source.
- **Q14 — Generated playlists:** Exclude app-generated tag-query playlists from destination options, even when owned by the user; regeneration and expiry would conflict with independent curation.
- **Q15 — Session boundaries:** Closing and reopening resumes the same review session, including skipped tracks remaining set aside. Explicit Start new session makes skipped tracks eligible again. Unfinished playlist selections remain saved.
- **Q16 — Devices:** Optimize the complete workflow for both phone and desktop. The user expects to use the phone more; desktop-first optimization was explicitly rejected.
- **Q17 — Destination count:** Expect approximately 10–20 configured destination playlists.
- **Q18 — Engineering ownership (November 21):** The user expects standard software engineering practices, including idempotent behavior and recovery without duplicate successful additions. The agent owns retries, reconciliation and failure recovery; do not ask the user to approve ordinary engineering safeguards. This answer does not separately settle every proposed product interaction for dropping failed destinations.
- **Q19 — Undo (November 21):** The user accepted Undo for the most recently completed track. After Done, restore its liked membership and reverse only playlist additions made by that action, preserving preexisting memberships. After confirmed Discard, restore its liked membership. Safe recovery is an engineering responsibility. Spotify's restoration and concurrent-change limits must be verified before promising exact reversal, including the original liked date; no arbitrary Undo time limit has been agreed.
- **Q20 — Entry point:** Make this review workflow the default screen when opening the app. Keep tagging accessible in navigation.
- **Q21 — Placement and decision granularity:** Follow Spotify's default playlist placement. The user explicitly considers this level of question too specific; choose conventional interaction details without further interviews, reserving questions for meaningful product choices.

## Consolidated product contract

Open the app to a focused review of the Liked Songs backlog, one exact Spotify track at a time, oldest-liked first, with no minimum age. Optimize both phone and desktop, expecting phone to be used most. Retain the existing tagging workflow and its data. Review eligibility and destination selection are independent of tagging Sources.

On first use, configure the existing owned playlists offered as destinations; the selection starts empty. Expect approximately 10–20 enabled destinations. Exclude app-generated tag-query playlists. Playlist creation stays separate. Show current membership as Already added; ordinary selection cannot remove a track from a playlist.

Choose any additional destinations and press Done. Confirm all requested memberships before unliking the track. A track already present everywhere desired can be completed without new additions. Skip for now keeps it liked and sets it aside for the current session. Discard requires confirmation and unlikes without adding anywhere. Undo covers the most recently completed track, restoring the like and reversing only additions attributable to that completed action, subject to the documented limitations below.

Selections remain saved drafts until Done. Closing and reopening resumes the session and its drafts; skipped tracks return on explicit Start new session. Optional listening follows the existing queue's one-third start, 20-second preview and Play more behavior, with no automatic next-track playback.

## Implementation-owned interaction and recovery choices

These implementation choices complete the accepted design under the user's instruction to own ordinary detail decisions. They are not verbatim human answers and may be refined while preserving the product contract:

- Use directly tappable destination choices, recognizable playlist identity, and accessible persistent review actions on phone. Support efficient keyboard operation on desktop. Keep the track and listening controls prominent; make destination configuration reachable from review.
- Advance after successful completion, confirmed Discard or Skip, without starting audio automatically. Start each new track without copying another track's selections; restore its own saved draft when present. When no desired membership exists, use Discard rather than treating an empty selection as Done.
- Follow Spotify's default insertion position without a new setting. Current documentation specifies append when position is omitted.
- Persist unfinished operations and reconcile their outcomes across interruption, retries and multiple devices. Preserve successful additions and the like when completion is unresolved. Never turn a timed-out response into either assumed success or a blind repeated append.
- Keep the most recent completed action available to Undo until superseded by another completed action, without an arbitrary toast countdown. Restore that track for correction after Undo; report any incomplete reversal honestly. Revalidate relevant configuration, ownership and membership before mutations, and preserve unrelated external edits.
- If a playlist addition cannot safely be attributed to this action, leave it intact and explain that playlist reversal could not be completed. Do not remove possibly external additions to simulate a successful Undo.
- A definitively failed operation may Return to review after its worker stops, preserving its like, saved draft and acknowledged additions. This includes a failed final verification round only when a durable server flag proves no unlike intent has ever been committed; retries never clear that flag. The user can then deliberately edit the draft. Unconfirmed dispatched additions remain reconciliation-only; a lease expiry cannot prove a remote request finished. Cancellation does not erase action receipts or reverse playlist contents.
- Unavailable tracks or destinations remain visible with an actionable explanation. Do not silently discard a track or drop a selected destination. Routine failure recovery, batching, pacing, concurrency protection and idempotent application behavior are engineering responsibilities.

## Verified documentation and remaining live proofs

Official Spotify references inspected November 21, 2026; no live account calls were made:

- [Add playlist items](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist): current route is POST /playlists/{playlist_id}/items. Omitting position appends. No idempotency key or add-if-absent condition is documented. An application ledger alone cannot make an ambiguous remote POST idempotent.
- [Save library items](https://developer.spotify.com/documentation/web-api/reference/save-library-items): PUT /me/library supports track URIs but documents no original liked-date input. Therefore exact restoration of Spotify's original liked date/order cannot be promised. This is a limitation inferred from the documented contract, not proof that re-liking always changes the date.
- [Remove playlist items](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist): the current schema documents URI-based removal and a snapshot ID, without a stable occurrence identifier or a positions field. Its snapshot description permits application despite later changes. Do not treat it as an atomic version precondition or assume universal exact-occurrence reversal under concurrent edits.

Verify ordinary and duplicate-track removal, interrupted writes, liked-date behavior and concurrent-edit safety in controlled authorized proofs before shipping. Preserve the user's intent while reporting limitations; tests and docs must not claim guarantees unavailable from the remote contract. Actual real-library content remains outside model context. Any new live mutation proof still needs its applicable scoped authorization; this interview performs none.

## Fresh review confirmations

Observed Spotify responses can retain a playlist metadata snapshot after an acknowledged append changes the item sequence. A ready playlist cache is therefore never a freshness proof. Done and Undo admission fence older background review checks and clear affected scan checkpoints; append intents/results and removal reconciliation also invalidate them. Critical confirmations read the complete item sequence again, checking item-page totals consistently and validating observed coverage. Playlist metadata totals are not item coverage proof. A changed metadata snapshot remains an invalidation hint; an unchanged snapshot does not establish a snapshot-consistent walk. Equal-count edits during pagination can still escape these checks.

After additions are reconciled, Done starts a durable final verification round with a server-owned start timestamp. Each selected destination must complete a fresh present-membership observation in that round before unlike intent or authorization. The round spans bounded invocations without a rolling freshness timeout: otherwise twenty slow playlists could continually expire the earliest read before the last finishes. An uncertain unlike first checks liked membership; another dispatch requires a new round with cleared observations. The round is a sequential verification pass, not an atomic remote snapshot. External edits after an individual read can still race the eventual unlike; leases and scan checkpoints cannot fence Spotify edits.

## Bounded Undo implementation boundary

The candidate implementation attempts playlist reversal only for a confirmed app append, originally admitted after verified absence, when a fresh complete read finds exactly one matching URI. It targets the exact persisted append acknowledgement as a historical removal version; read-side metadata snapshots need not match that receipt. Fresh owner identity and a service-only capability bind the exact configured, available, owned non-generated playlist, track URI, append receipt and current Undo operation. A changed metadata snapshot between the membership observation and final ownership read fails closed as an instability hint; matching read snapshots do not prove an atomic walk. Preexisting memberships, unconfirmed appends, missing append receipts, duplicates and unavailable destinations remain intact and produce an incomplete-reversal result. The like is restored and verified before any playlist removal; original Spotify liked-date restoration remains unsupported.

Each removal has a durable send intent. Reclaimed or ambiguous removals enter read-only reconciliation and are never dispatched again. A successful HTTP acknowledgement alone cannot finish reversal: a subsequent complete read must show that URI absent. Confirmed append and removal snapshot receipts remain separate. These are local recovery guarantees; Spotify's documented snapshot parameter allows application despite later edits and provides no atomic version precondition. An edit after the last read can still race the dispatch. The exact-URI removal contract and subsequent absence check do not claim that all unrelated content was verified against a full baseline. Controlled live attribution proofs must separately establish ordinary unique removal, preservation of an unrelated-edit sentinel, and preservation of a replacement added after the original was removed. Final live attribution evidence remains pending orchestrator confirmation; this candidate must not ship on synthetic evidence alone. Synthetic tests and this bounded implementation do not establish live Undo acceptance or guarantee preservation under arbitrary concurrent Spotify edits.

## Acceptance

- From the default screen on phone and desktop, configure owned destinations and review an oldest-first exact-track backlog using Done, Skip, confirmed Discard and most-recent Undo.
- Existing destination memberships remain intact and retries do not deliberately repeat confirmed additions. Unresolved or failed additions never trigger unliking or false completion.
- Draft choices, sessions and in-flight work survive interruption. Sources configuration does not change review eligibility, and review destination choices do not change Sources settings or annotations.
- Listening retains the accepted optional behavior and lifecycle. Tagging continues to work.
- Synthetic verification covers these behaviors, interruption, stale clients, external changes and the narrow write guards. Authorized live proof establishes actual Spotify contracts separately. Final phone/desktop usability acceptance remains with the user.

## Accepted scope amendments

These explicit product choices require narrow changes to existing contracts; they are not permission to loosen guards generally:

- The original brief and saved-library guard prohibit track liking and unliking. This workflow needs unliking for successful Done and explicit Discard, plus narrowly scoped re-liking to undo the most recent completed action. General-purpose liking remains outside the requested scope.
- Existing playlist item writes are limited to app-managed generated playlists. This workflow needs additions to explicitly configured existing destinations owned by the user, preserving their existing contents, and narrowly scoped removal of this action's additions during Undo. Exclude app-generated tag-query playlists from destinations. Undo is the accepted exception to Q7's prohibition on playlist removal; ordinary review selection still cannot remove existing memberships.
- The optional playback exception currently names the tagging queue. Q8 extends that behavior to this review workflow; existing consent, token confinement and lifecycle constraints still apply.
- Existing tagging groups tracks into logical songs and uses dates from enabled Sources. This backlog instead reviews specific liked tracks by their Liked Songs dates, independently of enabled Sources. Destination selection does not enable a Source.

Retain privacy constraints, annotations and independent source memberships, the free-hosting boundary, external-action authorization checks and reviewed PR delivery. No Spotify mutations have been performed for this interview.

## Delivery status

Shared understanding is confirmed. API proof, runtime write guards, persistence, UI, synthetic verification, deployment and live verification are subsequent engineering work. This documentation change neither enables the workflow nor relaxes the current runtime guards. Actual phone/desktop usability acceptance remains pending after software delivery.

## Provenance

Owner: this interview's orchestrator. Documentation issue: [#83](https://github.com/CarterKFalkenberg/spotify-plus/issues/83). Isolated branch: `codex/liked-songs-fanout-design`. Original recorded review base: `2e9b5c8ad2627a6cdd3c4307772af02df9bfde29`. Review and delivery evidence belongs in that issue and the documentation PR. No implementation milestone is completed by this specification.
