# BebiSmash Implementation Progress

> Canonical tracker for implementation milestones, capability gates, workstream status, and unresolved risks. Maintained during development outside [AGENTS.md](../AGENTS.md).

---

## Current Status: M1 Completed • Ready for M2

- **Active Milestone**: M2 — Image & Bounded Office Adapters
- **Baseline Date**: 2026-10-16
- **Current Phase**: M1 Generic Slice Complete (Sniffing, Generic Worker, ZIP Bundler, Sinks, Unzip Tests Verified)

---

## Milestone Roadmap & Delivery Gates

| Milestone | Scope                  | Key Deliverables                                                                                                                                                                                                              | Status        |
| --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **M0**    | Contract / Bootstrap   | Node 24 LTS, pnpm 10, Vite 7 + React 19 shell, Tailwind CSS 4, multi-tsconfig boundaries (DOM, Worker, Edge), ESLint flat config, Prettier, frozen shared types (`src/core/types.ts`), mock scheduler facade, script contract | **Completed** |
| **M1**    | Generic Slice E2E      | Ingestion handles, sniff, hardware-budgeted reservation, stream 1 generic file + fflate ZIP bundler, capped Blob / local file sink, cancellation & cleanup                                                                    | **Completed** |
| **M2**    | Image & Bounded Office | Progressive adapter integration (@jsquash/jpeg, png, webp, avif, oxipng), Office preflight & raster media optimization, hostile fixture rejection                                                                             | **Up Next**   |
| **M3**    | Video & PDF Baseline   | WebCodecs probing & transcoding, bounded FFmpeg.wasm fallback, conservative PDF rewriting, physical device memory soak tests                                                                                                  | Not Started   |
| **M4**    | Edge & Release         | Cloudflare Pages Functions, D1 telemetry migrations, rate protection, cold load size check, production certification                                                                                                          | Not Started   |

---

## Workstream Ownership Status

| Workstream           | Owner             | Paths                                                                               | Status                                      |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| **Core / Router**    | Integration Owner | `src/core/**`, `src/services/**`, `src/workers/zip.worker.ts`, config, fixtures     | M1 generic slice, sinks & bundler validated |
| **Media Workers**    | Media Owner       | `src/workers/**` (except zip), `src/codecs/**`, media fixtures                      | Generic worker implemented; ready for M2    |
| **UI / State**       | UI Owner          | `src/components/**`, `src/store/**`, `src/styles/**`, `src/App.tsx`, `src/main.tsx` | Interactive dropzone, queue & download UI   |
| **Edge / Telemetry** | Edge Owner        | `functions/**`, `migrations/**`, `docs/edge/**`                                     | Initial D1 migration template created       |

---

## Capability Gates Checklist

- [x] **Initial Cold Load Size**: Measured at 78.47 KB gzip (< 80,000 bytes per [ADR 0001](adr/0001-initial-cold-load-budget.md)).
- [x] **No Main-Thread Codecs**: Zero dynamic or static Wasm / heavy codec imports on main thread or top-level worker entry (enforced via ESLint import boundaries).
- [x] **Zero-Copy Memory Protocol**: `src/core/types.ts` defines explicit `ArrayBuffer` transfer lists and `MessagePort` channels.
- [x] **Zero Data Upload**: Telemetry strictly opt-in, anonymous, mathematically aggregated; no file names, hashes, or content ever transmitted.
- [x] **Clean Resource Lifecycle**: Hardware profile detection and reservation formulas implemented with explicit budgets in `src/core/hardware.ts`.
- [x] **Independent Output Validity**: `src/core/generic.test.ts` validates byte-for-byte fidelity and decompressibility via independent `unzipSync`.
- [x] **Worker Resource Lifecycle**: Explicit revocation of Object URLs, closing of MessagePorts, termination of workers on job completion/cancellation.

---

## Unresolved Risks & Mitigations

1. **SharedArrayBuffer & Cross-Origin Isolation**:
   - _Risk_: `SharedArrayBuffer` requires COOP/COEP headers. Non-isolated environments cannot run multithreaded FFmpeg.
   - _Mitigation_: Single-threaded fallback path and explicit feature probe before admitting video transcode jobs.
2. **Memory Ceilings on Mobile**:
   - _Risk_: Mobile browsers terminate tabs when worker pools exceed device thresholds.
   - _Mitigation_: Global semaphore (1–4 workers total, 1 worker on mobile profile) with chunked memory credit reservation.
3. **50 KB Bundle Budget**:
   - _Risk_: React 19 + Zustand + UI primitives exceeding 50 KB initial gzip budget.
   - _Mitigation_: Exclude heavy validators (e.g. Zod) from initial bundle; defer all non-critical UI components; strict `size:check` CI gate.
