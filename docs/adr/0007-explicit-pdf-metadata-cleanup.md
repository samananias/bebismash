# 0007 — Explicit, bounded PDF metadata cleanup

Date: 2026-10-19 (Asia/Manila)
Status: implemented for the supported subset; local-sample compatibility and release gates remain open
Owner: Core/integration, sequential Media and UI integration

Update (2026-10-19): [ADR 0008](0008-pdf-stream-and-image-compression.md) supersedes blanket missing-reference/unsupported-association refusal and closes the local supplied-source acceptance benchmark. Metadata consent and selective association boundaries remain. The decisions and measurements below describe the first increment.

## Context

The PDF investigation found a large metadata contribution, but its permissive experiment detached arbitrary Metadata keys. That experiment is insufficient authority to delete ambiguous associations in application output. Metadata can carry provenance, history and rights information; stronger compression presets do not authorize its removal.

## Decision

`DocumentPolicy.pdfMetadata?: 'preserve' | 'remove-xmp'` is additive to the existing v1 job contract. Omission preserves metadata for every intensity, including Gentle. The visible native checkbox applies to all supported PDFs in the batch, is locked during processing and completion, and resets to preservation on New batch. Its explanation discloses information removal and avoids claiming complete sanitization. The settings module loads only after file selection.

The admitted PDF worker performs strict pdf-lib loading with metadata and field-appearance updates disabled. An iterative inspection covers compressed objects, nested dictionaries, arrays and stream dictionaries for signature markers. Signed/encrypted inputs remain original. Reachability checks all supported trailer roots (Root, Info, Encrypt and ID); custom trailer/xref roots that pdf-lib cannot retain cause refusal. Raw trailer-token checks may conservatively refuse stream content resembling a trailer. This is a bounded supported subset, not a complete independent PDF parser.

Cleanup accepts only a Metadata association resolving to a raw stream with Type Metadata and Subtype XML. Unrecognized associations, unresolved references, unknown object semantics, unsupported filters/encodings and PDF/A/PDF/X indicators cause original fallback. Conformance inspection supports UTF-8 XMP with no filter or a single FlateDecode filter without DecodeParms; it refuses entity declarations and normalizes numeric character references before checking conformance indicators. It does not certify archival or print conformance.

Metadata detachment and reference traversal are separate operations. A complete traversal first validates the original graph. A second traversal simulates detachment and establishes reachability before any keys or objects are deleted. Shared metadata streams referenced by other entries remain present. Info fields, forms/XFA, annotations, attachments, resources and unknown entries are retained; only objects proven unreachable after allowed detachment are reclaimed.

Each walk is capped at 100,000 visited nodes and 400,000 edges, with iterative worklists, cycle detection, deadline checks and cooperative yielding. Each decoded metadata packet is capped at 2 MiB; Flate input is fed in 1 KiB chunks. These bounds use the existing `6 * inputBytes + 64 MiB` PDF reservation, not an admission override. Parser and serializer yields plus scheduler watchdog/termination remain necessary; a cooperative check cannot interrupt every internal parser operation. Full-parser native/browser peaks are not certified by these structural bounds.

Before size comparison, the candidate reopens and its page count, trailer roots, retained dictionaries, arrays, primitive values, references and raw stream payloads are compared. Stable references must resolve. No image decode, resize, font rewriting, field-appearance regeneration or persistent staging is introduced. Only a smaller validated candidate is delivered. Failure/refusal retains original bytes; one unchanged input creates no duplicate writable/Blob/download, while ZIP batches include the original.

Optional `pdfMetadataRemoved` counts detached associations (not necessarily reclaimed streams), is bounded at the scheduler, and appears only on accepted transformed PDF results after explicit consent. The new local `cleanup_unsupported` reason covers unsupported cleanup semantics and configured processing bounds. Neither field expands telemetry serialization. Binary ownership and credited transferable output remain unchanged.

## Alternatives

Removing every Metadata key or every XML stream would reproduce the permissive prototype more closely but violates the conservative association rule. Rasterizing pages loses searchable text and structure. Broad image optimization and new PDF engines remain separate decisions with memory, fidelity and licensing gates.

## Validation and rollout

See [progress](../progress.md) for actual checks. Synthetic fixtures exercise metadata defaults, recognized/shared/unrelated XML, cycles, malformed references/types, custom trailer roots, conformance markers, graph/time bounds, cancellation, output caps, reopening failures and retained form/annotation/attachment/image/content data. Independent pypdf/PDFium checks supplement reopening with the writer. Browser flows cover keyboard consent, locking, no uploads, direct output and original ZIP inclusion. Existing transport/sink/lifecycle suites remain applicable.

The supplied 25,426,294-byte PDF is preserved: strict inspection finds unresolved references and ambiguous Metadata targets, including streams without supported Type/Subtype declarations. The application therefore does **not** reproduce the 8,971,816-byte experimental result. Supporting those cases needs a separately justified recognition rule and fidelity evidence, without weakening missing-reference refusal. No image increment is implemented. Physical-device memory certification, full cross-browser release coverage beyond the new PDF flows, affected-domain review before merge and the strict 50,000-byte cold graph remain release gates. No dependency, telemetry schema, migration or deployment changes are required.

## References

- [Implementation plan](../pdf-compression-next-day-plan.md)
- [Comparison evidence](../pdf-comparison-findings.md)
- [Engineering blueprint](../MASTER_ENGINEERING_BLUEPRINT.md)
- [ADR 0006](0006-compression-outcomes-and-bounded-video.md)
