# Hosting at $0/month

Researched October 11, 2026. Selected: **Supabase Free + Cloudflare Workers Free**. Use ongoing free plans, not paid trials or credits. Do not activate upgrades, purchased domains, paid IPv4, PITR, larger compute or paid Workers. If limits prevent the required behavior, report the measured blocker and seek another free design; a paid fallback is not authorized.

## Comparison

| Option | Fit | Decision |
| --- | --- | --- |
| Supabase Free + Cloudflare Free | PostgreSQL transactions, TypeScript functions, SQL cron; frontend at a free HTTPS URL | Selected |
| Cloudflare Workers Free + D1 | One provider, SQL storage and cron; 10 ms CPU budget per invocation makes the backend more constrained | Viable alternative, not selected for this build |
| Railway paid web/worker/database | Straightforward persistent processes, but requires a recurring budget | Replaced |

Supabase Free includes a 500 MB database, 5 GB egress, 1 GB object storage and two active free projects. Those allocations are ample in principle for one approximately 3,000-track library with artwork left at Spotify URLs. The build must measure actual storage and traffic, including logs and index overhead. Other projects can consume organization/account allocations. [Supabase billing](https://supabase.com/docs/guides/platform/billing-on-supabase).

Supabase includes 500,000 Edge Function invocations/month. A job tick every minute is at most 44,640 calls in a 31-day month, under 9% before interactive traffic. Schedule SQL to invoke the jobs function only when work is due where practical. Free functions have a 150-second lifetime and 2 seconds of CPU; process bounded batches with durable checkpoints, targeting at most 90 seconds per drain. [Function pricing](https://supabase.com/docs/guides/functions/pricing), [runtime limits](https://supabase.com/docs/guides/functions/limits).

The browser reads library status and the active playlists view once per minute
while idle. Visible import and playlist work refresh every five seconds for the
first minute, then every fifteen seconds; blocked work uses the idle cadence.
Document-hidden polling and internal-hidden playlist polling stop, with immediate
refresh on return/focus and after playlist actions. Views stay mounted after their
first visit, preserving drafts and selection while deferring hidden revision
refreshes. Two continuously visible idle loops over eight hours consume 962 reads
including their initial reads, or 29,822 over 31 days, before interactive actions,
tag lookups and other clients. This is a synthetic cadence estimate, not measured
account usage or a quota guarantee. Query labels reuse unchanged ID/revision
results; local vocabulary edits, observed annotation revisions, manual refresh and
page reactivation invalidate them. Missing-tag display isolation adds at most 32
lookup calls beyond the normal 200-ID batches, caches its result, and never changes
the stored query or mistakes an unresolved leaf for a proven deletion.

Cloudflare serves the compiled frontend as static assets, which are free and unlimited. A small Worker proxies same-origin API/OAuth requests to Supabase; keep response bodies streaming and do no SSR, library processing or database work there. Workers Free permits 100,000 dynamic requests/day and 10 ms CPU per request. This app's interactive traffic should be far below that request limit; verify proxy CPU during the live proof. [Pricing](https://developers.cloudflare.com/workers/platform/pricing/), [limits](https://developers.cloudflare.com/workers/platform/limits/).

D1's free daily allowances are 5 million rows read and 100,000 rows written, with 500 MB per database. Those are plausible for this library, but a full backend there would need smaller execution steps. Its always-enabled recovery history also needs separate deletion handling. Retaining PostgreSQL and running the work in Supabase functions is simpler for this project. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

## The actual free-tier tradeoffs

Supabase may pause projects with low database activity over seven days. Its docs say a few daily user queries typically suffice, but even some active projects can qualify. Real sync and cleanup create database work; do not promise that cron prevents pausing, and do not use artificial keep-alive traffic as an uptime guarantee. A paused database also stops its cron. Keep pause-warning emails enabled; resume through the dashboard if needed. On return, the app processes overdue jobs and displays the last successful cleanup. This free deployment supports unattended cleanup while healthy, without an uptime guarantee. [Pause policy](https://supabase.com/docs/guides/platform/free-project-pausing).

Free quotas are ceilings, not permission to start paying. Surface quota failures honestly, reduce background work first, and preserve jobs/tags until recovery. The build must verify both accounts actually use free plans; JSON config alone cannot prove billing status. Use a separate Free organization/account if existing paid resources would make these deployments billable.

Managed daily database backups are a paid Supabase feature. Protect the irreplaceable annotations with a small encrypted application backup in private Supabase Storage: daily, retain three copies, and delete them on disconnect. Do not back up Spotify metadata, refresh tokens or session rows. This covers accidental application edits, not loss of the entire hosting account. Verify restore using synthetic data. No paid backup service or new tag-export product surface is required. [Database backups](https://supabase.com/docs/guides/platform/backups).

App-controlled deletion and backup removal can be verified. Provider-internal retention cannot be proven by a successful DELETE response; document that boundary instead of promising physical erasure from all infrastructure. [Supabase retention information](https://supabase.com/legal/privacy-resources/data-residency-and-transfers-faq).
