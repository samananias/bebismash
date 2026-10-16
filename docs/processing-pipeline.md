# Compression lifecycle audit — 2026-10-16

## Confirmed failure paths

1. **Prepared result mistaken for completion.** Image, video, PDF and Office workers sent result metadata before streaming output. The scheduler terminated each worker at `result`, before ZIP received its bytes. ZIP waited indefinitely. Generic files appeared more reliable because their result was previously sent after the final chunk.
2. **Progress disconnected.** The store never subscribed to scheduler events, and the two layers generated unrelated job IDs. Every file appeared active even while queued. Several workers fabricated stage percentages as fractions of input size.
3. **Unsettled failures.** Workers had no `error`/`messageerror` handlers or external deadlines. The scheduler set its resolved flag before sink close; close rejection was then ignored by its failure handler. Sink-open rejection also left the scheduler locked.
4. **ZIP backpressure and completion.** Producer credits ignored sink backlog, ACK accounting subtracted a constant rather than actual pending output, and ZIP completion could precede queued output delivery. Registering entries before preparation also lost output format information.
5. **Memory and runtime loading.** Reservations were calculated but not enforced. Video read the complete File and staged output/copies. A 300 MB input already exceeds every configured Blob cap (64/128/256 MiB). The PNG optimizer and AVIF package wrappers automatically chose multithreading even though job configuration disallowed it.

6. **Invalid smaller video candidates.** A real single-frame browser recording reproduced an empty converted container accepted as compressed output. Candidates now reopen successfully, retain video/audio track counts, contain media packets, and respect duration before ZIP commitment; discarded tracks cause original preservation.

These are code-confirmed failure paths, not a diagnosis of a supplied user recording or original private video. No private fixtures were available.

## Lifecycle after the fix

| Phase                         | Execution and visible evidence                                                           | Completion / failure condition                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Select files                  | Store holds metadata; File handles stay in an external registry                          | No codec or file upload                                                         |
| Validate and select engine    | Signature slice, memory admission, stable job/attempt IDs                                | Clear file/output limit errors; original-only routing when necessary            |
| Start ZIP / processing worker | Explicit worker-start stage, native error/messageerror handlers                          | ZIP ready acknowledgment; external execution deadline                           |
| Load engine                   | Named engine module; actual WASM download bytes and total if known                       | HTTP/MIME/read errors surface; cached label requires resource timing evidence   |
| Initialize                    | WASM stream completion / actual instantiate call; native video conversion initialization | Ready after successful instantiation; indeterminate when unmeasurable           |
| Prepare / analyze input       | Reserved worker reads; video track inspection via BlobSource range reads                 | Header/pixel/input limits; inspected source dimensions and codecs in details    |
| Transform / encode            | Actual codec stage, elapsed time, native video conversion timeline ratio                 | No manufactured image/document percentage; bounded output and external deadline |
| Prepare output                | Result metadata and original/transformed disposition                                     | Producer retains its output and waits for ZIP credit                            |
| Package ZIP                   | One active entry, 256 KiB transferable chunks, sink ACK gates producer credit            | `entry-packed` permits producer termination; final ACK permits ZIP completion   |
| Save                          | Serialized sink writes and explicit close                                                | Download ready only after close; any failure discards partial archive           |
| Cancel / retry                | Worker termination, port close, bounded sink abort, retained original handles            | Retry creates a new archive and new attempts; stale events cannot update state  |

## Status and privacy semantics

Each file shows its stage, measured progress when available, elapsed time and next step. The expandable details panel includes engine, worker/attempt, inspected video information, estimated memory reservation, heartbeat, progress timestamp, asset states, and bounded errors. Actual browser memory and per-frame counts are not invented. No-progress warnings appear after 30 seconds without changed counters/stages; heartbeat events do not reset that timestamp. Busy synchronous WASM can suppress heartbeats, so the UI warns without claiming a definite deadlock. Wait dismisses the warning for another 30 seconds; cancellation can terminate non-yielding worker code.

JavaScript import download sizes are unavailable through native import and remain indeterminate. WASM downloads use existing browser HTTP caching; cached status is shown only with evidence. Fetching a cached asset still goes through the browser cache lookup and may revalidate according to server headers. Compressed responses and missing Content-Length display received bytes without a percentage. There is no FFmpeg dependency/core in this checkout. Video uses Mediabunny and browser WebCodecs. Unknown opaque formats remain eligible for original packaging by contract; malformed recognized images report an input error.

Cancellation applies to the batch because ZIP entries cannot be replaced transactionally. Source names/content and local diagnostic details never enter telemetry. Processing and engine preparation do not require telemetry consent.

## Validation matrix

| Scenario                                            | Coverage                                                                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real video                                          | Browser-recorded single-frame and moving VP8 clips, real track inspection, ZIP extraction and independent browser metadata decode; unit rejection of an empty finalized container        |
| Approximately 100 KB / 500 KB / 1 MB / 10 MB images | Real synthetic noise PNGs through built image/WASM/ZIP workers, ZIP extraction and independent browser image decode                                                                      |
| 50 MB / 300 MB video                                | Synthetic File-size admission tests: preserve through bounded original disk route; 300 MB Blob output refuses before whole-file allocation. These are not full-size transcode benchmarks |
| Unsupported / malformed format                      | Browser malformed-image error; unknown files package original contents                                                                                                                   |
| Engine download failure                             | Browser HTTP 503 failure and successful fresh-worker retry; unit HTML/MIME rejection                                                                                                     |
| Worker failure                                      | Browser injected worker error/retry; scheduler crash and messageerror rejection tests                                                                                                    |
| Memory pressure                                     | Reservation refusal/original routing tests; hard archive/pixel/output limits. No physical OOM injection/certification                                                                    |
| Cached engine                                       | Unit resource timing evidence, real byte counters and cache status; browser HTTP cache policy remains host dependent                                                                     |
| Cancellation                                        | Browser cancel/retry; scheduler termination and cleanup; stale result protection                                                                                                         |
| Multiple files                                      | Independent stable IDs/states, two actual media worker results and independently extracted ZIP entries                                                                                   |
| Slow ZIP sink                                       | Real built ZIP worker with withheld ACK; no additional producer credit or premature completion; independently unzipped bytes                                                             |
| Stalls                                              | Injected worker with real fixed frame counter and heartbeats; 30-second warning, Wait and cancel without fabricated percentage                                                           |

## Remaining release gates

Full-length 50/300 MB WebCodecs transcodes, physical mobile memory peaks, Firefox/WebKit execution, and broader video fidelity (tracks, orientation, timestamps, A/V sync) remain release validation work. Unsupported or oversized heavy video is preserved or refused, not advertised as compressed. Engine switching is not offered because no second video engine is installed.

The existing `assets:prepare` script emits an empty manifest; Vite emits the codec WASM assets, but pinned codec asset hashes/licenses are still a supply-chain release gate. The existing size checker enforces ADR 0001's 80,000-byte cap. This conflicts with AGENTS.md's stricter 50,000-byte requirement; this change does not relax either threshold or claim compliance with the stricter one. Current check results are recorded in [progress.md](progress.md).
