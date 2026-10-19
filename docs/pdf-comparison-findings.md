# PDF comparison findings

Date: 2026-10-17
Status: Local investigation and prototype; no application or dependency changes

## Result

Comparable reductions are feasible locally for the supplied pair. Most of the observed size gap is XML metadata, not raster images. This corrects the earlier assumption that image downsampling was necessarily the main missing operation.

| Measurement                    | Baseline output | Comparison output | Local cleanup prototype |
| ------------------------------ | --------------: | ----------------: | ----------------------: |
| File bytes                     |      25,426,294 |         6,637,520 |               8,971,816 |
| Reduction relative to baseline |               — |             73.9% |                   64.7% |
| Pages                          |             706 |               706 |                     706 |
| XML metadata payload bytes     |      16,188,658 |                 0 |                 Removed |
| Image payload bytes            |       3,632,709 |         1,213,696 |               3,632,709 |

All 388 XML metadata streams in the baseline are reachable. They are not simply stale unreachable objects. There are 50 image streams in each supplied output. The largest image changes from 2217×2775 pixels / 1,496,157 stored bytes to 1107×1387 pixels / 98,440 bytes in the comparison. Several other images use CMYK; a DeviceRGB-only adapter cannot safely reproduce all of these transformations.

The comparison has no XMP streams; this observation does not establish its internal implementation. Its extracted page text matches the baseline on all 706 pages. The baseline has an AcroForm dictionary with zero enumerated fields; the comparison has no AcroForm dictionary. No conclusion about general form fidelity follows from this sample.

## Local prototype

The prototype used the existing pdf-lib version in Node, loading without metadata updates. It removed Metadata dictionary entries, traversed remaining trailer-root references, reclaimed unreachable objects and saved with object streams. The pass removed 774 Metadata keys across the loaded object graph and 2,236 unreachable indirect objects, including metadata and serialization artifacts. It did not re-encode or resize images, rasterize pages, remove forms or remove embedded files intentionally.

Output was saved outside the repository under this chat's visualization workspace. User PDFs, image references and generated comparison artifacts were not added to tests or committed. The prototype is a reviewable example, not a released browser capability. Its size is 8,971,816 bytes; it closes approximately 87.6% of the byte gap between the supplied outputs.

XMP cleanup can remove provenance, editing history, rights data or other descriptive properties. Pixel-identical pages do not make metadata deletion semantically lossless. Default metadata preservation and an explicit cleanup choice are required before application integration. PDF/A and signed/encrypted documents need separate handling.

## Validation actually performed

- Independent pypdf inspection: all 706 page-content streams and page geometries match the baseline; all original stored image payloads remain byte-identical.
- Independent PDFium extraction: text matches on all 706 pages for both the local prototype and comparison output.
- PDFium rendering at 1.25 scale: prototype pages 1, 2, 101, 351, 501 and 706 are pixel-identical to the baseline. Comparison output differs visually on the cover and slightly on two sampled interior pages; the other three samples match at that render scale.
- Contact sheets for pages 1 and 101 were visually inspected. Sampling does not establish identical rendering across all 706 pages or full document-semantic equivalence.
- Node/local-file processing only; no source upload, application change, deployment or browser memory benchmark occurred.

Application tests were not rerun because this work changed documentation only. Document formatting, local links and fence consistency were checked.

## Revised next implementation

1. Implement bounded reachability analysis and an explicit XMP-cleanup policy with synthetic shared-reference, form, signature, embedded-file and cancellation tests.
2. Validate preserved page-content, image and font payloads, plus text/annotations/forms and rendered samples. Never delete arbitrary XML streams or unknown resources based on their size.
3. Add placement-aware image optimization as a separate capability. The remaining approximately 2.33 MB gap to this comparison is consistent with the observed image reduction, but an exact matching output is not yet demonstrated.
4. Retain memory admission and original fallback. This 25.43 MB source does not certify constrained-device support; full-parser browser memory and execution time still require measurements.

See [the revised investigation](compression-limits-and-fidelity-investigation.md) and [progress](progress.md).
