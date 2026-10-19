# PDF compression improvement plan

Prepared: 2026-10-17 (Asia/Manila)
Planned work: 2026-10-18 / next implementation session
Status: Planning only. Do not implement, install dependencies, change configuration, commit or deploy as part of preparing this document.

Implementation update (2026-10-19): the user authorized implementation in a subsequent session. Both selective metadata cleanup and the supported RGB/gray image increment are implemented locally; see [ADR 0008](adr/0008-pdf-stream-and-image-compression.md), the [safeguard audit and actual benchmarks](pdf-compression-implementation-audit.md), and [progress](progress.md). The user's 26,105,613-byte original now becomes 7,324,679 bytes in the actual Heavy browser flow with supported XMP removal. Missing optional references use PDF null semantics; ambiguous metadata stays while other compression proceeds. This supersedes the earlier [ADR 0007](adr/0007-explicit-pdf-metadata-cleanup.md) sample refusal. Physical-device memory certification, affected-domain review and the strict cold graph budget remain release gates. The preparation-only restrictions above describe the original planning session; the detailed plan below is historical where ADR 0008 supersedes it.

This document schedules no automation. Implementation starts only in a later session when the user asks to proceed. It supersedes the image-first ordering for PDF work in [the investigation](compression-limits-and-fidelity-investigation.md), while retaining the [engineering blueprint](MASTER_ENGINEERING_BLUEPRINT.md) boundaries.

## Objective

Close the measured PDF size gap through explicit metadata cleanup first, then evaluate image optimization. Preserve searchable text, page geometry, images, forms, annotations and document structure within the supported capability. Keep processing on-device and maintain existing memory admission, cancellation and original fallback.

Do not promise universal compression percentages or exact reproduction of another service's output.

## Evidence already collected

The supplied outputs contain the same 706 pages. Measurements are decimal MB:

| Result                            |      Bytes |    MB | Reduction from supplied baseline |
| --------------------------------- | ---------: | ----: | -------------------------------: |
| Supplied baseline                 | 25,426,294 | 25.43 |                                — |
| Supplied comparison               |  6,637,520 |  6.64 |                            73.9% |
| Local metadata-cleanup experiment |  8,971,816 |  8.97 |                            64.7% |

The baseline contains 388 reachable XML metadata streams totaling 16,188,658 bytes. Its 50 image payloads occupy 3,632,709 bytes. The comparison contains no XML metadata streams and 1,213,696 image bytes. Removing metadata plus reclaiming unreachable objects closed approximately 87.6% of the observed byte gap in a local experiment.

The experiment retained all original stored image payloads and all page-content streams byte-for-byte. Independent extraction matched text on every page. Geometry matched on every page; six rendered samples were pixel-identical. This does not establish full semantic equivalence, all-page rendering equivalence or browser memory safety. XMP metadata was removed deliberately.

Detailed evidence and limitations are in [the findings](pdf-comparison-findings.md). The experimental derivative is separate from application output. No application source, dependency or configuration was changed during this investigation. Private PDFs must not become committed fixtures.

## Scope for the first implementation increment

### 1. Freeze the cleanup policy and contract

Core/integration owns shared types and policy propagation. Propose a document-policy option such as `pdfMetadata: 'preserve' | 'remove-xmp'`, with omission resolving to `preserve` for existing callers. Confirm the final name before dependent edits.

- Preserve metadata by default, including Gentle. Selecting a stronger preset must not silently authorize XMP removal.
- Require a visible, explicit cleanup choice. Proposed label: “Remove embedded PDF metadata.” Explain that provenance, editing history and rights information may be removed while page content is retained.
- Do not describe the option as a complete privacy sanitizer or claim every hidden property is removed.
- Keep binary ownership outside Zustand. Store only the setting and bounded result diagnostics.
- Keep cleanup counts local; do not expand the telemetry schema or transmit filenames, hashes, extracted metadata or content.
- Obtain affected Media/UI contract review before merging dependent work. Work sequentially in the existing ownership domains; do not introduce concurrent edits across role paths.

### 2. Build a bounded cleanup adapter

Media owns the PDF adapter. Operate only inside an admitted worker job after strict parsing and protection checks.

1. Preserve signed/encrypted inputs. Detect PDF/A and PDF/X constraints before offering cleanup; preserve or reject unsupported conformance-sensitive cases. Do not claim continued archival/print conformance after rewriting without verification.
2. Remove only a recognized `Metadata` association whose target is a supported metadata stream. Validate target type/subtype. Never identify disposable data solely by `/XML`, stream size, filename, text content or a guessed object number.
3. Retain document information fields, XFA/form data, annotations, attachments, embedded files, text, fonts, images, resources and unknown entries unless an explicitly supported rule requires otherwise. An ambiguous association must be preserved or cause cleanup refusal.
4. Traverse indirect references from every supported trailer root, including Root, Info and applicable Encrypt/ID objects. Include dictionaries, arrays and stream dictionaries. Use iterative traversal, cycle detection, bounded node/reference counts and a deadline; avoid recursive stack exhaustion.
5. Treat unresolved references or unsupported graph semantics as a reason to preserve the original. Never infer that an object is safe to delete merely because the traversal failed to understand it.
6. Reclaim only objects proven unreachable after the permitted metadata detachment. Removing dictionary keys alone can leave the large streams serialized in pdf-lib's context.
7. Keep parser, traversal bookkeeping, candidate serialization and validation within the admitted reservation. Add no full-document image decode or persistent browser staging. Yield/check cancellation during bounded graph work, and retain the worker watchdog/termination fallback.
8. Reopen the candidate and validate supported invariants before size comparison. Choose a smaller valid candidate; otherwise retain the original with an accurate reason.

