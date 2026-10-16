# 0003 — Observable worker lifecycle and bounded archive handoff

Date: 2026-10-16
Status: accepted
Owner: Core/Router integration

## Context

Media workers announce `result` before waiting for ZIP entry credit. The scheduler terminated them on this announcement, leaving ZIP with an incomplete entry. UI file IDs differed from scheduler IDs and the store did not subscribe to events. ZIP completion preceded acknowledgment of final output, and sink-close errors could leave the batch promise unresolved. Automatic threaded PNG/AVIF initialization also bypassed the scheduler's single-thread policy.

## Decision

Keep `result` as preparation metadata. Register the entry only after it arrives and terminate the producer only after `entry-packed`. Require final sink acknowledgment and successful sink close before batch success. Generic workers also announce preparation before receiving credit. Admit jobs sequentially and account for retained Blob bytes, control buffers, full-buffer video copies and decoded image pixels before large allocations. Preserve original bytes through bounded File slices or refuse when the selected sink cannot fit them.

Wire version 1 gains metadata-only `status`, `asset`, and `heartbeat` events, additional stage names, optional inspected video capabilities and bounded local error details. Deliver the shared contract and all workers together. These fields are local diagnostics and are excluded from telemetry. Progress sequence numbers increase within each stage; transport chunk sequences are independent. Heartbeats demonstrate event-loop responsiveness, never measured processing progress. A 30-second quiet interval produces a warning with Wait and Cancel & retry batch; bounded external deadlines remain 30 seconds for images, 60 seconds for documents, and 10 minutes for video/original streaming. Cancellation terminates workers immediately, closes retained ports, and bounds waiting for sink abort to 250 ms. Partial archives are discarded on retry.

Observe actual WASM fetch streams and instantiation inside admitted workers. Name assets from their static URLs, count received bytes, and omit percentages when response length is unavailable or encoded. Report cached status only when same-origin resource timing supplies evidence. Native JavaScript module loading remains indeterminate and browser cache managed. Explicitly select single-threaded oxipng and AVIF factories; no hidden thread pools. Browser codecs do not download an FFmpeg core: FFmpeg is absent from this implementation.

## Consequences

Long non-yielding WASM phases can prevent heartbeats even while computing; the warning says this explicitly and does not automatically terminate at the warning threshold. Memory reservations are policy estimates, not browser heap measurements. Current video conversion stages its full candidate; large transcodes remain gated and can preserve originals on an explicitly selected disk sink. Physical-device certification remains required. WASM fetch/instantiation observers are scoped to one disposable worker and restored after preparation; native implementations receive their original arguments and responses retain WASM MIME.

No dependency versions, telemetry schema, migrations or production infrastructure change. Existing codec fidelity limitations remain. See [pipeline audit](../processing-pipeline.md) for lifecycle, tests and remaining gates.
