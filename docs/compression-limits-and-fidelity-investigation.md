# Compression limits and fidelity: revised investigation and rollout

Date: 2026-10-17 (sample comparison added; implementation increment remains dated 2026-10-16)
Status: First implementation increment; large-output streaming and new codec capabilities remain gated.

Next work is planning only at the user's request. See [the next-day PDF implementation plan](pdf-compression-next-day-plan.md) for 2026-10-18 / the next session. No further implementation is authorized in this planning session.

This revision replaces the earlier proposal's universal savings targets and constant-memory claims. The authoritative engineering constraints are in [the blueprint](MASTER_ENGINEERING_BLUEPRINT.md). Changing implementation status and checks belong in [progress.md](progress.md); contract changes are recorded in [ADR 0006](adr/0006-compression-outcomes-and-bounded-video.md).

## Findings

- Video previously read the entire source into an ArrayBuffer and accumulated a full output buffer. Disk output only bounded delivery; it did not remove those allocations.
- Balanced video's fixed 4 Mbps target could exceed the source's total bitrate. A lower target helps, but cannot guarantee size or perceived quality.
- PDF currently performs conservative structural rewriting. It does not optimize embedded images.
- Office's former 16 MiB image allowance excluded many large photos, and its JPEG path did not apply the Heavy preset's max-edge resize. Gentle also re-encoded JPEGs despite its lossless policy.
- Single-file picker filters were missing. Because suggestedName already included the filename, this alone did not establish the cause of the reported extensionless output.
- Original-preserving fallback was presented as a downloadable success without distinguishing unsupported content, memory admission, or an unsuccessful candidate.

These are code-supported findings. A user-supplied PDF pair was subsequently inspected on 2026-10-17; see [the measured comparison](pdf-comparison-findings.md). The original reported MP4's specific fallback cause remains unconfirmed.

## Measured PDF priority correction — 2026-10-17

The supplied 706-page comparison changes the next priority: the 25,426,294-byte baseline contains 16,188,658 bytes of XML metadata across 388 reachable streams, versus 3,632,709 bytes of embedded images. The 6,637,520-byte comparison output has no XML metadata streams and contains 1,213,696 bytes of image payloads. Image optimization alone cannot explain the difference.

A local metadata-cleanup prototype using the existing pdf-lib dependency produced 8,971,816 bytes (64.7% smaller), retaining every image payload and all page-content streams unchanged. All 706 extracted page texts and page geometries matched; six sampled pages rendered pixel-identically with an independent PDFium renderer. XMP removal is a real metadata tradeoff, not preservation of every document property. The prototype is not integrated into the application, browser-benchmarked or a universal guarantee.

Before embedded-image work, design an explicit metadata-cleanup option: preserve metadata by default, clearly disclose XMP removal, detach only validated Metadata references, then reclaim provably unreachable objects from trailer roots. Do not indiscriminately delete XML, embedded files, forms, rights information or attachments. Keep signed/encrypted/PDF-A-sensitive documents gated. Add synthetic tests for shared references, unknown objects, cleanup/cancellation and exact preservation of content/image/font streams. Merely removing dictionary references without garbage collection can leave the large streams serialized.

## Product contract

Compression depends on the input. Large reductions can occur for oversized raster images, high-bitrate video, and photo-heavy documents. Already optimized media, existing archives and many text PDFs may not shrink.

Resizing, quantization, audio downmixing and lossy re-encoding discard information. No preset promises universal 60–85% savings, acoustic transparency, zero visible change, or a fixed browser memory ceiling. Metadata removal is not universally lossless: orientation, color and rights metadata can matter.

A single unchanged file finishes with an explanation and no duplicate download. A selected disk handle is obtained during the trusted click, but no writable stream is opened unless a smaller candidate is accepted. The operating system's picker may create an empty placeholder; the application cannot promise otherwise. Mixed ZIP batches retain original entries so batch contents remain complete.

Local reasons are memory limit, unsupported content, unsupported codec, no smaller candidate, failed validation, or protected document. They do not enter telemetry. An unchanged result is not proof that a file is already optimal.

## Revised sequence and implementation status

