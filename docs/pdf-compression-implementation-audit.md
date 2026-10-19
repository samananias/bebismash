# PDF compression implementation audit

Date: 2026-10-19. This supersedes the sample refusal and deferred-image status in the first implementation entry of [the plan](pdf-compression-next-day-plan.md) and [ADR 0007](adr/0007-explicit-pdf-metadata-cleanup.md). Final contracts are in [ADR 0008](adr/0008-pdf-stream-and-image-compression.md).

## Root causes

The screenshot was an implementation failure, with several independent causes:

1. Every PDF preset selected `pdfMode: rewrite`, `targetDpi: null`. Image-quality values existed in the document policy but the PDF adapter never used them. Heavy performed no image encoding or downsampling.
2. `pdf-lib` object-stream serialization packs PDF objects; it does not automatically compress every existing raw content/XML stream. Large uncompressed metadata survived a nominal rewrite.
3. Optional metadata cleanup shared a whole-job refusal path. One unsupported association canceled all compression and returned the exact source File, causing the truthful but unhelpful UNCHANGED result.
4. Graph inspection treated every missing indirect reference as fatal. The supplied original contains 238 references to absent optional objects (215 `/Pg`, 23 `/Metadata`). PDF indirect references to nonexistent objects have null semantics; normalizing these before new object allocation preserves that meaning and avoids accidental reference reuse. This follows ISO 32000-2 §7.3.9, also documented by [qpdf](https://qpdf.readthedocs.io/en/stable/design.html) and the [ISO text hosted by Adobe](https://developer.adobe.com/document-services/docs/assets/5b15559b96303194340b99820d3a70fa/PDF_ISO_32000-2.pdf). Required page/catalog structure still has to parse.
5. The conformance check confused Adobe's generic `pdfx/1.3` custom-property namespace with PDF/X identification. These are distinct namespaces in [Adobe's XMP constants](https://developer.adobe.com/experience-manager/reference-materials/cloud-service/javadoc/com/adobe/xmp/XMPConst.html); PDF/A/PDF/X identification is described by the [PDF Association](https://pdfa.org/discovering-pdf-metadata/). Actual identification properties and output intents still preserve the original.
6. Byte searches for `/Encrypt`, `/ByteRange`, or `/Type /Sig` could mistake printed text for protection. These are now hints; parsed encryption/signature objects determine refusal. The inspection covers all loaded objects, including unreachable signature objects.

The source's content also limits the remaining reduction: 49 of its 50 JPEG images use CMYK. Lossy CMYK/ICC handling is outside the verified adapter. Those images retain their JPEG payloads; a lossless Flate envelope can still make their stored representation smaller.

## Pipeline trace after the fix

1. File selection retains browser File handles. Async sniffing identifies PDF and the selected preset creates the document policy. The separate metadata checkbox defaults to preserve at every preset.
2. Scheduler admission reserves `6 * sourceBytes + 64 MiB` for the existing parser/candidate path, plus up to 128 MiB of **available** working allowance for sequential image processing. Existing retained-output/control costs and tier budget still apply. The worker receives this explicit allowance in `ResourceLimits.pdfImageWorkingBytes`; pixel allocation checks use 20 bytes per source pixel and existing hard pixel caps. No checkbox or disk destination overrides admission.
3. A dedicated PDF worker lazily imports the adapter after admission, reads the source asynchronously, and checks the header, input bounds, strict parser, loaded protection objects and supported trailer roots.
4. Missing references become explicit PDF nulls before new objects are allocated. Bounded graph traversal and conformance inspection complete before any unreachable-object removal.
5. Optional cleanup plans only recognized `Metadata` associations to `Type Metadata / Subtype XML`. Unsupported associations remain. Reachability simulation skips only accepted associations, so an unsupported live stream is never reclaimed by an overbroad simulation.
6. The complete retained graph determines unreachable objects. No arbitrary resource, font, annotation, form, action or attachment deletion is permitted.
7. Lossless stream compression independently handles unfiltered and supported Flate streams, with per-stream and aggregate expansion bounds. JPEG streams may receive a lossless Flate/DCT filter chain. A larger stream candidate is discarded.
8. Balanced/Heavy inventory images, analyze every supported placement, and encode eligible RGB/gray images using the existing MozJPEG adapter. Shared-image maximum use, nested Form matrices and page UserUnit determine downsampling. Uncertain placement disables resizing but permits quality-only encoding. Masks, color profiles and unsupported filters remain intact.
9. Serialization uses object streams, without updating metadata or field appearances. The output reopens with strict parsing, matching page count and retained object/reference/dictionary/array/stream values after the planned transforms. This validates serialization; independent tests additionally compare source decoded non-image streams and render results.
10. Only a validated, strictly smaller final candidate becomes transformed output. Otherwise the original remains, with a specific refusal phase/reason. Existing transferable chunk transport, output caps, producer credits and sink acknowledgment still govern delivery. A single unchanged File creates no duplicate download; a mixed ZIP retains original bytes.

## Profiles actually sent to the worker

| Operation                                                                            | Gentle                 | Balanced                | Heavy                   |
| ------------------------------------------------------------------------------------ | ---------------------- | ----------------------- | ----------------------- |
| PDF image mode                                                                       | Preserve image samples | Image adapter           | Image adapter           |
| Placement target                                                                     | None                   | 150 DPI                 | 96 DPI                  |
| Actual JPEG encode quality                                                           | No encoding            | Q75                     | Q55                     |
| Deflate level                                                                        | 6                      | 9                       | 9                       |
| Object-stream packing / unreachable-object reclamation                               | Yes                    | Yes                     | Yes                     |
| Supported content/font/XML stream compression                                        | Lossless               | Lossless                | Lossless                |
| Metadata removal                                                                     | Explicit checkbox only | Explicit checkbox only  | Explicit checkbox only  |
| RGB/gray 8-bit DCT, raw or supported Flate images                                    | Retained               | Re-encode, keep smaller | Re-encode, keep smaller |
| CMYK/ICC, masks, predictors, unsupported image filters                               | Samples retained       | Samples retained        | Samples retained        |
| Monochrome JBIG2/CCITT conversion, font subsetting, image deduplication, WebP-in-PDF | Not implemented        | Not implemented         | Not implemented         |

The generic document policy has a Gentle quality value of 90, but `lossless: true` disables image encoding; diagnostics correctly report no applied JPEG quality. Office profiles retain their existing settings. PDF uses placement DPI rather than the Office max-edge rule.

## Safeguard audit

| Safeguard / optimization gate                              | Assessment and final behavior                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signed/encrypted content                                   | Necessary: rewriting invalidates signatures or requires encryption handling. Preserve originals based on parsed objects, not printed strings.                                                                                                                      |
| PDF/A, PDF/X, unknown document-level conformance packet    | Necessary until conformance is validated. Actual identifiers preserve original; unreadable root XMP reports conformance unknown. Unreadable component metadata remains opaque and need not cancel other work.                                                      |
| Generic Adobe `pdfx/1.3` namespace                         | Unnecessary refusal removed; it does not itself declare PDF/X.                                                                                                                                                                                                     |
| Missing optional indirect references                       | Blanket refusal removed. Explicit null normalization follows PDF semantics. Unsupported graph objects, unknown trailer roots, node/edge/deadline limits still refuse before GC.                                                                                    |
| Any unsupported metadata association                       | Whole-job coupling removed. Retain that association; compress other streams/images. Root conformance uncertainty remains a distinct technical exception.                                                                                                           |
| Raw stream equality                                        | Too strict across intentional lossless compression. Source decoded payload equality is independently tested; post-transform serialized bytes must still reopen exactly. No arbitrary content changes are allowed.                                                  |
| Preserving all images at every preset                      | Removed for eligible Balanced/Heavy RGB/gray images; actual Q75/Q55 encoding and DPI targets are tested. Gentle remains lossless.                                                                                                                                  |
| Larger image candidate                                     | Necessary for smaller-file intent. Record `not_smaller`; retain that image and continue independent work. Already-low-quality JPEGs can legitimately yield identical profile outputs.                                                                              |
| CMYK/ICC/Decode/predictor/bit-depth limitations            | Necessary capability boundaries: avoid color inversion, profile loss or misdecoded pixels. Record color/filter/features skips; still allow lossless stream compression.                                                                                            |
| Image masks / images used as masks                         | Necessary: avoid altered opacity or mask alignment. Exclude both the masked image and mask targets from lossy encoding.                                                                                                                                            |
| JPEG APP packets                                           | APP1/APP13 remain byte-identical; APP2/profile-bearing inputs are excluded. The PDF XMP checkbox is not a complete image-metadata sanitizer.                                                                                                                       |
| Unknown placement / appearance / pattern / Type3 image use | Downsampling disabled; quality-only re-encoding remains possible. Complete page/Form analysis is bounded to 4M tokens, 64 MiB decoded content, 4096 Forms and bounded nesting. The old experimental 2M-token cap was below the source's measured 2,076,135 tokens. |
| Memory reservation / pixels / expansion / output caps      | Necessary. Extra image reservation is admitted before allocation, no new constant-memory claim. Stream decode is bounded before consolidation. Constrained devices can preserve the entire source or skip an image.                                                |
| Cancellation / watchdog / codec failure                    | Necessary. Cooperative checkpoints and worker termination remain. Encoder failure retains only that image; cancellation before replacement propagates and delivers no candidate.                                                                                   |
| Entire candidate reopen validation                         | Necessary. Serializer/retained-structure failure preserves original and reports validation failure. It does not require lossy pixels to equal the source.                                                                                                          |
| Final candidate not smaller                                | Necessary. UNCHANGED means the actual source was selected; it is not proof of global optimality. Diagnostics show attempted/skipped operations and refusal phase.                                                                                                  |

Diagnostics are fixed-shape, bounded numeric counts and enumerations, validated at the scheduler boundary (under 4096 serialized characters), stored locally and reset between attempts. Inventory includes pages/objects/streams, already-filtered streams, stored bytes by images/metadata/fonts/other, image compression/color categories and maximum dimensions. Operation counts distinguish attempts, accepted images/downsampling, stream savings, metadata removal/preservation, null normalization, unreachable objects, skips and validation. The telemetry schema remains unchanged and excludes the report.

## Actual supplied-source browser benchmark

The user placed the original textbook in the repository root. It is **26,105,613 bytes**, which is 24.90 MiB in the screenshot. This differs from the earlier 25,426,294-byte derivative used for ADR 0007. Private inputs/outputs are not committed fixtures.

Windows, headless Edge 155, eight reported cores, 16 GiB memory hint, cross-origin isolation, high tier, 768 MiB working budget. Estimates are **223,742,542 bytes** for Gentle and **357,960,270 bytes** for Balanced/Heavy (128 MiB extra image allowance). Actual browser/process peak memory was unavailable; these are reservations, not measured peaks. Runs used the production build and actual scheduler/worker/download flow, with zero outbound writes. Timings are individual local runs, not performance guarantees.

| Profile  | Metadata option      |  Output bytes |  Reduction | Click to completion |
| -------- | -------------------- | ------------: | ---------: | ------------------: |
| Gentle   | Preserve             |    13,808,304 |     47.11% |           11,157 ms |
| Balanced | Preserve             |    12,572,046 |     51.84% |           27,767 ms |
| Heavy    | Preserve             |    12,504,367 |     52.10% |           20,840 ms |
| Gentle   | Remove supported XMP |     8,618,437 |     66.99% |            9,637 ms |
| Balanced | Remove supported XMP |     7,392,435 |     71.68% |           16,235 ms |
| Heavy    | Remove supported XMP | **7,324,679** | **71.94%** |           16,807 ms |

Source inventory: 706 pages, 7017 objects, 1582 streams (1187 already filtered), 50 JPEGs (one RGB, 49 CMYK). Stored payloads: images 3,632,709 bytes; metadata 16,363,619; fonts 221,219; other streams 4,828,425. The 2217 × 2775 RGB cover becomes 1109 × 1388 at Balanced or 710 × 889 at Heavy. No page is rasterized.

With preservation, 497 streams are recompressed and 1485 unreachable objects reclaimed. With cleanup, 388 supported associations are removed, **363 ambiguous associations remain**, 109 retained streams are recompressed and 1873 unreachable objects reclaimed. All six runs normalize the same 238 null references. Balanced/Heavy attempt and optimize the RGB image, while reporting 49 color skips. Heavy-cleanup image savings after lossless processing are 1,293,194 bytes. The partial-cleanup message explicitly discloses retained metadata.

## Six synthetic PDF categories, three actual profiles

All bytes below are actual browser downloads, metadata preserved. Firefox and WebKit agreed on every row; Edge's full suite also exercised the same six fixture/profile combinations. Extreme reductions are deliberately compressible synthetic capability probes, not representative promises. Text-heavy content includes repeated raw comment data and searchable vector text; metadata includes repeated XML plus a form, annotation, attachment and a tiny PNG.

| Fixture                      |     Input |           Gentle |        Balanced |           Heavy |
| ---------------------------- | --------: | ---------------: | --------------: | --------------: |
| Image-heavy JPEG             |   411,192 | 351,239 (14.58%) | 13,000 (96.84%) |  4,393 (98.93%) |
| Gray scanned page            |   561,385 |  561,301 (0.01%) | 32,255 (94.25%) | 14,282 (97.46%) |
| Text-heavy raw content       |   252,882 |   1,612 (99.36%) |  1,612 (99.36%) |  1,612 (99.36%) |
| Large image, small placement | 1,034,250 | 853,538 (17.47%) |  3,631 (99.65%) |  1,724 (99.83%) |
| Already Q30 JPEG             |     7,765 |   6,219 (19.91%) |  6,219 (19.91%) |  6,219 (19.91%) |
| Metadata / interactive data  |   138,769 |   2,634 (98.10%) |  2,634 (98.10%) |  2,634 (98.10%) |

Balanced and Heavy actually encode/downsample each image-heavy, scan and large-image fixture and produce descending sizes. Already-Q30 JPEG encoding is attempted at both qualities but rejected as larger; identical output is justified by `not_smaller`, rather than silently unused settings. Metadata's small PNG similarly has no smaller JPEG candidate. Text-heavy has no images. These three categories correctly get most benefit from lossless structure/stream operations. Monochrome transcoding and font subsetting are not falsely reported as attempted.

## Independent validity and fidelity

The committed developer utility [verify-pdf-compression.py](../scripts/verify-pdf-compression.py) uses pypdf and PDFium, independently of pdf-lib/MozJPEG. Dependencies come from the local validation runtime and are not application dependencies. Reports contain only counts/status and render differences; source text, metadata, attachment names and hashes are never printed.

All six actual browser textbook outputs and all 36 Firefox/WebKit synthetic outputs are checked for page count, geometry, rotation/UserUnit, decoded page-content bytes, Info/form/annotation/attachment preservation, and every reachable retained non-image decoded stream. All-page PDFium text extraction matches (706 pages for each textbook output). Gentle preserves all image payloads; lossy textbook modes change only the RGB cover and preserve all 49 CMYK payloads. JPEG APP1/APP13 packets are compared locally without exposing their values.

Textbook sample pages 1, 2, 101, 351, 501 and 706 render at scale 1.25 with PDFium. Gentle samples are pixel-identical; the five sampled interior pages remain pixel-identical in Balanced/Heavy. Cover RMS difference on a 0–255 scale is 3.1696 for Balanced and 6.2846 for Heavy, consistent with intentional downsampling. Synthetic Gentle outputs are pixel-identical; image transforms render with the expected differences. Form value and widget appearance, annotation refs and attachment bytes are checked on the metadata fixture. Poppler independently rendered the Heavy-cleanup interior page; cover/interior and desktop/mobile diagnostics were visually inspected. This does not establish every possible PDF semantic or all-page visual equivalence.

## Verification and remaining gates

Validation includes the 24-case metadata suite, actual codec profile comparisons, cancellation after encode before replacement, codec failure, mask exclusion, memory refusal, placement/shared-reference handling, malformed/trailer protections, bounded diagnostics and telemetry exclusion. The production Edge suite covers keyboard/locked settings, cancellation/error cleanup, no pre-interaction engine fetch, no uploads and output packaging. PDF flows also run in Firefox/WebKit, and actual ZIP-worker slow-sink/producer-credit acknowledgment is checked separately. Final commands and totals are recorded in [progress](progress.md).

No dependencies, migrations, telemetry schema, codec assets/licenses or deployment changed. Installed Node CLI entry points substitute for pnpm because its launcher cannot initialize the selected version in this environment. Database tests are inapplicable to these processing changes.

Remaining release gates: physical-device and browser process-memory measurements for the new heavy image capability; strict **50,000-byte** cold graph compliance (the existing script allows 80,000 and currently measures 79,954); affected-domain review before merge; complete cross-browser worker/E2E coverage outside the PDF flows; broad corpus/color/fine-detail validation. No budget threshold was relaxed. CMYK/ICC lossy encoding, unusual image filters, font subsetting, deduplication and monochrome transcoding require their own capability work. No commits or deployment were made.
