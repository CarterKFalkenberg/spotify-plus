# Disposable review Undo contract experiment (#88)

Only the orchestrator runs `scripts/live/review-proof.ts`. This is an operator
experiment, separate from deployment/stage verification. It does not enable the
review feature or satisfy its live acceptance. It never changes Liked Songs,
existing user playlists, annotations, tags, app destination settings or app SQL.
The sole fixture is a newly created, registered disposable playlist named
`Tagger API test review <operation UUID>`, within the configured test-playlist scope.

On November 21, 2026 the official current
[remove items contract](https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist)
specified `DELETE /playlists/{playlist_id}/items`, `items:[{uri}]` and optional
`snapshot_id`. Its schema supplies neither occurrence identifiers nor positions.
Its historical-snapshot wording allows applying changes after newer edits; it is
not a compare-and-swap contract. The
[add contract](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist)
returns a snapshot after appending. These documents do not establish which
same-URI occurrences a live historical-snapshot deletion preserves.

The helper privately reads exactly two distinct usable cached track URIs through
read-only management SQL. It uses four small cases in one disposable playlist,
replacing between cases. Each replacement is acknowledged and read back with the
same snapshot before proceeding:

| Case            | Acknowledged baseline | Later acknowledged edit | Removal request      | Desired changed-only observation |
| --------------- | --------------------- | ----------------------- | -------------------- | -------------------------------- |
| Unique          | A                     | none                    | A, baseline snapshot | empty                            |
| Duplicates      | A, A, B               | none                    | A, baseline snapshot | B                                |
| Later same URI  | A, B                  | append A                | A, baseline snapshot | B, A                             |
| Later unrelated | A                     | append B                | A, baseline snapshot | B                                |

A/B are conceptual labels, never logged Spotify identifiers. All writes are
single dispatches. Scenario removal sends only the documented URI/snapshot body.
Reads bracket the single bounded items page with equal playlist snapshots.
After each acknowledged replace, append or removal, the helper makes at most four
readback attempts, waiting 500, 1,000 and 2,000 milliseconds between them. Only
reads repeat. Each attempt retains the before/items/after snapshot bracket and
bounded complete page checks. Baseline/append confirmation still requires the
exact acknowledged snapshot and exact ordered URI sequence; append must also
advance the acknowledged snapshot. Removal requires its exact acknowledged
snapshot, while the resulting sequence remains an observation of the contract
under test. Snapshot disagreement, unexpected size or unavailable items that
persist through the bound block the observation. Provider errors and invalid
schemas stop immediately. Every scenario write is registered as pending before
dispatch. A lost response never triggers an immediate replay.

Exhausted readback mismatches retain the fixed blocker code and add only fixed
`stage`/`case`, attempt and item counts, and `stableReadback`, `snapshotMatches`,
`sequenceMatches` and `acknowledgementAdvanced` evidence. Nullable fields mean no
such assertion applies (in particular, removal has no promised sequence). No
snapshot values or track identifiers enter the output. Evidence describes the
last bounded attempt; it does not diagnose a propagation delay or prove why an
earlier read differed. Earlier runs without this evidence cannot retrospectively
establish whether their combined baseline check failed on snapshot or sequence.

The output contains only fixed case names, counts, booleans and fixed blocker
codes. `passed:true` means the bounded experiment completed and fixture cleanup
was confirmed. It does **not** mean every desired sequence was observed:
`expectedSequenceObserved` records that result for each case.
`historicalSnapshotGuarantee:false` is always emitted. Even a successful observed
sequence does not establish a general concurrent occurrence guarantee, stable
occurrence identity, or a safe production Undo algorithm. Do not broaden the
runtime adapter on the strength of documentation or this helper alone.

## Private inputs and invocation

Before any live run, the orchestrator rereads `.local/config.json`, verifies that
its disposable test-playlist permission is currently true, confirms the configured
owner/epoch/targets, and ensures the management token is valid. The replacement
management token was verified with HTTP 200 on November 21. This
implementation has only synthetic execution evidence; no live result is claimed.
Do not run concurrent proofs against the same private registry.

The stdin JSON fields are `origin` (configured Supabase HTTPS origin),
`serviceKey`, `clientId`, `encryptionKey`, `bindingKey`, `ownerFingerprint`, `epoch`,
`projectRef`, `managementToken`, `registryPath` and `authorized:true`. Read secrets
privately from the existing ignored `.local` files and never place them in shell
arguments or logs. Use the existing persisted encrypted owner credentials; no
bootstrap login, consent, new scopes or track-mutation permission is implied.
The helper authenticates a fresh `/me` response with immutable `account_id`, checks
the owner HMAC and active epoch, then checks fixture ownership in the matching
identity namespace. An explicit fixture `owner.account_id` must match that bound
immutable account. If it is absent, `owner.id` must match the fresh `/me.id`; it
need not equal `/me.account_id`. A conflicting explicit account ID always blocks,
even if the legacy profile ID matches. The same checks guard creation, lost-create
reconciliation and every fixture write/cleanup. Public readback remains separate
from ownership: creation requires `public:false`, while later contradictory
readbacks do not relax the marker or noncollaboration checks or establish hiding.

