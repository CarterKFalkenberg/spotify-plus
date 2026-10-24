# Adding tags without restarting the library

Research date: October 24, 2026. Status: recommendation for discussion, **not an accepted implementation plan**. Repository baseline: `74585053e5f6f41f47f5616da2c13cc63c7cf0f0`. No real library content was inspected or sent to a model. All examples and workload calculations below are hypothetical.

## Decision

Build a focused **Find songs for this tag** workflow before investing in automatic musical classification. Combine user-selected candidate groups, bulk confirmation, a fast Yes / No / Later review, and persistent progress for each tag. Offer saved rules separately where the user actually means an exact definition.

The important product change is that a new tag becomes useful before its whole-library coverage is complete. Do not reset the general untagged queue or imply that an already-tagged song has been assessed for every future tag. Do not require a complete vocabulary upfront.

This can reduce repetitive decisions and concentrate effort. It cannot reliably infer a brand-new subjective feeling from song titles, or promise to find every matching song without broader review. No measured time saving for this app has been established by this research.

## Why the problem has several different answers

| Kind of new tag | Hypothetical example | Most suitable approach |
| --- | --- | --- |
| A name for an existing combination | `evening drive` means `driving AND mellow AND NOT sleepy` | Save a reusable query; avoid assigning another redundant tag to every song. |
| Existing personal curation | A playlist already contains songs chosen for running | Select that source as candidates, inspect it, then explicitly bulk-apply the tag. Use a live rule only if membership is intended to be authoritative. |
| A genuinely new musical judgment | `warm but melancholic` | Review candidates from relevant playlists/tags, then deliberately explore outside those groups. Existing metadata is only a clue. |
| A private association | `reminds me of that summer` | Personal examples, memory and listening. Public genre data cannot supply an association only the user knows. |

A broad tag that applies to half the library also has a different effort profile from one with 30 matches. Ranking saves most work when many unrelated songs can be postponed. There is no evidence supporting one universal seed count or review budget.

## Alternatives considered

| Approach | Where it saves work | Main failure / tradeoff | Recommendation |
| --- | --- | --- | --- |
| Re-review all songs for every tag | Simple and exhaustive under a stable definition | Repeated effort proportional to library size | Retain as an optional coverage pass, never the mandatory default. |
| Filters, groups and bulk actions | One decision can cover many known matches | Group membership does not prove a subjective tag | First step; extend into a dedicated new-tag session. |
| Saved Boolean queries | Eliminates redundant assignments when the definition is exact | Cannot discover information absent from existing tags | Offer for combinations, alongside ordinary flat tags. |
| Playlist/tag rules that maintain assignments | Handles future matches without repeated manual work | Removals, overrides, rule changes and cycles need explicit semantics | Separate later decision; start with explicit one-time bulk application. |
| Feedback-driven candidate ranking | Can put likely matches ahead of unrelated tracks | Needs informative features; can hide entire types of matches | Promising conditional research, not a justified ML implementation today. |
| LLM judging imported names/artists/playlists | Flexible language and possible world knowledge | Spotify AI-ingestion restriction; subjective mismatch; omissions and false matches | Do not use on the imported library under current terms. |
| Community metadata enrichment | Public genres/tags can provide candidate hints | Coverage, version matching, external disclosure and rate limits | Optional later investigation; not the core answer. |
| Audio embeddings / automatic mood classification | Potentially useful musical signal | No authorized Spotify audio-analysis path for this app; model ingestion restriction | Exclude for this Spotify-backed design. |

### What existing products and research establish

Apple's [Smart Playlists](https://support.apple.com/en-euro/guide/music/mus1712973f4/mac) demonstrate persistent, automatically updated rule-based collections. This is a useful precedent for a saved definition, not evidence that rules can discover a new feeling. Our existing generated Spotify playlists remain snapshots; introducing saved local queries must not silently make those outputs live.

