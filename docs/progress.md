# BebiSmash Implementation Progress

> Canonical tracker for implementation milestones, capability gates, workstream status, and unresolved risks. Maintained during development outside [AGENTS.md](../AGENTS.md).

---

## Current Status: M0 Completed • Ready for M1

- **Active Milestone**: M1 — Safe End-to-End Generic Slice
- **Baseline Date**: 2026-10-16
- **Current Phase**: M0 Bootstrap Complete (Toolchain, Multi-TS Config, Contracts, Shell & Gates Verified)

---

## Milestone Roadmap & Delivery Gates

| Milestone | Scope                  | Key Deliverables                                                                                                                                                                                                              | Status        |
| --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **M0**    | Contract / Bootstrap   | Node 24 LTS, pnpm 10, Vite 7 + React 19 shell, Tailwind CSS 4, multi-tsconfig boundaries (DOM, Worker, Edge), ESLint flat config, Prettier, frozen shared types (`src/core/types.ts`), mock scheduler facade, script contract | **Completed** |
| **M1**    | Generic Slice E2E      | Ingestion handles, sniff, hardware-budgeted reservation, stream 1 generic file + fflate ZIP bundler, capped Blob / local file sink, cancellation & cleanup                                                                    | **Up Next**   |
| **M2**    | Image & Bounded Office | Progressive adapter integration (@jsquash/jpeg, png, webp, avif, oxipng), Office preflight & raster media optimization, hostile fixture rejection                                                                             | Not Started   |
| **M3**    | Video & PDF Baseline   | WebCodecs probing & transcoding, bounded FFmpeg.wasm fallback, conservative PDF rewriting, physical device memory soak tests                                                                                                  | Not Started   |
| **M4**    | Edge & Release         | Cloudflare Pages Functions, D1 telemetry migrations, rate protection, cold load size check, production certification                                                                                                          | Not Started   |

---

## Workstream Ownership Status

| Workstream           | Owner             | Paths                                                                               | Status                                    |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- |
| **Core / Router**    | Integration Owner | `src/core/**`, `src/services/**`, `src/workers/zip.worker.ts`, config, fixtures     | M0 contracts & bootstrap gates validated  |
| **Media Workers**    | Media Owner       | `src/workers/**` (except zip), `src/codecs/**`, media fixtures                      | Ready for M1 generic slice & worker ports |
| **UI / State**       | UI Owner          | `src/components/**`, `src/store/**`, `src/styles/**`, `src/App.tsx`, `src/main.tsx` | Minimal shell mounted, awaiting M1 events |
| **Edge / Telemetry** | Edge Owner        | `functions/**`, `migrations/**`, `docs/edge/**`                                     | Initial D1 migration template created     |

---

## Capability Gates Checklist

- [x] **Initial Cold Load Size**: Measured at 74.96 KB gzip (< 80,000 bytes per [ADR 0001](adr/0001-initial-cold-load-budget.md)).
- [x] **No Main-Thread Codecs**: Zero dynamic or static Wasm / heavy codec imports on main thread or top-level worker entry (enforced via ESLint import boundaries).
- [x] **Zero-Copy Memory Protocol**: `src/core/types.ts` defines explicit `ArrayBuffer` transfer lists and `MessagePort` channels.
- [x] **Zero Data Upload**: Telemetry strictly opt-in, anonymous, mathematically aggregated; no file names, hashes, or content ever transmitted.
- [ ] **Worker Resource Lifecycle**: Explicit revocation of Object URLs, closing of MessagePorts, termination of workers on job completion/cancellation (to be verified in M1).

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