| Step | Scope                                                                     | Status                                                                                          |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1    | Accurate result explanations and zero-savings behavior                    | Implemented; validation recorded in progress                                                    |
| 2    | Typed save names and suppression of unchanged single-file writes          | Implemented; multi-file ZIP retains originals                                                   |
| 3    | Range-read video input, adaptive rate budget and bounded candidates       | Implemented; physical-device certification remains open                                         |
| 4    | Office image admission, Heavy JPEG resizing and Gentle fidelity           | Implemented for eligible JPEGs; complex metadata is preserved unchanged                         |
| 5    | PDF embedded-image optimization                                           | Not implemented; signature detection strengthened first; adapter design and release gates below |
| 6    | Transactional large outputs, standalone audio and optional archive codecs | Not implemented; distinct future capabilities, not implied by disk output                       |

## Implemented video architecture

The worker inspects the File and passes it directly to Mediabunny BlobSource for random-access reads. It does not call File.arrayBuffer on the complete source. The original File remains available for fallback.

Admission reserves the existing 1080p working baseline plus four times a capped candidate allowance. The allowance fits the remaining working budget and never exceeds the original size or the tier's output cap. Actual decoded dimensions must also pass the worker's pixel limit. This is conservative admission accounting, not a measured bound on browser/native codec memory. Constrained devices may still preserve video unchanged.

The candidate target uses positioned writes into a preallocated admitted buffer. It rejects writes outside that buffer before copying. MP4/MOV avoid in-memory fast-start staging. Completed output is reopened and compared before delivery. Output overflow preserves the original; it is not a successful compression result. Codec/output/input resources are disposed on normal and error paths, and scheduler cancellation terminates the worker.

Timing validation normalizes timestamp origins and accounts for a finalized WebM segment's last-frame duration. It independently checks first/last packet timestamps for each retained track within 50 ms; container metadata cannot excuse missing endpoints. Some MediaRecorder WebM inputs expose a final zero-duration decoded frame that the conversion library omits. Those candidates are rejected and the original is retained. The successful transcode browser fixture declares its synthetic capture cadence; it is not evidence that every raw recording can be transcoded faithfully.

For transcoding, the total rate budget is derived from the smaller of 65% of input bytes and 90% of candidate capacity, divided by duration. Audio receives at most the preset audio rate and 20% of that total budget; 3% is reserved for container overhead. The video rate cannot exceed the preset cap. Invalid duration or impractically low budgets preserve the original. This is a coarse estimate of total-file bitrate, not a video-track bitrate measurement or output-size guarantee. Final validation remains mandatory.

Unsupported layouts, multiple audio tracks, multiple video tracks, detected subtitle tracks and more than stereo audio are preserved. There is no silent primary-track selection or channel downmix. Broader HDR/10-bit/attachment retention and A/V fidelity certification remain release work.

Large source files can now be admitted on suitable devices with disk output and a small bounded candidate. This does not certify 500 MB–1 GB workloads or remove candidate caps. The existing signed 32-bit input/archive limits remain. Blob-only oversized source handling remains conservative.

## Implemented Office behavior

The routing reservation now includes a 64 MiB image allowance. Individual media admission remains bounded by the tier's entry allowance and pixel limits; it does not allocate speculatively. Media is processed sequentially.

Only matching JPEG/PNG entries under word/media, ppt/media and xl/media are eligible. JPEG Gentle preserves image bytes. Heavy applies max edge 1280 before JPEG encoding. Balanced preserves dimensions. PNG uses the existing lossless optimizer; no quantizer or PNG resizing is advertised.

JPEGs carrying EXIF, ICC or IPTC segments remain unchanged until orientation/color/metadata handling is tested. Raster formats and package names stay unchanged. Relationships, XML, content types and unknown entries are retained. Signed, encrypted and macro-enabled packages remain original-only. General OOXML validation and manual Office/LibreOffice checks remain required before release.

## PDF: next adapter increment

The baseline now checks parsed signature dictionaries, including compressed object streams, rather than relying solely on first/last-64-KiB marker scans. Signed/encrypted documents remain byte-preserved. A smaller rewrite is not equivalent to independent semantic fidelity validation.

