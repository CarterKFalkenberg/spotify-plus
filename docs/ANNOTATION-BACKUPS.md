# Annotation backup operations

The jobs function creates one encrypted annotation snapshot per UTC day and keeps
the three latest successful daily copies. Maintenance and the existing SQL job
leases/retry timestamps schedule this work; no process needs to remain running.
Daily backup scheduling, job claiming and lease checkpoints also continue during
Spotify reconnect state, because authenticated annotation editing remains available.
OAuth failures park Spotify work while preserving annotation-only backup jobs;
backup execution never reads Spotify credentials or contacts Spotify.
Copies contain only live tag UUIDs/display names/normalized identity and present
track-HMAC/tag edges. Removed-track HMAC assignments remain recoverable after
metadata expires. Deleted vocabulary, undo journals, cached Spotify metadata,
raw Spotify IDs, credentials, sessions, queries and pending jobs are excluded.

The format is version 1 with key version 1. AES-GCM uses a fresh random nonce and
binds the owner fingerprint, account epoch and snapshot UUID as additional
authenticated data. The document also binds its UTC day, revision and SHA-256 of
the existing encrypted annotation-key record. This linkage verifies the same
per-account HMAC key without including that key or its ciphertext in the backup.
The stable `BACKUP_ENCRYPTION_KEY` remains a Supabase runtime secret; deployment
transfers the existing private runtime key. Never rotate it casually or print it.
The compact document budget is 3,744,914 UTF-8 bytes. SQL permits 4,264,933 bytes
for its expanded JSONB representation: the compact budget plus a conservative
520,019-byte separator-space allowance derived from the strict field/array caps.
This avoids rejecting a valid encrypted snapshot because PostgreSQL adds spaces.
The payload and ciphertext have strict schema/size budgets below the private
bucket's 5 MiB limit; unsupported versions fail closed.

## Storage and disconnect races

Each snapshot uses a private `annotation-backups-e<EPOCH>-<UUID>` bucket with one
ciphertext object, `<EPOCH>-<UUID>.bin`. This small set of private buckets uses
ordinary Free Storage rather than any paid backup/PITR feature. The foundation's
`annotation-backups` bucket stays private and empty for legacy compatibility.
No client receives a bucket policy or a URL granting access.

A SQL creation intent grants exactly one bucket-creation POST for each UUID.
Retries inspect the bucket instead of recreating it. If an ambiguous creation
remains absent, that identity is retired before allocating another UUID. At most
three identities can be attempted per UTC day; failures back off through the
existing durable worker job. Retired targets remain in the purge registry until
verified absent, and redacted registry rows are reaped after 30 days of confirmed
absence. A delayed successful creation can leave an empty target; its stale worker
cannot upload and removes it on the failed lease/epoch fence. Empty infrastructure
is distinct from an application annotation copy.

After bucket creation, the worker checks the exact snapshot identity, active
account epoch and current SQL job lease before uploading. Uploads never create or
overwrite buckets/objects. Lost upload acknowledgement is reconciled by reading
and authenticating the existing object before committing a successful copy.
Before allocating any new daily target, the worker finishes pending retired-target
cleanup; a prolonged deletion outage cannot accumulate new daily buckets.
Cleanup claims one target per invocation, records each verified bucket absence in
SQL immediately, and resumes only unconfirmed targets. Storage timeouts shrink to
the remaining worker deadline, with ten seconds reserved for SQL/job checkpoints.
Disconnect uses the same bounded progress rather than rescanning already purged
registry rows; an actually reappearing empty bucket is still detected and removed.
Retention first retires old targets, deletes them through the Storage API, and
verifies absence before completing. A failed deletion retries without discarding
the successful new daily copy.

