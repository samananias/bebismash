# BebiSmash Implementation Progress

> Canonical tracker for implementation milestones, capability gates, workstream status, and unresolved risks. Maintained during development outside [AGENTS.md](../AGENTS.md).

---

## Current Status: M2 Completed • Ready for M3

- **Active Milestone**: M3 — Video & PDF Baseline
- **Baseline Date**: 2026-10-16
- **Current Phase**: M2 Image & Bounded Office Adapters Complete (JPEG, PNG, WebP, AVIF, Oxipng, OOXML Preflight & Repacking, 40 Unit Tests Passing)

---

## Milestone Roadmap & Delivery Gates

| Milestone | Scope                  | Key Deliverables                                                                                                                                                                                                              | Status        |
| --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **M0**    | Contract / Bootstrap   | Node 24 LTS, pnpm 10, Vite 7 + React 19 shell, Tailwind CSS 4, multi-tsconfig boundaries (DOM, Worker, Edge), ESLint flat config, Prettier, frozen shared types (`src/core/types.ts`), mock scheduler facade, script contract | **Completed** |
| **M1**    | Generic Slice E2E      | Ingestion handles, sniff, hardware-budgeted reservation, stream 1 generic file + fflate ZIP bundler, capped Blob / local file sink, cancellation & cleanup                                                                    | **Completed** |
| **M2**    | Image & Bounded Office | Progressive adapter integration (@jsquash/jpeg, png, webp, avif, oxipng), Office preflight & raster media optimization, hostile fixture rejection, staging comparison fallback                                                | **Completed** |
| **M3**    | Video & PDF Baseline   | WebCodecs probing & transcoding, bounded FFmpeg.wasm fallback, conservative PDF rewriting, physical device memory soak tests                                                                                                  | **Up Next**   |
| **M4**    | Edge & Release         | Cloudflare Pages Functions, D1 telemetry migrations, rate protection, cold load size check, production certification                                                                                                          | Not Started   |

---

## Workstream Ownership Status

| Workstream           | Owner             | Paths                                                                               | Status                                           |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Core / Router**    | Integration Owner | `src/core/**`, `src/services/**`, `src/workers/zip.worker.ts`, config, fixtures     | M2 image & OOXML router & scheduler integration  |
| **Media Workers**    | Media Owner       | `src/workers/**` (except zip), `src/codecs/**`, media fixtures                      | Image & Office workers with preflight & adapters |
| **UI / State**       | UI Owner          | `src/components/**`, `src/store/**`, `src/styles/**`, `src/App.tsx`, `src/main.tsx` | Interactive dropzone, queue & download UI        |
| **Edge / Telemetry** | Edge Owner        | `functions/**`, `migrations/**`, `docs/edge/**`                                     | Initial D1 migration template created            |

---

## Capability Gates Checklist

- [x] **Initial Cold Load Size**: Measured at 76.87 KB gzip (< 80,000 bytes per [ADR 0001](adr/0001-initial-cold-load-budget.md)).
- [x] **No Main-Thread Codecs**: Zero dynamic or static Wasm / heavy codec imports on main thread or top-level worker entry (enforced via ESLint import boundaries and dynamic in-job imports).
- [x] **Zero-Copy Memory Protocol**: `src/core/types.ts` defines explicit `ArrayBuffer` transfer lists and `MessagePort` channels. Standalone buffers materialized; Wasm memory heaps are never transferred.
- [x] **Zero Data Upload**: Telemetry strictly opt-in, anonymous, mathematically aggregated; no file names, hashes, or content ever transmitted.
- [x] **Clean Resource Lifecycle**: Hardware profile detection and reservation formulas implemented with explicit budgets in `src/core/hardware.ts`.
- [x] **Hostile Fixture Rejection**: Bounded OOXML preflight rejects ZIP bombs (> 1,000 entries, > 200 MiB uncompressed, > 100:1 ratio).
- [x] **Preserve-Original Integrity**: Macro-enabled packages (`vbaProject.bin`), digitally signed documents (`_xmlsignatures`), animated images (APNG, animated WebP/AVIF), and candidates >= source size are preserved byte-identical.
- [x] **Independent Output Validity**: Unit tests for JPEG, PNG, WebP, AVIF, oxipng, OOXML preflight, downscaling, and generic ZIP unpacking pass independently.
- [x] **Worker Resource Lifecycle**: Explicit revocation of Object URLs, closing of MessagePorts, termination of workers on job completion/cancellation.

---

## Unresolved Risks & Mitigations

1. **SharedArrayBuffer & Cross-Origin Isolation**:
   - _Risk_: `SharedArrayBuffer` requires COOP/COEP headers. Non-isolated environments cannot run multithreaded FFmpeg.
   - _Mitigation_: Single-threaded fallback path and explicit feature probe before admitting video transcode jobs (scheduled for M3).
2. **Memory Ceilings on Mobile**:
   - _Risk_: Mobile browsers terminate tabs when worker pools exceed device thresholds.
   - _Mitigation_: Global semaphore (1–4 workers total, 1 worker on mobile profile) with chunked memory credit reservation.
3. **PNG Color Quantization Adapter Gate**:
   - _Risk_: Quantization requires tested color fidelity before enabling lossy PNG in Balanced/Heavy presets.
   - _Mitigation_: Set `quantizeColors=null`; Balanced/Heavy presets currently use lossless oxipng until explicit quantization license/fidelity test suite passes.