For example, after the orchestrator has privately prepared a mode-600 ignored
`.local/review-proof-input.json`, run the following with placeholders replaced by
configured **nonsecret** absolute paths and hostname. Deno must have read access
to the temporary registry too for atomic rename:

```sh
source /Users/carterfalkenberg/.local/share/spotify-plus/tooling/env.sh
deno run --no-prompt --no-remote \
  --allow-net=api.spotify.com,accounts.spotify.com,api.supabase.com,PROJECT_REF.supabase.co \
  --allow-read=/ABS/.local/review-proof-registry.json,/ABS/.local/review-proof-registry.json.tmp,/ABS/.local/review-proof-registry.json.lock \
  --allow-write=/ABS/.local/review-proof-registry.json,/ABS/.local/review-proof-registry.json.tmp,/ABS/.local/review-proof-registry.json.lock \
  scripts/live/review-proof.ts < /ABS/.local/review-proof-input.json
```

The shell opens stdin; do not grant the child access to all of `.local`. Remove
only the temporary input containing management credentials once the child exits;
retain its registry. Alternatively the orchestrator may spawn Deno with the same
permissions and write the private input directly to stdin, as existing proofs do.
Do not forward raw subprocess stderr to chat; this helper's own stdout is redacted.

## Recovery

An error preserves the registry. Rerunning checks the immutable owner and epoch,
then resolves only that registered fixture. A lost create response is reconciled
by its unique marker through bounded current-user playlist reads. Zero or multiple
matches block; there is no repeated create. Recovery never resumes or replays any
case's replace, append or item removal. It cleans the registered owned,
noncollaborative marked fixture through the existing playlist-only
`DELETE /me/library` guard, then confirms both containment false and absence from
current-user playlists. A recovered run returns `freshExperiment:false`; rerun
again for a new experiment.

Cleanup intent is persisted before dispatch. If cleanup's response is lost, the
next run only checks absence. If the playlist is still present, recovery blocks
for operator reconciliation and does not send another deletion. A stale `.lock`
or `.tmp` also blocks. The orchestrator must first establish the old process is
dead and privately reconcile/preserve those files; never blindly remove locks,
edit identifiers, erase an unresolved registry, or treat a blocker as success.
Owner/epoch changes require operator reconciliation.

Synthetic checks (no live calls):

```sh
deno test --no-prompt --deny-net --no-remote scripts/live/review-proof_test.ts
node --test tests/review-proof.test.mjs
deno check --no-remote scripts/live/review-proof.ts
```

The Node test spawns a Deno child with network denied and only temporary fixture
write permission, stubs provider/DB behavior with synthetic values, and checks
actual durable registry recovery for lost append/create/cleanup, unresolved
creation/cleanup, changed epoch/owner, legacy-only fixture ownership, conflicting
explicit owner accounts, concurrent lock and stale temporary files. Deno tests
also cover delayed read convergence, persistent snapshot/sequence/bracket
mismatches, unchanged append acknowledgements, bounded waits and unchanged
mutation dispatch counts.

## Separate append acknowledgement observation

`scripts/live/review-append-proof.ts` is a separate operator entrypoint using the
same private stdin fields, registry lock, immutable owner/epoch binding, marked
owned noncollaborative fixture guards and confirmed cleanup lifecycle. With the
existing private launcher, the orchestrator may select this entrypoint explicitly.
It creates one disposable empty playlist, confirms a stable empty readback, sends
exactly one `POST /playlists/{id}/items` containing the first cached URI, and makes
at most four bracketed readback attempts. It sends no item replacement or removal.
Recovery only cleans; it never repeats the append.

Completion requires a stable exact one-item readback and confirmed playlist
cleanup. Its `observation.ackSnapshotMatches` reports whether that readback version
matches the append acknowledgement; false remains an observation in a completed
diagnostic. `ackMatchesInitialSnapshot` and `observedSnapshotChangedFromInitial`
compare each version with the confirmed empty playlist version using exact opaque
string equality. These booleans do not decode version values or explain their
meaning. `passed:true` denotes completion of this separate observation, and
`historicalSnapshotGuarantee:false` remains fixed. A completed diagnostic with a
mismatch does not pass the original four-case contract experiment, weaken any of
its exact assertions, or establish a safe production Undo contract.

