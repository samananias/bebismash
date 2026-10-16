# 0005 — Local-first statistics and prepared offline assets

Date: 2026-10-16
Status: accepted for implementation; deployment remains gated
Owner: Core/Router integration; serial implementation across core, UI and edge

## Decision

Implement the approved [investigation plan](../edge/database-offline-telemetry-investigation.md).
One memoized, bounded stats attempt per document; no focus, reconnect, mount or processing refetch.
Cache only a validated public snapshot in localStorage. Read bounded format rollups in one SQL statement.
Keep legacy processed totals distinct from v2 compressed counts; do not infer historical outcomes.

Telemetry v2 aggregates rounded sizes by input extension and transformed/preserved outcome.
Send at most one foreground, online, consented request after successful batch output, with no
beacon, keepalive, persistent queue or retry. Preserve the existing v1 endpoint during rollout.
Store one submission with JSON aggregate buckets, rather than separate submission/bucket tables:
an insert trigger uses json_each to update bounded format rollups atomically. This deduplicates
the entire submission, including replays with changed buckets, and requires one insert statement.
Records become eligible for cleanup after 30 days; bounded opportunistic deletes run on real
writes (100 old rows per table per request), never browser polling or a new cron service.
This does not guarantee timed deletion while no writes occur. The deduplication window is finite.

Offline preparation is explicit and caches only the build's allowlisted shell, fonts, workers,
modules and WASM. A generated service worker fetches sequentially within a declared build-size
budget after user interaction; no engine executes or decodes files during preparation. Cache
Storage writes stream in the worker, not main-thread binary buffers. Installation alone fetches
no engines. APIs and user output never enter Cache Storage. No periodic sync/update checks.
Browser-managed service-worker update checks on navigation remain possible, but never query D1.
Do not skip waiting across builds; old controlled pages keep their coherent asset version.

## Consequences and validation

Telemetry can be lost when hidden/offline; original files and downloads remain independent.
Cache eviction removes offline readiness; first-ever offline visits cannot load the application.
No production telemetry enablement until rate protection, preview migrations and retention are
verified. Migrations are append-only. Tests cover SQL rollback/deduplication, response validation,
request counts, privacy, missing assets and real offline output. Existing codec fidelity and
physical-device gates apply. The pre-existing cold-load budget failure remains visible.