The measured metadata-cleanup work above precedes the image adapter. It offers substantial savings for this sample without changing image resolution, while requiring explicit metadata-removal UX and reachability tests.

The image adapter must be implemented as its own bounded capability:

1. Allowlist ordinary 8-bit DeviceRGB/DeviceGray JPEG image XObjects first. Preserve unsupported images, filters, masks and color spaces.
2. Interpret content streams and graphics-state transforms, including nested Form XObjects. Account for every placement of shared images; do not derive effective DPI from page size or a single Matrix field.
3. Preserve resolution sufficient for the highest-resolution use. Balanced targets 150 DPI/Q75 and Heavy 96 DPI/Q55 only where the placement analysis is trustworthy.
4. Preserve text, vectors, forms, annotations, tags and resources. Do not replace pages with raster screenshots. Do not inject WebP bytes as though they were a standard PDF image filter.
5. Reserve decoded image memory before decode and process sequentially. Preserve original streams if any transformation or validation fails.
6. Validate with an independent renderer and compare text, forms, annotations, page geometry and representative rendered pages. Include signed/encrypted, shared images, masks, CMYK/ICC, small text scans and malformed resource fixtures.

An adapter based on pdf-lib internals needs pinned API tests and explicit maintenance ownership. A specialized PDF engine is an alternative only after license, bundle, memory and fidelity review; it is not assumed to be installed or authorized for deployment.

## Later capabilities

### Transactional large transformed output

Disk streaming requires a separate protocol/ADR. A transformed entry cannot be written into an irreversible ZIP stream and later replaced when validation fails. Define a user-selected staging/commit strategy, validation access, positioned-write versus append-only muxing, bounded metadata, failure/abort behavior and cleanup. OPFS/IndexedDB remain prohibited staging in v1. No relaxation of the memory budget follows merely from customSink being present.

### Standalone audio

Add an explicit audio route, policy, codec probes and output-format selection. FLAC is losslessly compressed, not uncompressed PCM. Opus/AAC conversion is lossy. Preserve channel layout and tracks unless a visible user choice authorizes changes. Validate duration, decoded samples, clipping, metadata and playback compatibility; publish measured outcomes rather than a universal transparent-bitrate claim.

### Optional generic compression

Keep ZIP/Deflate as the compatibility baseline. Existing compressed data should generally be stored rather than repeatedly recompressed. Brotli/Zstandard require explicit output choices and matching extensions/extraction expectations; they are not standard ZIP Deflate replacements. Benchmark speed, memory and savings before choosing high search levels.

### Image conversion and quantization

Keep current source-format defaults. Offer WebP/AVIF conversion and resizing explicitly; preserve alpha and tested color/orientation behavior. A 256-color palette is lossy and may band gradients or damage fine detail. Review the exact imagequant distribution's license before adding it; no dependency has been added by this increment.

## Evidence and release gates

Use synthetic and public fixtures, never committed private files. For each category report input/output bytes, unchanged fraction, processing time, estimated reservation, measured device memory where available, and quality/validity results. Compare equivalent settings and documents; do not infer a competitor's internal engine from its advertised savings.

Required processing coverage includes cancellation, output overflow, codec failure, sink failures, transferred buffers, slow sinks/backpressure and cleanup. UI coverage includes keyboard access, truthful outcomes, no duplicate writes, typed names and no uploads. Desktop Edge testing does not replace Firefox/WebKit or physical-device certification. The strict 50,000-byte cold graph contract remains open even if the existing ADR 0001/script gate of 80,000 passes.

## Primary references

- [Mediabunny reading](https://mediabunny.dev/guide/reading-media-files) and [writing/backpressure](https://mediabunny.dev/guide/writing-media-files)
- [WebCodecs specification](https://www.w3.org/TR/webcodecs/)
- [File picker options](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)
- [PDF-LIB capabilities](https://pdf-lib.js.org/)
- [iLovePDF's documented quality tradeoff](https://www.ilovepdf.com/help/documentation)
- [libimagequant licensing](https://pngquant.org/lib/)
