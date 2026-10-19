# ADR 0008: Independent PDF stream and image compression

- Status: Implemented locally; release and affected-domain review gates remain open
- Date: 2026-10-19
- Supersedes: ADR 0007's blanket missing-reference and unsupported-association refusal behavior; metadata consent remains unchanged

## Context

Every PDF preset previously used structural rewriting only. Unsupported optional metadata cleanup canceled the entire operation, and incorrect null-reference and conformance detection rejected the supplied sample. The screenshot's Heavy mode did no image encoding. See the [complete investigation, safeguard audit and measurements](../pdf-compression-implementation-audit.md).

## Decision

Work sequentially across Core/Media/UI ownership. Core adds optional `ResourceLimits.pdfImageWorkingBytes`, bounded `PdfDiagnostics` on worker results, and the `conformance_document` preservation reason. Diagnostics never expand telemetry and carry no names, content, metadata values, hashes or binary payloads. The existing result contract and direct/ZIP transport retain original fallback, transfers, caps and sink acknowledgment.

Gentle performs lossless stream/object compression and unreachable-object reclamation, retaining image samples. Balanced uses actual JPEG Q75 and supported placement targets of 150 DPI; Heavy uses Q55 and 96 DPI. Raw/Flate/DCT 8-bit DeviceRGB/DeviceGray images form the initial lossy subset. Images are processed sequentially with an additional admitted allowance up to 128 MiB and 20 bytes per source pixel, bounded by existing hard caps. The scheduler uses only spare budget; constrained devices can still preserve/refuse the original. Codec loading is lazy inside admitted workers.

Placement analysis includes all supported page/Form uses, shared maximum size, transforms and UserUnit. Unknown uses disable resizing but permit quality-only encoding. CMYK/ICC, masks, predictors and unsupported image features remain lossless. JPEG APP1/APP13 packets stay identical; profile-bearing APP2 inputs are excluded. Image failures/larger candidates preserve that image while independent compression continues. Never rasterize the whole PDF or claim unimplemented font/deduplication/monochrome operations.

Normalize nonexistent indirect references to explicit null before new allocation, following PDF null semantics. Required catalog/page parsing, strict protection checks, supported trailers, complete bounded reachability and cancellation remain prerequisites for GC. Generic `pdfx/1.3` does not declare PDF/X; actual conformance identifiers and unreadable document-level XMP preserve the original. Parsed protection objects replace byte-text false positives.

Metadata removal is a separate opt-in pass. Unsupported associations stay live without canceling other optimization. Detach only supported Type Metadata/Subtype XML associations; simulate reachability excluding exactly those accepted owners. Info, forms/XFA, attachments, annotations, text, vectors, resources and unknown entries remain. Independent lossless stream compression may change stored bytes but must preserve decoded payloads.

Reopen and compare the planned retained graph after serialization, then deliver only a strictly smaller candidate. Independent pypdf/PDFium checks compare source decoded non-image content, all-page text/geometry and sampled rendering. A valid post-transform graph is not a claim of universal semantic fidelity or conformance preservation.

## Consequences

The user's 26,105,613-byte original becomes 8,618,437 / 7,392,435 / 7,324,679 bytes with opt-in cleanup at Gentle/Balanced/Heavy in the actual Edge browser pipeline. Without cleanup it still compresses to 13,808,304 / 12,572,046 / 12,504,367. Unsupported metadata no longer forces the original. The remaining 49 CMYK images explain modest Balanced-to-Heavy differences for this document; synthetic RGB/gray fixtures demonstrate the different settings and outputs.

No new application dependency or engine/license is introduced. Physical-device/process-memory evidence and affected-domain review remain release gates. The pre-existing 50,000-byte contract versus 80,000-byte script discrepancy is unchanged and remains open. See [progress](../progress.md) for executed checks and limits.
