# Controlled one-track / liked-date proof (candidate only)

This separate operator entrypoint supplies a reviewable proof before requesting
human permission. It does not change the runtime adapter, ordinary login, or the
saved-library write boundary. No live run is authorized by this document, a scope
grant, another agent's report, or the disposable-playlist flag.

The orchestrator must first obtain explicit human approval for temporarily liking
**one frozen, initially unliked cached track**, restoring it to unliked, and a
maximum of four total track-write dispatches including cleanup. The operator must
not edit that target during the experiment. Spotify membership writes have no
compare-and-swap: concurrent human changes cannot be attributed perfectly. An
ambiguous final cleanup can require manual reconciliation. Temporary membership
can be visible in Spotify and normal app synchronization.

## Private execution interface

Run `scripts/live/track-proof.ts` through the existing private stdin launcher,
using the reviewed clean Git head and a fresh owner epoch. Never put input in
shell arguments or stdout. Supply `origin`, `serviceKey`, `clientId`,
`encryptionKey`, `bindingKey`, `ownerFingerprint`, `epoch`, `projectRef`, and
`managementToken` as for the playlist helpers, plus:

- `executionHead`: actual reviewed 40-character Git commit, checked independently
  by the orchestrator before invocation (the helper matches the supplied binding).
- `operation`: new UUID and `registryPath`: new absolute ignored private path.
- `targetUri`: exactly one private `spotify:track:` URI. The orchestrator chooses
  it privately; the helper independently requires exactly one matching cached
  active row with matching Spotify ID and no current `liked` source membership.
- `consent`: a separately obtained human-approval artifact with `approved:true`,
  `purpose:"one-unliked-track-date-proof"`, matching `operation`,
  `ownerFingerprint`, `epoch`, `reviewedHead:executionHead`, `registryPath`,
  `maxWrites:4`, `restoreUnliked:true`, a future UTC `expiresAt` within 24 hours,
  and `targetFingerprint` equal to
  `ownerFingerprint("track-proof:" + targetUri, bindingKey)` using the shared HMAC.

The artifact is a mechanical binding, not evidence that a human actually gave
consent. The orchestrator owns obtaining and accurately recording that approval.
Never recreate/delete a registry, move the artifact to a new registry, or reuse an
operation to work around an unresolved or consumed result. Registry and atomic
temporary files use mode 0600; a stale lock/temp file fails closed for inspection.
Opaque identifiers, memberships and raw `added_at` receipts stay private.

## Bounded behavior and recovery

The helper checks active epoch, read/modify grant scopes, fresh `/me.account_id`
HMAC, exact nonlocal/nonrelinked usable target identity, and two consecutive
unliked reads before freezing the target. It then performs exactly:

1. PUT like; confirm liked and read the target's first `added_at` twice.
2. DELETE unlike; confirm unliked; wait 2.1 seconds outside request timeouts.
3. PUT like; confirm liked and read the target's second `added_at` twice.
4. DELETE unlike; confirm unliked and consume the registry.

Each prewrite membership check needs two consecutive matches in at most four
reads. Ownership/epoch/consent are checked again before writing; pacing/token
preparation precedes the durable pending intent and final epoch check. Each
reserved intent consumes one of four slots even if dispatch never happened. No
write is retried, including 401, 429, malformed success or network ambiguity.

Saved metadata scans use documented limit/offset pagination, up to 200 pages of
50 items per scan, with at most four scans per timestamp and no ordering
assumption. The exact target must have a valid UTC calendar timestamp (seconds or
1–3 fractional digits); two observations must agree. Missing/ambiguous target,
relinking, invalid date, pagination mismatch, or bound exhaustion stops the test.
Offsets and repeated observations do not establish an atomic library snapshot.

On failure, only a distinct cleanup DELETE may consume an unused slot after a
possible own PUT and two current liked observations. A pending/acknowledged
DELETE is never repeated. **Any unacknowledged PUT intent requires manual
reconciliation indefinitely:** two unliked reads, a successful compensating
DELETE, or a later restart cannot prove that the original PUT will not apply
later. Such a registry remains incomplete, retains its original intent and never
reports `cleanupConfirmed` or `alreadyConsumed`. The helper cannot resolve that
uncertainty automatically; do not erase it or recreate the experiment.

A restart is always cleanup-only. Two unliked reads can finish restoration only
when all previous PUTs were acknowledged. True after the last DELETE, no
attributable own PUT, expired consent, exhausted budget, stale epoch or wrong
owner blocks mutation. If an unresolved PUT takes effect after false reads, at
most one distinct cleanup may use an unused slot; if cleanup was already
attempted, it is never repeated. A consumed registry is never used to delete a
subsequent human like. The root operator must inspect every non-success and
reconcile cleanup explicitly. Fixed failure output remains conservative
(`cleanupMayBeRequired:true`) even when current observations are unliked.

Successful output contains only fixed booleans and a write count: both timestamp
receipts validated, whether their parsed instants equal or the second is later,
and confirmed unliked restoration. Equality is a legitimate observation, not a
failure. `generalTimestampGuarantee:false` remains false. Completion proves only
this bounded response contract; it does not authorize product track writes or
prove universal timestamp precision, cache consistency, membership attribution,
or browser acceptance.

Current primary contracts:
[save library items](https://developer.spotify.com/documentation/web-api/reference/save-library-items),
[remove library items](https://developer.spotify.com/documentation/web-api/reference/remove-library-items),
[check library contains](https://developer.spotify.com/documentation/web-api/reference/check-library-contains),
[saved tracks and added_at](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks).
The documented track URI query and empty HTTP 200 write response are asserted;
documentation is not a successful live proof.

Synthetic validation: `node --test tests/track-proof.test.mjs` runs the real
entrypoint lifecycle against a strict synthetic fetch harness with networking
denied. No real target, secrets, names or receipts belong in tests or output.