Keep metadata removal and reachability analysis separate so each can be tested independently. Establish the complete reference traversal before deleting any object. Do not add broad font deduplication, action removal or arbitrary dictionary cleanup to this increment.

### 3. Integrate the choice and result explanation

UI/State exposes the option only where its scope is clear. Preserve the current visual system.

- Make cleanup opt-in and keyboard-accessible, with a persistent label and clear explanation.
- Lock the setting while processing. Define whether it applies to all PDFs in a batch and make that behavior visible.
- For an accepted candidate, describe what happened without claiming zero information loss: “Smaller PDF ready; embedded metadata removed.”
- If cleanup is unsupported or exceeds memory, explain that cause. Do not call the input already optimal.
- Preserve current unchanged-single-file behavior: no duplicate writable, Blob URL or download. Mixed ZIP batches retain original entries.
- Preserve the trusted-click save-picker flow, correct filename/MIME, original File retention and no-upload behavior.

### 4. Verify on synthetic fixtures, then the local comparison

Use small synthetic/public fixtures in committed tests. Keep the supplied PDFs outside the test fixture manifest and do not commit generated derivatives, rendered pages or traces.

Required fixtures and assertions:

| Area                 | Required evidence                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Default preservation | Metadata remains present and its decoded bytes unchanged without opt-in                                                |
| Explicit cleanup     | Recognized XMP association removed; unsupported XML and unrelated data retained                                        |
| Shared references    | Shared metadata/resources, nested dictionaries, arrays and cycles do not cause missing objects or duplicate traversal  |
| Malformed input      | Missing references, incorrect metadata target types, deep/wide graphs and deadline exhaustion fail conservatively      |
| Protected documents  | Signed/encrypted and unsupported PDF/A/PDF/X inputs remain original or are clearly rejected                            |
| Document fidelity    | Text, geometry, forms, annotations, attachments and image/font/content payloads retained for supported transformations |
| Original fallback    | Larger candidate, validation failure and memory refusal preserve original bytes with accurate status                   |
| Lifecycle            | Cancellation during parsing/traversal/save/pack, worker failure, port cleanup and sink failure settle the batch        |
| Transport            | Transferable standalone chunks, output caps and slow-sink/backpressure behavior remain enforced                        |
| UI/privacy           | Keyboard flow, locked setting, no duplicate single save, correct ZIP inclusion and no source upload                    |

Use an independent reader/renderer for fidelity checks. Reopening with the writer alone is insufficient. Test form field data and widget appearances where applicable; a visually correct page does not prove interactive form preservation.

On the supplied local sample, aim to reproduce approximately the measured 8.97 MB metadata-only result before touching images. Record exact achieved bytes, time, device/browser, memory tier, admitted reservation and actual memory evidence where available. This is a local acceptance benchmark, not a private-file dependency for CI or a universal size promise. Inspect representative pages visually and compare all-page text/geometry/content payloads.

Run repository format/lint/typecheck, applicable unit and worker/E2E suites, asset preparation, production build and size checks. Record what actually ran. Database tests are unnecessary unless edge/database paths change. The existing strict 50,000-byte cold graph gap must remain visible; do not relax a gate to ship this work.

## Second increment: close the remaining image gap

Begin only after the cleanup increment is independently validated.

1. Inventory filter, color-space, bit-depth, mask and placement capabilities. Start with a tested JPEG DeviceRGB/DeviceGray subset, not all images.
2. Resolve effective placement DPI across every use of shared images, nested Form XObjects, transforms and page units. Preserve unsupported cases.
3. Reserve image decode/resize/encode memory in addition to parser/candidate costs. Process images sequentially and retain current hard pixel/output caps.
4. Use the blueprint's Balanced 150 DPI/Q75 and Heavy 96 DPI/Q55 as tested targets where placement analysis permits. Gentle does not downsample.
5. Preserve text/vectors/forms/tagging; never rasterize the full document to imitate compression.
6. Treat CMYK/ICC/Decode-array handling as a separate fidelity gate. The supplied comparison includes many CMYK images, so a simple RGB adapter cannot reproduce its full optimization safely.
7. Validate image readability, color, masks, text, annotations, forms and independent rendered pages. Include fine-detail diagrams and small-text scans.

The remaining difference between the cleanup experiment and comparison is approximately 2.33 MB, consistent with the observed image-payload reduction. Reaching approximately 6–7 MB for this input is a plausible target to test, not an achieved application result or an exact guarantee.

## Memory and compatibility boundaries

The 25.43 MB sample can exceed the constrained tier's current full-parser reservation. No checkbox or disk destination overrides that boundary. Test suitable desktop admission first; preserve/refuse on constrained devices until measured capability supports a different policy. Disk output does not make parsing, decoding or serialization constant-memory.

Avoid new dependencies initially. Reuse the pinned pdf-lib and existing worker architecture. Any specialized PDF engine, codec, license change, memory-policy change or persistent staging proposal needs a separate reviewed decision. Browser and physical-device certification remain distinct from the local Node experiment.

## Completion and handoff

The first increment is complete only when the explicit choice works end-to-end, synthetic regressions and applicable checks pass, independently validated output demonstrates the claimed behavior, and docs record limitations and unrun checks. Update progress and a new ADR for the finalized policy/contract. Do not report the image increment as implemented when only cleanup has shipped.

Tomorrow's starting point: review this plan and the findings, inspect the current worktree, then implement the cleanup policy/contract first. No implementation, commit, deployment, scheduled job or additional file transformation is authorized by this planning document itself.
