# 0004 — Direct output for a single file

Date: 2026-10-16
Status: accepted
Owner: Core/Router integration

## Decision

At the user's request, one selected file downloads directly in its resulting format. Two or more files retain ZIP output. This supersedes the blueprint's ZIP-only delivery behavior for single-file runs; codec policies, validation, limits and privacy boundaries remain unchanged. Unknown files that have no direct-format compression operation are returned as their original bytes with the original-retained status, without inventing a gzip transformation or compression claim.

The scheduler skips ZIP worker creation for one file. After validated result metadata arrives, it opens the output sink with the sanitized output filename and MIME. Its MessagePort receiver accepts at most one 256 KiB transferred chunk, validates IDs/sequence/size, awaits sink acceptance and then grants the next credit. File-reading and codec execution remain in the admitted worker. Progress counts sink-accepted bytes; success waits for sink close. Cancellation terminates the worker, closes the port and aborts the selected sink. Partial files are not offered as downloads.

BatchResult gains an explicit file/zip packaging field while retaining its existing archive result property for internal compatibility. Blob sinks accept an output MIME; existing ZIP calls default to application/zip. Explicit local disk selection suggests the source filename for one file and ZIP for multiple files. Output labels and next-step copy follow the selected packaging mode.

## Validation

Unit tests exercise direct credit backpressure, transferable ownership, cancellation, write/close errors, filename/MIME, and retained multi-file ZIP lifecycle checks. Browser tests validate raw text/PNG/video downloads and filenames, independent media decoding, no ZIP worker for single-file text, and independently extracted multi-file ZIP entries. See [progress.md](../progress.md) for checks actually run.