Disconnect first invalidates the epoch, cancels leases and retires every target
while preserving the redacted registry. Its system job empties/deletes snapshot
buckets via the Storage API and empties/verifies the legacy bucket. Deleting the
never-reused bucket is the late-upload fence: the installed Storage object→bucket
foreign key serializes object finalization against bucket deletion. A competing
upload either makes deletion fail/retry or fails after deletion. SQL independently
checks that registered buckets and legacy objects are absent before disconnect
can report application-data deletion complete. A new connection has another epoch;
old cleanup targets cannot delete its backups.

This technical choice avoids custom triggers in the managed Storage schema, which
[Supabase recommends treating as read-only](https://supabase.com/docs/guides/storage/schema/design).
The [bucket deletion contract](https://supabase.com/docs/reference/javascript/storage-deletebucket)
requires an empty bucket. The actual installed FK and Storage API races must pass
on the disposable local stack before enabling the writer in deployment; current
upstream source alone is not proof of the deployed version.

Application-controlled object/bucket absence is verifiable. A failed upload may
leave provider-internal physical bytes outside the application's object namespace,
and provider backup/retention systems are outside this application's controls.
Do not describe metadata absence as byte-level erasure from provider infrastructure.
See [hosting limits](HOSTING.md) and
[Supabase retention information](https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq).

## Explicit operator restore

There is no product export/restore UI and no scheduled restore. An operator first
inspects the currently connected owner/epoch, desired retained snapshot and current
annotation revision privately. Restore is an explicit whole-annotation replacement,
including revival of live tag identities in that snapshot. It requires human intent
for real data; only isolated synthetic restore tests are preauthorized for build
verification. Stop ordinary tagging while reviewing the target and revision.

`scripts/restore-annotations.ts` consumes private JSON through stdin containing
`origin`, `serviceKey`, `backupEncryptionKey`, `confirmation: "restore-annotations"`,
`owner` (fingerprint), `epoch`, `snapshotId` and `expectedRevision` (decimal string).
Never put these credentials in shell arguments, pasted prompts, terminal output or
Git. The orchestrator prepares an ignored private input and pipes it to Deno with
network permission restricted to the configured Supabase origin. The helper prints
only success/failure and restored counts.

The helper first checks current connected owner/epoch/revision and key linkage,
authenticates/decrypts the bounded ciphertext, and passes the exact expected revision
to the final transaction. That transaction repeats all fences, validates the full
schema, normalized names, unique identities/edges and committed snapshot linkage.
Concurrent edits change the revision and reject the restore; concurrent disconnect
wins the account lock or waits for the restore transaction, then purges its result.
It cannot resurrect account credentials, sessions, cache, or old jobs.

The transaction restores only vocabulary and assignment presence. Current tags not
in the snapshot become UUID tombstones rather than disappearing; stored playlist
query leaves therefore retain explicit deleted-tag semantics. Existing playlist
queries, snapshots and operations are untouched. All session undo journals are
invalidated so later Undo cannot overwrite the replacement. The annotation revision
advances, invalidating cached previews/cursors. No Spotify calls occur.

## Evidence commands

`deno task check` and `deno task test` cover synthetic crypto, strict schema,
wrong-owner/epoch/key/version/ciphertext, acknowledgement loss, retention failure,
creation ambiguity and stale-worker fencing. `node supabase/tests/database/run-backups.mjs`
uses disposable PostgreSQL for transactional validation, retention and independent
restore/disconnect races. Its minimal Storage metadata stand-in is **not** provider
Storage acceptance.

The root-coordinated disposable Supabase stack applies
`supabase/tests/database/rest-backups-fixture.sql`, then invokes
`supabase/tests/database/rest-backups.ts` with its synthetic service key on stdin.
This local-only proof rejects every non-loopback target. It checks the actual
installed object/bucket FK, uploads/authenticates a real encrypted synthetic daily
copy, restores isolated annotations through PostgREST, races real Storage HTTP
uploads/deletions, disconnects and rejects a late HTTP upload after purge completion.
It emits only booleans/status/counts. The final integrated head and Free deployment
still need orchestrator verification; these tests do not complete the resilience
stage or the user's phone/tagging-speed acceptance.
