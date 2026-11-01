# Private operational diagnostics

Issue #81 adds sanitized facts to the existing Supabase Free database. It adds no
Spotify scopes, provider services, or paid logging features. Diagnostics never
supply playback authorization or change its safety fences. They do not contain
track/device/account identifiers, metadata, SDK objects, arbitrary input, raw
errors/stacks, URLs, user agents, tokens, cookies, or request/response payloads.

The service-only `app_diagnostic_record` RPC accepts closed event/reason codes,
40-character build SHAs, random UUID correlation and boolean/bounded numeric
facts. The browser route requires the existing owner session, same origin and a
1024-byte JSON body. The proxy replaces client request correlation with a fresh
UUID. Browser document and playback UUIDs exist only in memory, independent of
Spotify identity; a new controller receives a fresh playback UUID. Frontend SHA
comes from its existing build meta tag; backend events carry the backend SHA.
The proxy returns its generated request UUID in a fixed response header. A failed
browser start records the validated UUID as `related_request`, linking its safe
API code/status to the backend’s fixed Spotify error kind and upstream/outgoing
HTTP status (zero means unavailable). Backend token failures have a separate event
code. No correlation is propagated into Spotify requests. Browser playback UUIDs
and bounded operation ordinals correlate repeated starts and pauses across a
warmed controller’s many songs; deduplication applies per operation.

The sender sends at most 80 events per document, deduplicates each
playback/operation/event/reason, reserves the last 30 slots for failures, permits two concurrent ordinary requests
(or four for failures), times out after 1.5 seconds,
and has no retry, persistent buffer or logging of its own failures. It is never
awaited by playback. API/job diagnostic writes are background work; RPC errors
are absorbed. A database outage can therefore lose evidence without blocking
playback/tagging. Retired-holder and pause facts distinguish unresolved remote
writes from failed quiet-state proof; they cannot prove whether Spotify was
audible outside the browser.

Database ingestion serializes with a transaction advisory lock and accepts at
most 300 browser + 100 API + 100 job rows per UTC hour globally, including across
concurrent invocations and browser reloads. It keeps at most 5000 rows, expires
rows older than seven days on ingestion and existing scheduled useful
maintenance, and clears rows/budgets atomically on disconnect. Disconnected or
stale-epoch writes from any source cannot recreate them. API reports capture the
authenticated session epoch and job reports use the claimed job epoch. Failures
before session lookup or before an owner-bound job claim have no captured epoch
and are deliberately not persisted. No diagnostics are included in
annotation backups. Provider-internal retention remains outside app control.
Expired rows can remain while the Free project/scheduler is paused; maintenance
removes them after recovery. The row cap bounds live records, not PostgreSQL
allocated disk bytes or provider logs. Check actual usage and plans before each
deployment; quotas never authorize spending.

Cloudflare default invocation logs must remain disabled: callback URLs can
contain authorization secrets. The proxy emits only a fixed custom
`proxy_failed` event with build/request UUID if upstream fetch throws. Retention
of those safe custom events depends on existing provider logging configuration;
this change does not enable retained Worker observability. The Supabase sink
cannot record its own complete outage. Browser delivery, tab closure, quotas,
deduplication and background termination can all drop events. Missing events are
not proof of healthy playback.

## Reading evidence

Use the Supabase SQL editor or an existing private operator connection, in a
read-only transaction. Do not paste connection strings or production data into
commands, chat, issues or PRs. These queries return only the sanitized diagnostics
schema; inspect only that schema, never join Spotify/product metadata.

```sql
begin read only;
select created_at,source,event,reason,build,request,related_request,document,playback,facts
from app.diagnostic_events
where created_at >= now()-interval '1 day'
order by id desc limit 100;
select source,event,reason,count(*) from app.diagnostic_events
where created_at >= now()-interval '1 day'
group by source,event,reason order by count(*) desc;
select source,hour,used from app.diagnostic_budget order by source;
rollback;
```

## Diagnosing the reported message

“Playback could not be stopped safely. Check Spotify before reloading this page.”
has three direct entry paths:

- `navigation_unresolved`: song changes with `startPending`, `awaitingProof`, or a
  command pending outside a quiet handoff. Facts show which safety fence fired.
- `pause_unresolved`: Pause runs while a start, fresh playing proof, or another
  command remains unresolved.
- `holder_retired`: a later controller attempts to reuse a document's retired SDK
  holder. Earlier lifecycle events may explain why it was retired, including an
  unconfirmed start, teardown rejection, or `pause_failed`. `start_failed` with
  `startup_deadline` records the start/proof state when its deadline fires;
  `holder_retired` with `teardown_rejected` records the safety facts captured at
  teardown dispatch. Late start settlements retain their original dispatch
  operation ordinal, even after navigation or controller destruction.

`pause_failed` records a fixed reason (deadline, invalid state, different item,
state-read rejection, pause rejection), dispatch/in-flight counts, null/stale
reads, elapsed time and latest quiet-state facts. `pause_confirmed` distinguishes
healthy quiet handoffs; start dispatch/acknowledgement/playing proof distinguish
server acknowledgement from fresh SDK proof. These events report facts without
recording the item itself. Existing synthetic playback tests reproduce the
message paths and preserve all stopping/deadline behavior. For the November 1 report, historical redacted evidence showed two successful
start responses followed by one 503 while token responses succeeded. That fits
an ambiguous failed start followed by a retired-holder retry, especially with the
reported next-song navigation, but cannot establish the server cause. A screenshot alone
cannot identify which path fired; historical sessions before this release have
no browser telemetry and cannot be diagnosed retrospectively with certainty.
