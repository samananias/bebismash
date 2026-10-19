# Database, offline behavior and telemetry investigation

Date: 2026-10-16. Status: investigation and proposed plan; no implementation, migration or deployment changes authorized by this report.

## A. Current architecture and evidence

This audit traces the current checkout, rather than treating the blueprint templates as deployed behavior. Some onboarding/blueprint introductions still call the repository a documentation baseline, despite an implemented application. Production Cloudflare bindings, dashboard overrides, traffic, rate rules and deployed database contents were not inspected. Checked-in configuration is evidence of intended deployment configuration, not proof of live settings.

```text
Page boot → App → TelemetryBadge mount → GET /api/stats
                                         ↓ Pages Function
                                         DB.prepare(...).first()
                                         ↓ D1 global_stats singleton

User selects files → local File registry → scheduler → admitted workers
                    → transferable chunks → local Blob or chosen disk sink
                    → direct file (one input) / ZIP (multiple inputs)
                    → completed store state
                    → only with session consent: import telemetry service
                    → POST /api/telemetry → validate → D1 batch inserts
                                                        ↓ insert trigger
                                                   update global_stats
```

Evidence map (paths relative to repository root):

| Source                                                                              | What it establishes                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/TelemetryBadge.tsx:14`                                              | Empty-dependency mount effect fetches stats; failure is swallowed and footer says unavailable. No timeout, abort, response validation or shared request deduplication. |
| `src/App.tsx:407`, `src/main.tsx:13`                                                | Footer remains mounted during normal processing; development uses React StrictMode.                                                                                    |
| `src/store/useSmashStore.ts:99`, `:266`, `:415`                                     | File handles live outside Zustand; scheduler loads on action; telemetry runs after successful whole-batch completion and checks consent again after its import.        |
| `src/services/telemetry.ts:46`                                                      | Rounded, allowlisted events; at most three envelopes of 20; beacon with fetch fallback; no retry queue.                                                                |
| `src/services/telemetry.ts:136`                                                     | A second stats helper exists but has no callers. It is not an additional current request.                                                                              |
| `functions/api/stats.ts:5`                                                          | One prepared singleton SELECT per executed handler; returns totals and updated_at.                                                                                     |
| `functions/api/telemetry.ts:18`, `:164`                                             | Duplicate GET stats handler plus POST inserts; backend kill switch disables writes before reading body or calling D1.                                                  |
| `functions/lib/telemetrySchema.ts`                                                  | Strict input schema; 20 events; individual and envelope byte-count limits.                                                                                             |
| `migrations/0001_telemetry.sql`                                                     | Log table, unique event index, timestamp index, singleton counters and per-insert trigger.                                                                             |
| `src/services/scheduler.ts:416`                                                     | Report includes source extension and result size, but drops original/transformed disposition.                                                                          |
| `src/workers/engineDownloads.ts`, worker handlers, codec adapters                   | On-demand same-origin engine downloads; no processing API calls.                                                                                                       |
| `src/services/sink.ts`, `src/services/directOutput.ts`, `src/workers/zip.worker.ts` | Local output, bounded chunks, ZIP packaging and Blob/disk download.                                                                                                    |
| `public/_routes.json`, `public/_headers`, `wrangler.toml`                           | Only `/api/*` invokes Functions; static assets have immutable cache headers; production and preview bind different D1 IDs; both set telemetry disabled.                |

Browser-to-Function calls are relative same-origin URLs. In development Vite proxies `/api` to local Pages on port 8788. Vite preview serves static output only; it does not execute Functions/D1. Backend D1 access is through `context.env.DB`, never credentials exposed in frontend code.

### Complete application SQL inventory

| Entry point           | SQL / operation                                                          | Frequency                                                                    |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| GET `/api/stats`      | SELECT totals and updated_at FROM global_stats WHERE id = 1              | One statement per handler invocation; primary-key lookup of one row.         |
| GET `/api/telemetry`  | Same SELECT                                                              | No frontend caller; can be invoked independently.                            |
| POST `/api/telemetry` | INSERT compression_logs … ON CONFLICT(event_id) DO NOTHING, via DB.batch | One bound INSERT statement per accepted event, 1–20 statements per envelope. |
| Insert trigger        | UPDATE global_stats … WHERE id = 1                                       | Once for each new inserted event; duplicates do not increment totals.        |
| Migration             | Create schema/indexes/trigger; insert initial singleton                  | Schema setup, not page activity.                                             |
| `scripts/db-test.mjs` | In-memory synthetic inserts and verification SELECTs                     | Explicit local test only; not browser or production activity.                |

There is no implemented retention job, scheduled aggregation, database keepalive, polling, online listener, focus refresh, background sync, service worker, WebSocket or EventSource in the application. The blueprint calls for a separate retention job; that is not current runtime behavior.

### Request/query audit

“1 read” below means one SELECT if the request reaches the handler. HTTP cache hits or network failures can mean zero Function/D1 calls. Production mount counts differ from development StrictMode's repeated effect setup.

| Event                                          | Current API request?                                                          | Current D1 work?                                                       | Desired behavior                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| Initial production page load                   | One stats fetch attempt                                                       | Up to 1 read                                                           | One shared boot request                                       |
| Refresh/reload, including home link navigation | New mount → stats attempt                                                     | Up to 1 read                                                           | One new boot request                                          |
| Component mount/remount                        | Stats effect runs again; development can duplicate                            | Up to 1 read per attempt                                               | Reuse same document-lifetime promise, including failed result |
| File selected / preset or state change         | No API; lazy UI JS may download                                               | None                                                                   | Same                                                          |
| Compression starts                             | No API; worker/codec/JS/WASM assets may download                              | None                                                                   | Same; cached assets when offline                              |
| Whole batch completes, consent off             | None                                                                          | None                                                                   | Same                                                          |
| Whole batch completes, consent on              | 0–3 telemetry POSTs; no stats read                                            | Disabled config: none. Enabled: per-event inserts plus trigger updates | At most 1 aggregate POST per successful user batch            |
| Multiple files                                 | Same batching rule; no per-file stats reads                                   | One insert + trigger update per reported file when enabled             | Aggregate before sending                                      |
| Compression cancelled / whole batch fails      | No completion telemetry                                                       | None                                                                   | Same; no falsely reported success                             |
| Tab hidden/backgrounded/minimized/app switched | No event-triggered API                                                        | None caused by transition                                              | No flush/read on transition                                   |
| Return/focus/reconnect                         | No event-triggered API                                                        | None                                                                   | Same                                                          |
| Idle / no interaction / hours open             | No recurring API                                                              | None                                                                   | Same                                                          |
| Offline                                        | Boot stats attempt if UI loads; opted-in completion may attempt POST          | No server work for failed delivery                                     | Skip known-offline API work, no automatic replay              |
| Browser reopened                               | New document loads stats; restored live document has no new mount requirement | Up to 1 read for a new document                                        | New load once; no restore/focus refresh                       |
| Download click                                 | Local blob/disk output                                                        | None                                                                   | Same                                                          |

An already-started job can finish while hidden and submit consented telemetry; beacon/keepalive delivery can also outlive visibility or page close. This is completion work, not idle polling. No current visibility gate prevents it. Browser throttling/suspension may affect local processing/deadlines; this audit does not certify uninterrupted processing while the OS suspends a browser.

The existing intervals are local: worker liveness (2 seconds), scheduler deadline checks (1 second), and active job elapsed UI (1 second). Sink URL revocation is a local timeout. None contacts Cloudflare. No network activity arises solely from these timers.

## B. Current problems

1. Fetch-on-component-mount approximates fetch-on-load but does not enforce it across remounts/StrictMode. The footer has no persistent fallback; it ignores returned freshness data and malformed response handling is weak.
2. Both stats GET handlers return `public, max-age=30`. This permits browser freshness caching, so an immediate reload's fetch may not reach D1. It does not prove a configured shared edge cache. Thirty-second expiry does **not** schedule a fetch.
3. Telemetry is already batched over each completed user batch, not one POST per file. It still stores one event per file and updates the singleton per file. One DB.batch call is not one SQL statement or one billed row write.
4. Only the first 60 valid events are sent. A 100-file successful batch sends three envelopes and omits 40 events. Each envelope's sum of original bytes must be ≤2,147,483,647; the client only partitions by event count, so a size-heavy envelope can be rejected wholesale. Individual values also have this ceiling.
5. “Files smashed” includes originals preserved unchanged, unsupported generic files and zero-byte events. Worker disposition is lost in the completed report. `.jpeg` maps to other because only `jpg` is allowlisted, and extension-derived category can differ from content routing. Format counters must define input format versus output format.
6. Rounded statistics are approximate and consent-biased; ZIP overhead is excluded from per-file output telemetry. Rounding both sizes down can change apparent savings by less than 1 KiB per file. They are not a count of all application usage or exact downloaded bytes saved.
7. No offline shell or explicit engine cache exists. A successful page load does not mean all lazy dependencies are available. An offline failure of the separately imported JobStatus component can also disrupt rendering; there is no visible app error boundary around that lazy import.
8. Raw log retention is specified but unimplemented. Configured telemetry disablement protects D1 writes but does not stop opted-in clients sending HTTP requests. Origin/schema checks do not establish deployed abuse protection or trustworthy public statistics.

## C. File privacy verification

The inspected application has **no user-file upload path**. File inputs/drop handlers put File handles in a local registry; workers read them and return transferable chunks; sinks build a local Blob URL or write to an explicitly selected disk handle. Files, output bytes, filenames, paths, hashes and inspected media details are not placed into API request bodies. Media/container libraries use local bytes; this code has no URL-backed media ingestion path.

The telemetry request is JSON containing ephemeral event/batch UUIDs, an allowlisted source extension/category, preset, rounded input/output byte counts, rounded duration and coarse device tier. The server derives saved bytes and adds receipt time. The strict schema rejects unexpected fields. D1 contains per-event numerical/categorical metadata and aggregate counters; its schema has no file-content column. Neither API returns user files.

This is verification of the checkout's data flow, not an inspection of live D1 contents or all Cloudflare account logging. Cloudflare necessarily sees network identifiers for ordinary HTTP delivery; application code does not insert IP addresses into D1. “No metadata” would be inaccurate: opt-in categorical and size metadata is deliberately transmitted. No user data was sent to remote services in this investigation.

## D. Proposed telemetry writes

Choose **local aggregation per completed user batch**. This combines B's clear completion boundary with C's reduction in SQL work. Pure session-end aggregation sends fewer requests but depends on unreliable close events, creates background delivery, and loses entire sessions if users never flush. One request per file is unnecessary.

```text
Whole batch succeeds → make download ready
  → consent still enabled?
  → aggregate rounded counters by allowlisted INPUT format + outcome
  → foreground and apparently online?
      yes → one bounded POST, short timeout, no retry
      no  → discard telemetry (compression/download stays successful)
  → never invalidate/refetch global stats
```

Proposed strict v2 envelope: version, random submission_id, and a bounded list of format/outcome buckets containing file_count, input_bytes and output_bytes. Derive category, saved bytes and ratio on the server. No file names, payloads, hashes, timestamps, user/session identity, device tier, preset or duration are needed for the requested dashboard. Use a distinct outcome for transformed versus preserved; count only actually smaller transformed results under “files compressed,” and optionally show “files processed” separately. Retain no per-file events in v2.

Round before aggregating, validate safe integer totals and count/size relationships on both sides, and cap the full serialized UTF-8 body at 16 KiB. Thirteen current format buckets times bounded outcomes fit easily; prove worst-case encoding and integer limits. Keep submission IDs stable for an explicit duplicate attempt; do not regenerate IDs to evade deduplication. No automatic retries or persistent telemetry queue. Use foreground fetch with credentials omitted and a bounded abort, instead of background beacon/keepalive. Revoking consent clears unsent data; it cannot retract requests already received.

A foreground-only completion policy intentionally sacrifices observations when hidden/offline. Do not flush on focus, visibility, unload, reconnect or timers. If future product needs reliable telemetry, revisit that tradeoff explicitly rather than silently adding background traffic.

## E. Proposed statistics reads and caching

One document-lifetime boot function owns a memoized promise and validated snapshot. Call it once at boot; all UI subscribers reuse it, even after failure/remount. Do not retry within that document. No compression, navigation fragment, focus, online event or component mount can start another read. A real full reload creates a new promise.

Use one GET `/api/stats` returning every dashboard value: compressed/processed counts, input/output/saved totals, format distribution, and explicit UTC freshness timestamps. Derive output = input − saved only for counters with the same population. Weighted savings = saved/input × 100; compression ratio = output/input. These differ from the arithmetic mean of per-file percentages. Display weighted savings with a clear label; use an em dash for zero input.

Keep the current-page snapshot in memory. A single small versioned **localStorage** record is sufficient for a last-known public aggregate snapshot across reloads; catch blocked/quota/corrupt storage and validate values. IndexedDB adds no value for this tiny response. Never persist files, telemetry queues or consent with it. On boot show cached data immediately, then make the one permitted request; replace only on valid success. Failure leaves cached values marked stale, or “Community stats unavailable — file processing stays local.” Do not use a TTL expiry to trigger requests.

For the user's explicit “reload gets latest” preference, use request cache `no-store` and response `Cache-Control: no-store` initially. This removes the current 30-second browser reuse ambiguity. If later accepting a shared cached snapshot to protect D1, choose an explicit bounded edge cache with snapshot timestamp and measure cache misses; freshness then means latest available snapshot, not latest write. It is optional and need not poll or prewarm. An HTTP header alone is not evidence that this cache exists.

On known-offline boot, show cached/unavailable stats without dispatching an API fetch; navigator.onLine is only a hint, so fetch failures must remain harmless. No retry when connectivity returns until the next reload. “Once per refresh” is a maximum attempt, not a requirement to send an impossible offline request.

## F. Offline strategy

| Scenario                                         | Current behavior                                                                                            | Proposed behavior                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A: cold open with no connection/cache            | Navigation cannot load app; no UI/compression. No app JS means no app API call.                             | First-ever offline visit still cannot work. After online setup, cached shell supports offline navigation.                       |
| A: previously visited then opened offline        | Ordinary HTTP cache may help; no guaranteed offline navigation.                                             | Versioned service-worker shell cache, with an explicit prepared/offline-ready status.                                           |
| B: loaded shell, unused engines, then disconnect | UI may remain, but lazy UI/scheduler/worker/codec/WASM loads can fail.                                      | Cache shell UI chunks; prepare engines only after explicit user action and memory admission. Show which capabilities are ready. |
| B/C: all required scripts/assets available       | Processing has no D1 dependency. Browser cache reuse is conditional.                                        | Serve exact versioned worker/module/WASM graph from Cache Storage, no API fallback dependence.                                  |
| C: select → process → ZIP → download             | Single input skips ZIP; multiple inputs require ZIP worker and dependencies. Missing assets block the path. | Test both direct output and multi-file ZIP offline using independently validated outputs.                                       |

Cache **application assets only**, never source files, output blobs, filenames or a telemetry queue. Cover transitive module dependencies, worker scripts, correct WASM MIME, fonts and optional UI chunks; caching just WASM is insufficient. Preserve the no-pre-interaction engine-fetch boundary: no install-time codec prefetch, periodic sync, background warming or periodic update checks. Offer explicit “Prepare offline engines” after interaction; cache engines actually used. Cache shell/codec versions coherently, retain assets needed by an active page and handle eviction or deployment mismatch honestly. Browser storage may be evicted; offline readiness is conditional on retained assets.

Missing engine assets need a clear local message and safe retry without losing the original File. A database outage, exhausted D1 quota or telemetry rejection must never produce a compression error. A missing processing engine is a real processing limitation and should be distinguished from unavailable community statistics.

## G. Request reduction and Cloudflare consumption

For P production document loads and successful consented batches with n_i eligible files:

- Current stats: P frontend fetch attempts in the normal mounted layout; at most P singleton SELECTs, fewer with cache hits/failures; more if remounted or development StrictMode reruns effects.
- Current telemetry: sum(min(3, ceil(n_i/20))) POST attempts; zero with consent off. Checked-in backend switch means **zero D1 writes today if deployed as configured**.
- With writes enabled: E = sum(min(n_i,60)) accepted events; E INSERTs and E trigger UPDATEs, plus unique/timestamp index maintenance. Rejections/duplicates change this. No post-compression stats reads.
- Proposed stats: at most P fetch attempts/SELECTs, guaranteed once per document; no idle traffic. This hardens an already low-read design, not a large normal-production read reduction.
- Proposed telemetry: at most one POST per successful foreground/online consented batch. For k occupied format/outcome buckets: one submission insert plus k bucket inserts and k aggregate updates in one atomic batch, with no per-file log. Index/dedup checks also cost work. Measure real D1 metadata before quoting billed row savings.

Example, 100 files in one format/outcome: A would use 100 POSTs; current code uses 3 POSTs and reports only 60 files (60 inserts + 60 counter updates); proposed uses 1 POST and reports all 100 (submission insert + bucket insert + aggregate update). For three files in the same bucket, current uses 1 POST and 6 table mutations; proposed remains 1 POST and 3 table mutations. For many distinct buckets there may be little write saving; batching is not automatically cheaper for every workload.

Cloudflare bills D1 by rows scanned/written, including index maintenance, rather than just HTTP requests or SQL statement count. Current documented Free allowances are 5 million rows read/day and 100,000 written/day; exhausted quotas cause query errors. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Pages Functions share Workers request allowances, while static requests are free/unlimited under Pages' documented model. [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/). Account plan and observed usage remain unverified.

The singleton primary key already optimizes current reads; do not add indexes blindly. Serving format breakdowns by GROUP BY over lifetime raw logs would introduce scans. Keep bounded format rollups instead. An explicit edge cache could reduce SELECTs on repeated public reads, but requests reaching a Function still invoke it even if its Cache API lookup hits; cache entries are data-center-local. [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/). Avoid adding KV, Durable Objects or a recurring aggregation service without measured need.

## H. Proposed database changes (not applied)

Append `0002_aggregate_telemetry.sql`; do not edit applied 0001. Proposed tables:

- `telemetry_submissions`: random submission_id primary key and server received_at; short-window deduplication only.
- `telemetry_submission_buckets`: submission_id + format + outcome composite primary key; file_count, input_bytes, output_bytes; strict nonnegative/relationship constraints.
- `format_stats`: format + outcome primary key; cumulative counts/input/output/saved and updated_at. Bounded by the allowlist/outcomes.

Use a bucket AFTER INSERT trigger to atomically increment its matching format rollup. Submission insert ON CONFLICT DO NOTHING and bucket composite uniqueness make replays non-additive. Validate an envelope before creating statements; execute all statements transactionally. Read all bounded format rows once, sum totals in the Function and derive category distribution; this yields one statement without scanning historical submissions. Estimated table mutations above include these triggers; exact billed reads/writes require local-D1/staging measurements.

Preserve legacy counters as explicitly labelled historical **processed** totals. Old logs do not contain transformed/preserved disposition; deleted raw history cannot reconstruct lifetime format distribution. Do not backfill an invented “compressed” classification. Start verified v2 compressed counters/distributions with a tracking-since date, or disclose that historical format coverage is partial. Avoid summing legacy totals and v2 rows during dual delivery. Keep the old handler compatible during migration, switch clients once, then retire v1 writes.

Keep the existing timestamp index until retention is decided. Submission/bucket receipt-time cleanup needs bounded indexed deletes while retaining lifetime format rollups. The blueprint requires 30-day raw retention; propose the same bound for deduplication data. A separate maintenance job would intentionally generate bounded server database writes, independent of idle pages; no frontend polling. If that is undesirable, design bounded opportunistic cleanup on actual writes and assess its budget first. No maintenance job is part of this implementation-free investigation.

## I. Proposed API changes

| Endpoint              | Proposal                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/api/stats`      | Consolidated validated totals + distribution + freshness/coverage; one bounded SELECT; honest 503 on failure; initially no-store.                                 |
| POST `/api/telemetry` | Strict versioned v2 aggregate envelopes; bounded integers/body/buckets; idempotent atomic writes; kill switch, origin checks, no-store, deployed rate protection. |
| GET `/api/telemetry`  | Deprecate duplicate stats interface; remove only after compatibility review. Prefer 405 over redirect-induced extra requests once retired.                        |

No file upload/download endpoint, polling endpoint, heartbeat or session identifier is proposed. Failures must never block processing. Rate rules, preview isolation and retention must be verified before enabling telemetry writes.

## J. Proposed UI and implementation sequence

Keep community stats secondary to local results. Suggested compact layout:

```text
COMMUNITY-REPORTED STATS · approximate, opt-in reports
12,482 files compressed     1.07 TB saved     58.7% weighted savings
Input 1.82 TB · Output 746 GB · Format breakdown
Stats retrieved: 10:42 PM · Counters last changed: 10:40 PM
Offline: showing saved snapshot from Oct 16, 10:42 PM
Local file processing is independent of community stats.
```

These are illustrative values, not current measurements. Use consistent byte units/rounding in the implementation. Existing updated_at is last database mutation, not fetch time; show these timestamps separately, with server UTC converted to local display. Do not create a timer solely to update “2 minutes ago”; an absolute timestamp stays truthful without recurring work. Show unavailable rather than fake zeroes. Format coverage/tracking date and legacy processed counts need clear labels.

Proposed order after review:

1. Record request/freshness/counting/privacy decisions in an ADR; approve the cross-domain contract before dependent implementation.
2. Implement shared boot snapshot, defensive response validation, stale fallback and timestamps; prove one attempt even across remounts, failure and StrictMode.
3. Add outcome-preserving result aggregation, v2 validation and append-only migration; independently verify idempotency/concurrent inserts, rollback, format sums and safe-integer boundaries.
4. Add foreground-only best-effort writes and consent/offline gates; prove completion/download success under rejection, timeout and unavailable D1. No stats invalidation.
5. Add explicitly prepared offline shell/asset support with coherent versions and no engine prefetch before interaction. Test cache eviction and missing assets.
6. Validate local Pages/D1, then isolated preview with deployed headers/rate rules/retention before enabling writes. Update progress with checks actually performed.

Acceptance checks: production and development boot counts; remount/reload; selection/presets/compression; simulated long idle; focus/visibility/online transitions; opt-out zero POSTs; offline consented completion; cancellation/failure cleanup; >60 files; >2 GiB aggregate; preserved originals versus compressed results; duplicate/concurrent submissions; stale/corrupt storage; cold/warm offline direct output and ZIP; independent output decode/extraction; accessibility and no-file-upload assertions.

## Validation performed and limits

- Node 24.18.0; fresh Vite production build passed via installed CLI, without application changes. This was `vite build`, not the complete `pnpm build` asset-preparation pipeline. pnpm's launcher attempted a registry lookup and failed under network restrictions.
- 28 existing tests passed across telemetry service, store, edge API and strict schema using installed Vitest CLI. `node scripts/db-test.mjs` passed actual in-memory SQLite migration/trigger/duplicate/constraint checks. This script is not a Cloudflare D1 integration test.
- Headless Edge against built static preview: one stats attempt on initial load; still one after a simulated four hours and dispatched visibility/focus/online signals. Stats response was mocked for this count check; this measured frontend attempts, not deployed Function invocations.
- Cold offline navigation in a fresh context failed with ERR_INTERNET_DISCONNECTED. Going offline after shell load with unvisited lazy paths produced failed JobStatus/scheduler/sink requests and no download during observation. No offline asset-readiness guarantee exists.
- With consent enabled, a two-file synthetic text ZIP completed despite an intentionally failed telemetry POST: one stats GET, one POST containing two allowlisted/rounded events, zero compression alerts and a ready download link. No filenames or file contents appeared in that captured POST; the unchanged sub-KiB files were reported as zero-byte original/output events, demonstrating the counting limitation.
- A valid synthetic PNG pair completed online. Repeating that same batch offline in the same page failed loading a newly created ZIP worker, despite prior use. Ordinary preview HTTP caching did not guarantee worker reuse. Vite preview does not apply Pages `_headers`, so this is an observed local-preview failure, not proof that every production warm-cache run fails. Offline file/ZIP download success remains unverified; explicit offline caching and production-equivalent tests are needed.
- Simulated events/time do not reproduce physical OS minimization, sleep, battery policies or hours of real device time. No remote database inspection, deployment, real Cloudflare billing measurement or physical-device certification was performed.
- Report formatting, code-fence balance, referenced source locations and consistency were reviewed. Full lint/typecheck/E2E/worker/size gates were not rerun for this report-only change; no implementation was changed. Relevant tests/build above are investigation evidence, not a release certification.