Both entrypoints now save an optional private `receipt` inside the existing
mode-600 atomic registry. It contains fixed experiment/operation/case labels, the
exact opaque acknowledgement snapshot, up to four before/after snapshot pairs,
and only readback stability/count information. The append observation also keeps
the confirmed initial empty snapshot across the append. It stores no track URI,
track metadata or playlist name. Old registries without receipts remain valid.
Opaque values are bounded to 2,048 characters and readbacks to four. Receipts must
never be printed, uploaded, committed or put into model context; a future private
read-only check may compare them and emit only counts/booleans. No opaque value is
decoded or coerced.

The acknowledgement receipt is persisted before clearing the mutation's pending
marker. A receipt-write failure stops immediately, preserves cleanup-only recovery
and never authorizes a repeated append. A stale atomic-write temporary file still
requires operator reconciliation. The receipt preserves the most recent operation,
not a replay log or idempotency guarantee. The older baseline mismatch did not
record these values and cannot be reconstructed from later stable content.

## Separate ACK-targeted removal observation (#88)

`scripts/live/review-ack-proof.ts` is a separate operator entrypoint. It does not
replace or alter the original four-case experiment's exact ACK/GET snapshot
assertions, which remain required there. This diagnostic asks whether historical
and latest **write acknowledgements** produce different URI-removal outcomes in a
controlled fixture despite unresolved metadata GET version consistency. It does
not enable production Undo or pass an existing stage gate.

The stdin shape and private runner are unchanged. Only the orchestrator runs it
after reviewing the exact code and scoped test-playlist authorization:

```sh
node .local/run-review-proof.mjs scripts/live/review-ack-proof.ts
```

A/B below represent the same two privately selected cached URIs, never logged
identifiers. One newly registered disposable fixture holds both observations:

| Observation | Acknowledged preparation | Single removal | Desired observed sequence |
| --- | --- | --- | --- |
| Historical ACK | Confirm empty; POST A → S1; confirm A; POST B,A → S2; confirm A,B,A | A against S1 | B,A |
| Latest ACK control | Reconfirm previous observed content; PUT A → S3; confirm A; POST B,A → S4; confirm A,B,A | A against S4 | B |

Removal acknowledgements are also retained; there are six item-write ACKs in all.
Each ACK must be a bounded nonempty opaque string distinct from the initial empty read
version and every earlier write ACK in this experiment. This is an equality check, never decoded ordering or
proof that a write version advanced semantically. Every write dispatches once.
No URI occurrence identifier, position, undocumented route or remote-write replay
is introduced.

Each content confirmation permits at most four read attempts with 500/1,000/2,000
millisecond waits **between** requests, outside adapter fetch timeouts. It requires
two consecutive identical exact expected sequences, complete bounded pages and
unchanged before/after metadata snapshot values within each read. Metadata bracket
equality rejects observed changes; it does not establish atomic pagination or
read-after-write version consistency. This separate mode does not require a GET
snapshot to equal a write ACK. Metadata ownership, immutable HMAC/epoch binding,
fixture marker and noncollaboration remain checked; original proof gates are
unchanged.

After removal, two consecutive identical complete observations must contain only
known A/B URIs, with at most three items. Before the control PUT, the exact
historical observed sequence is confirmed twice again. Null, unknown, incomplete,
changing or unconfirmed content blocks reset; ownership/marker/noncollaboration
failure blocks mutation. Negative historical results can receive the matched
latest-ACK control only within these fixture guards. The normal registered
playlist cleanup and two-source absence confirmation finish the diagnostic.

Output contains fixed case names, counts, exact-sequence booleans and opaque
version-equality booleans only. `passed:true` means the diagnostic completed and
cleanup was confirmed, regardless of favorable or negative observed sequences.
`originalProofPassed:false`, `readVersionConsistencyVerified:false` and
`historicalSnapshotGuarantee:false` remain fixed on completion/recovery/failure
through this entrypoint. The private receipt retains at most six item-write ACKs
and the latest four read brackets; no opaque value or real track metadata enters
stdout. Previous registries remain readable. A receipt failure stops and preserves
cleanup-only recovery.

A historical B,A result paired with latest B would distinguish those particular
observations from removing the first matching URI regardless of target version.
It would not prove universal historical-occurrence selection, exclude external
concurrent replacements, establish occurrence identity or make ambiguous writes
attributable. Negative results can rule out the tested candidate behavior for that
run. Favorable results remain bounded semantic evidence requiring separate review;
neither outcome changes the original proof result or production Undo preconditions.

Focused synthetic verification includes the actual entrypoint/lifecycle, historical
versus latest targeting, all-current and generic-first-occurrence counterexamples,
content/bracket/unknown-item guards, ACK-chain bounds, no replay after lost
create/append/removal responses, cleanup ambiguity/refusal and owner-guard/error
redaction. Tests deny network access and use temporary synthetic registries:

```sh
deno test --no-prompt --deny-net --no-remote scripts/live/review-proof_test.ts
node --test tests/review-ack-proof.test.mjs tests/review-proof.test.mjs
deno check --no-remote scripts/live/review-ack-proof.ts
```
