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
Snapshot disagreement, unexpected size, unavailable items or invalid schemas
block a usable observation. Every scenario write is registered as pending before
dispatch. A lost response never triggers an immediate replay.

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
explicit owner accounts, concurrent lock and stale temporary files.