[Active-search research](https://arxiv.org/abs/1206.6406) explicitly distinguishes finding members of a class from minimizing a classifier's general error. For this product, the useful objective is confirmed matches per minute, with acceptable missed matches. [Continuous active learning](https://arxiv.org/html/1504.06868) provides evidence for repeatedly using relevance judgments to prioritize likely positives in document review. Its text-retrieval results do not establish accuracy for music or permission to process Spotify data.

[Prodigy's annotation workflow](https://prodi.gy/docs/text-classification) illustrates binary feedback and uncertainty sampling. Showing only ambiguous examples is not necessarily the best way to fill a music tag quickly. If model-assisted ranking ever becomes permitted, favor likely positives with some exploration; use uncertainty selectively to clarify boundaries. [Batch active-learning research](https://research.google/pubs/batch-active-learning-at-scale/) warns that large batches reduce adaptation and can contain redundant examples. A small batch size is a prototype choice, not a proven optimum for this app.

[Research on music few-shot tagging](https://arxiv.org/html/2409.07730v2) reports competitive aggregate results using pretrained audio features and limited labels. It does **not** demonstrate that a handful of examples resolves an arbitrary personal tag from metadata. Authorized audio/features and task-specific evaluation are essential missing prerequisites here.

A directly relevant [2026 LLM music study](https://aclanthology.org/2026.nlp4musa-1.7.pdf) tested ranking 40 supplied candidates, with or without three example tracks. Examples alone outperformed naming the listening intent in its experiment. It used proxy intent labels derived from playlists, older small models, and strict string matching. Some outputs did not match supplied candidates; formatting can account for some mismatches. This supports testing examples rather than relying on a tag name, but proves neither personal-tag correctness nor whole-library recall, and grants no platform permission.

## Spotify and cost constraints change the recommendation

The current [Developer Policy, III.14](https://developer.spotify.com/policy) and [Developer Terms, IV.2.1](https://developer.spotify.com/terms) prohibit training **or otherwise ingesting Spotify Content into an ML/AI model**. The terms' definition includes metadata, playlists and user data. This is broader than the historical brief's training-only prohibition and its inference gray-area note. Design to the current restriction: inference-only, a local model, embeddings, or a no-training API setting do not resolve it.

An AI that only helps articulate a user-authored tag definition, without library content, is a different proposal. It still requires an accepted product/cost decision and does not itself tell us which songs fit. Do not treat user permission, opaque IDs, or independently sourced enrichment as an automatic policy exemption for a Spotify-derived modeling pipeline. Seek explicit platform clarification before such a pipeline.

Spotify also [removed Recommendations, Audio Features and Audio Analysis access for new/development use cases](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api). Do not build a plan around obtaining energy, valence, tempo or audio embeddings from those endpoints, or processing the SDK stream.

[Last.fm track tags](https://www.last.fm/api/show/track.getTopTags) and [MusicBrainz tags](https://musicbrainz.org/doc/Folksonomy_Tagging) are genuine alternative data sources. Their labels reflect other people's classifications. Lookup would disclose identifiers/names externally and require separate matching, licensing and platform-policy assessment. MusicBrainz's [API](https://musicbrainz.org/doc/MusicBrainz_API) is free for noncommercial use and generally limited to one request per second: 2,000 individual lookups alone take at least about 33 minutes, before retries/matching. Enrichment must be background work, not a blocking tag-creation step. No credentials or external library lookups were used for this research.

The recommended first step needs no paid inference or new data provider. Reuse bounded cached database operations. Remaining within Free quotas still requires implementation measurements; this report makes no new usage guarantee.

## Proposed experience

1. Create a tag normally, then optionally choose **Find songs for this tag**. An optional sentence explains its meaning; examples can help the person establish boundaries without any model.
2. Choose candidate groups explicitly: relevant source playlists, existing tags or tag combinations, artists/albums, or the whole library. Display counts and allow overlapping groups without duplicate review. Do not switch global Sources settings just to narrow this session.
3. Inspect the group and bulk-confirm when the group genuinely fits. Otherwise review a compact list with **Yes / No / Later**, keyboard access and optional explicit listening. Keep the target tag visible and apply only user-confirmed additions.
4. Persist decisions so resuming does not repeat rejected songs. Permit changing one's mind and undo. A new tag's progress is independent of all other tags and of the existing untagged queue.
5. Offer **Explore outside these groups** and a random sample of unreviewed songs. This counters narrow starting choices; it is not proof of completeness. Stop whenever enough useful matches have been found; resume later.
6. On future arrivals, allow reviewing new eligible songs against selected tags. Avoid producing a mandatory songs-times-tags backlog. A confirmed source removal makes a song ineligible, preserving its tags and review history under the existing removal/return policy.

The UI might say “Added 42 · Reviewed 160 · 1,840 not reviewed.” These are illustrative counts. Never turn an empty candidate list or a low score into “all done.”

Recognition is easier than recalling all relevant songs from memory; [NN/g's recognition guidance](https://www.nngroup.com/articles/recognition-and-recall/) supports showing candidate choices. It is a usability rationale, not a measured speedup for this task.

## Semantics that prevent repeated work and silent errors

- **Separate assignment from review:** assigned, explicitly does-not-fit, and unreviewed are different facts. Later remains unresolved. Merely lacking a tag, skipping a song or navigating away is never a negative judgment.
- **Scope negative judgments to the tag's meaning:** cosmetic renames can retain progress. A changed meaning needs an explicit reopen/reset option. Never erase confirmed assignments as part of that reset.
- **Use existing deduplicated song identity:** aliases do not create duplicate questions. Merges union positives; conflicting review decisions should become unresolved instead of silently suppressing a song. Preserve source independence and existing undo guarantees.
- **Keep rules distinguishable from manual decisions:** a one-time bulk application does not retract tags on later playlist removal. A live definition recomputes its results and needs documented exceptions. If persistent derived tags are later chosen, define exclusion/include precedence, provenance, cycle prevention and rule-edit behavior before building them. Flat user tags remain flat.
- **Missing is not false:** a query using NOT against a sparsely tagged library means absence of an assignment, not a confirmed musical property. A rule cannot recover information that was never annotated.
- **Preserve product semantics:** no Spotify writes from candidate review, no autoplay or audio capture, no change to generated-playlist snapshots, no new hierarchy, and no silent model assignments.

At the inspected baseline, `LibraryFilter` supports membership, search, untagged/new, artist, album and decade; Boolean tag queries and independent source memberships exist elsewhere. Source-specific and arbitrary tag-combination review filters, persistent per-tag negatives, and saved reusable local queries are **proposed additions**, not claimed existing features. Relevant code: `supabase/functions/_shared/contracts.ts`, `app/src/Library.tsx`, `app/src/Queue.tsx`, and `supabase/functions/api/library.ts`.

## How to decide whether it actually solves the problem

First test the workflow without ML. Compare sequential review, today's filter/bulk workflow, and the proposed session on several different tag types: an exact combination, a playlist-backed tag, a broad musical judgment and an idiosyncratic association. Use comparable disjoint groups/counterbalanced order to reduce learning effects; one user's findings are product evidence, not a general population claim.

Measure total setup-plus-review time, confirmed useful matches per minute, corrections, listening time and fatigue. Also measure missed matches: faster tagging with poor coverage is not success. Temporarily hiding known assignments in an isolated evaluation copy can test recovery of known positives, holding seed examples out of evaluation. Existing assignments are incomplete ground truth; their recovery cannot establish total recall or make unlabeled songs true negatives. The actual subjective judgments must be made by the user, kept out of model context; report only aggregate results.

A proposed decision target is at least 50% less review time while recovering at least 90% of held-out known positives across several tag types, with no loss of manual assignments. These thresholds are suggested tradeoffs to discuss, not measured outcomes or accepted requirements. A new subjective tag requires independent human judgments to evaluate honestly.

[Stopping-rule research](https://arxiv.org/abs/2108.12746) shows that valid recall guarantees need a designed sampling procedure; “the last 20 were No” is not one. A representative audit of the remainder can reveal missed groups, but zero matches in a small sample does not prove none remain. Offer optional exhaustive review when completeness matters, otherwise retain an honest unreviewed remainder.

For scale only: 2,000 decisions at an assumed 3–5 seconds each is 100–167 minutes. Narrowing to 200 decisions would be 10–17 minutes **if** the groups contain enough desired matches, plus setup and listening. This arithmetic illustrates the opportunity, not a predicted saving.

## Recommended sequence and unresolved decision

Start with candidate filters, explicit bulk moves and persistent per-tag review. Add saved query definitions where they genuinely remove redundant tagging. Defer live assignment rules and ML until the simpler workflow has been evaluated.

The central product choice is whether a new tag must exhaustively classify the whole library before it is useful. I recommend **useful immediately, progressively enriched, coverage visible**. For a truly novel subjective tag with no informative existing organization, substantial review remains unavoidable. This recommendation changes the burden and stopping point; it does not claim that missing information can be inferred for free.

No application code, accepted decisions, production data or deployment changed in this research.
