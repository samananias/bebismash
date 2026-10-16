# 0006 — Compression outcomes and bounded video candidates

Date: 2026-10-16
Status: accepted for this implementation increment; broader capabilities remain gated
Owner: Core/integration, sequential UI and Media integration

## Context

Unchanged single files were offered as duplicate downloads. Video accumulated full source and candidate buffers despite range-readable input, and fixed preset bitrates could inflate already compressed sources. Office JPEG processing skipped larger images and did not apply Heavy resizing.

## Decision

Worker result metadata may include an optional local preservation reason. Version 1 envelopes remain compatible with producers omitting that field; the scheduler supplies a conservative reason and validates disposition, reason and byte counts. Reasons remain outside telemetry serialization. Completed-file metadata carries the reason locally.

A successful single-file analysis can return `archive: null` when the original is retained. No output credit, writable opening, sink close or Blob URL is created in that path. UI completion states explicitly explain the result. Multi-file ZIP batches continue to include unchanged originals. This supersedes ADR 0004 only for duplicate unchanged single-file delivery.

Save-picker names are bounded and sanitized, with validated extension/MIME filters. The picker runs in the trusted click, before processing imports. Current transforms retain source format, including MOV output; future conversions must select their output format before opening the picker. Picker-created empty placeholders cannot be ruled out.

Video uses File-backed BlobSource and a positioned StreamTarget backed by a preallocated admitted candidate. Admission retains the existing decoded-frame/container/encoder baseline and adds four candidate allowances for buffers/copies. The source size does not imply whole-input memory allocation. Output caps, actual pixel limits, validation and smaller-or-original behavior remain mandatory. Final delivery still uses transferable chunks and credited backpressure.

Adaptive rate budgeting accounts for audio and overhead using a conservative total-file estimate. It does not guarantee savings or quality. Unsupported track layouts preserve the source. Active output is canceled on failure/early return, input is disposed, and scheduler cancellation terminates the job worker.

Timing validation compares elapsed media after normalizing timestamp origins, accounts for finalized segment tail duration and checks first/last packet endpoints for each retained track within 50 ms. Unknown/omitted final-frame timing in some raw WebM recordings can still cause preservation; the tolerance is not widened to accept missing media.

Office reserves a 64 MiB image allowance and retains per-tier admission limits. Heavy scales eligible JPEGs to max edge 1280; Gentle preserves JPEG bytes. EXIF/ICC/IPTC-bearing JPEGs remain opaque until normalization/preservation is tested. No format changes or new dependencies are introduced. PDF parsed-object signature checks precede structural rewrites; PDF image optimization is not enabled.

## Alternatives

Removing only the disk Blob check leaves full input/output allocation problems. Sending unvalidated transformed bytes directly into ZIP prevents safe replacement. Returning every original hides capability limits and wastes storage.

## Consequences

Single generic files without a native transform now finish without a download; ZIP batches remain available for lossless packaging/compression. BatchResult consumers must handle absent output. A local preserved outcome can still be reported with telemetry consent, with zero savings.

Large sources may fit a bounded video candidate on suitable hardware, but candidate size, native codec peaks and physical-device limits remain. Persistent browser staging is prohibited. General PDF downsampling, standalone audio, palette quantization and alternative archive formats remain distinct future capabilities.

## Validation and rollout

See [progress.md](../progress.md) for checks actually run. Cover no-output sink behavior, transformed-output close failure, cancellation, large-source admission without allocation, original inclusion in ZIP, real range-read video encoding, independent browser playback, Office JPEG dimensions/XML retention, compressed PDF signature dictionaries, typed names, keyboard controls and no uploads. Physical-device memory and full media/document fidelity are release gates. Revert this increment's source changes to roll back; there are no database migrations.

## References

- [Revised investigation](../compression-limits-and-fidelity-investigation.md)
- [Engineering blueprint](../MASTER_ENGINEERING_BLUEPRINT.md)
- [ADR 0004](0004-direct-single-file-output.md)
- [Mediabunny input](https://mediabunny.dev/guide/reading-media-files) and [output](https://mediabunny.dev/guide/writing-media-files)
