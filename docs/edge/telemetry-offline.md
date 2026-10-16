# Statistics, telemetry and offline operation

Implemented contract: [ADR 0005](../adr/0005-local-first-statistics-and-offline-assets.md).
The earlier [investigation](database-offline-telemetry-investigation.md) records the pre-change behavior.

## Request policy

The document starts one memoized statistics attempt. React remounts, compression, presets,
focus, visibility, reconnect and elapsed time cannot retry it. A full reload creates a new
attempt; known-offline loads skip it. Requests and responses use no-store. The shared client
validates a bounded response, times out after five seconds and falls back to a validated public
localStorage snapshot. Storage failures do not affect processing. No TTL starts network work.

GET `/api/stats` reads at most 26 precomputed format/outcome rollups plus singleton metadata in
one statement. It returns v2 processed/compressed counts, input/output/saved bytes, weighted
savings, distribution, tracking_since, updated_at and retrieved_at. Legacy processed totals
are separate; old reports cannot establish which files were compressed. The old GET
`/api/telemetry` uses the same read handler for compatibility. POST never calls a stats read.

The footer shows a compact summary; its disclosure contains format breakdowns and absolute
timestamps. A saved snapshot is labelled stale. No live timestamp timer or refresh control
creates extra reads. Output sizes in telemetry exclude ZIP overhead; the local batch summary
continues to include actual output packaging bytes.

## Telemetry writes

Consent is off by default and lasts only for the current page. After successful output is
ready, v2 groups rounded input/output byte totals and counts by allowlisted input extension
and compressed/preserved outcome. JPEG aliases normalize to JPG. Only actual smaller transforms
count as compressed; preserved originals remain processed. Sub-KiB transforms can legitimately
round both totals to zero. These are approximate community reports, not all application usage.

One foreground, apparently-online fetch per completed batch; five-second timeout, no retry,
beacon, keepalive, persistent queue or visibility/unload flush. Hidden/offline completions are
discarded. A rejection or D1 quota error cannot fail processing or trigger a stats refresh.
There is no server feature-discovery request; the disabled server switch prevents D1 writes
but can still receive an opted-in POST.

The strict v2 body contains only version, a random submission_id and buckets with format,
outcome, file_count, input_bytes and output_bytes. Limits are 16 KiB UTF-8, 26 unique buckets,
1,000 files and 1 TiB rounded input per submission. Out-of-policy reports are dropped whole,
never truncated to 60 files. No names, paths, file contents, hashes, device tier, preset or
duration are sent. Cloudflare still handles ordinary network identifiers outside D1.

`0002_aggregate_telemetry.sql` appends the v2 schema; 0001 is unchanged. One submission stores
aggregate JSON; its insert trigger atomically updates format rollups through json_each.
Submission-ID conflicts do nothing, including a replay with changed buckets. One new report
uses three top-level SQL statements: two bounded cleanup deletes and one submission insert.
Trigger updates and indexes add row writes; do not equate one POST with one billed write.
v1 POST remains available during migration and updates only legacy counters.

Old submission IDs and legacy logs become eligible for cleanup after 30 days. Each v2 write
removes up to 100 expired rows from each indexed table. Rollups remain. Without new writes,
cleanup does not run; this is not a guaranteed deletion deadline. Strict timed retention would
require a separately configured maintenance job. Deduplication is finite after IDs are removed.

## Explicit offline preparation

“Prepare offline use” registers a same-origin service worker and saves an exact build graph:
HTML, CSS, fonts, icons, module/worker scripts and WASM. No engine runs during preparation.
There is no install-time codec download, periodic sync or application update interval. The
browser may check the worker script on navigation under its own lifecycle; this never calls D1.

The build plugin reads final output **after Vite's preload rewrites**. Its allowlist admits no
more than 128 files / 64 MiB. Sequential fetches stream into Cache Storage in the service worker,
with exact byte caps and a 15-second per-asset deadline. A completion marker appears only after
all assets succeed. HTML is compared with the expected build shell before caching, so an old
worker cannot prepare a new deployment's HTML against old modules. Failed preparation does not
claim readiness. Public asset matching ignores Vary: Origin for preview/module compatibility;
only exact same-origin allowlisted GETs qualify.

The worker never intercepts API writes/reads, cross-origin requests, arbitrary paths or user
blobs. Selected files and output never enter persistent storage. Navigation tries the network,
then falls back to a fully prepared shell. Exact asset URLs use cache-first. No skipWaiting:
old controlled pages retain their worker/cache; activation clears old versions only when those
pages no longer control the prior worker. Close other tabs and reload before preparing updates.

First-ever offline navigation still cannot work. Browser cache eviction or a missing engine
can remove a capability; originals remain available for retry. Preparation must happen online
after explicit interaction. One-file output is direct; multiple files use the local ZIP worker.
Optional UI chunk errors are contained so the local queue/download is not unmounted.

## Validation and rollout

`db:test` now runs in-memory SQL checks **and** creates a disposable local D1 emulator. It applies
all numbered migrations, applies them again to verify tracking, and tests aggregate rollups,
duplicate replay and retention. Its generated temp path is checked before cleanup. It never
uses --remote or production bindings. Unit/API tests also cover invalid metadata, safe integer
limits, counter rollback, consent revocation, offline/hidden gates, bounded responses and timeout
cleanup. Built-browser tests verify read counts, a 65-file report, failure independence, explicit
preparation, cold offline PNG decode, direct download and ZIP extraction.

Cross-browser offline tests shut down a disposable origin server, including access by service
workers, and set the document's offline hint. Failure preparation uses a real HTTP 503. These
avoid differences in browser offline emulation and service-worker request interception; they
do not constitute physical-device or operating-system connectivity certification.

No deployment is performed by these changes. Apply append-only migrations to isolated preview
before deploying the new Functions. Keep telemetry disabled until preview behavior, rate
protection and the chosen retention guarantees are reviewed. Deploy a coherent complete dist
including offline-worker.js; static /api routes remain the only Pages Function invocations.
The unmodified strict 50,000-byte contributor contract remains a known React baseline gap;
the repository's existing 80,000-byte gate is checked separately and has not been increased.
