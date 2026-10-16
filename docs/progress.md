# BebiSmash Implementation Progress

## Local tooling update — 2026-10-16

Upgraded Wrangler from 3.114.17 to 4.151.0 and Workers type definitions to 5.20261016.1; see [ADR 0002](adr/0002-wrangler-4-upgrade.md). Pages continues to reject custom configuration paths. No remote resources were changed.

> Canonical tracker for implementation milestones, capability gates, workstream status, and unresolved risks. Maintained during development outside [AGENTS.md](../AGENTS.md).

---

## Current Status: M4 Completed • Implementation Baseline Complete

- **Active Milestone**: M4 — Edge & Release (Complete)
- **Baseline Date**: 2026-10-16
- **Current Phase**: All Milestones M0 through M4 fully implemented, validated, and verified (Cloudflare Pages Functions, D1 Anonymous Telemetry, Transparency & Privacy Modal, Live Savings Ticker, 71 Unit & Edge Tests Passing).

---

## Milestone Roadmap & Delivery Gates

| Milestone | Scope                  | Key Deliverables                                                                                                                                                                                                              | Status        |
| --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **M0**    | Contract / Bootstrap   | Node 24 LTS, pnpm 10, Vite 7 + React 19 shell, Tailwind CSS 4, multi-tsconfig boundaries (DOM, Worker, Edge), ESLint flat config, Prettier, frozen shared types (`src/core/types.ts`), mock scheduler facade, script contract | **Completed** |
| **M1**    | Generic Slice E2E      | Ingestion handles, sniff, hardware-budgeted reservation, stream 1 generic file + fflate ZIP bundler, capped Blob / local file sink, cancellation & cleanup                                                                    | **Completed** |
| **M2**    | Image & Bounded Office | Progressive adapter integration (@jsquash/jpeg, png, webp, avif, oxipng), Office preflight & raster media optimization, hostile fixture rejection, staging comparison fallback                                                | **Completed** |
| **M3**    | Video & PDF Baseline   | Conservative PDF rewrite with object-stream compaction, Mediabunny & WebCodecs probing & remux/transcoding, multi-audio/unsupported track fallback safety, dedicated PDF and Video workers                                    | **Completed** |
| **M4**    | Edge & Release         | Cloudflare Pages Functions, D1 telemetry migrations, rate protection, cold load size check, transparency modal, live community savings ticker, production certification                                                       | **Completed** |

---

## Workstream Ownership Status

| Workstream           | Owner             | Paths                                                                               | Status                                                          |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Core / Router**    | Integration Owner | `src/core/**`, `src/services/**`, `src/workers/zip.worker.ts`, config, fixtures     | Fully integrated with batch reporting and async telemetry       |
| **Media Workers**    | Media Owner       | `src/workers/**` (except zip), `src/codecs/**`, media fixtures                      | Image, Office, PDF, and Video workers operational               |
| **UI / State**       | UI Owner          | `src/components/**`, `src/store/**`, `src/styles/**`, `src/App.tsx`, `src/main.tsx` | TelemetryBadge ticker & PrivacyDialog transparency modal wired  |
| **Edge / Telemetry** | Edge Owner        | `functions/**`, `migrations/**`, `docs/edge/**`                                     | D1 migration verified, Pages Functions API (GET/POST) validated |

---

## Capability Gates Checklist

- [x] **Initial Cold Load Size**: Measured at 77.91 KB gzip (79,776 bytes < 80,000 bytes per [ADR 0001](adr/0001-initial-cold-load-budget.md)).
- [x] **No Main-Thread Codecs**: Zero dynamic or static Wasm / heavy codec imports on main thread or top-level worker entry (enforced via ESLint import boundaries and dynamic in-job imports).
- [x] **Zero-Copy Memory Protocol**: `src/core/types.ts` defines explicit `ArrayBuffer` transfer lists and `MessagePort` channels. Standalone buffers materialized; Wasm memory heaps are never transferred.
- [x] **Zero Data Upload**: Telemetry strictly opt-in, anonymous, mathematically aggregated; no file names, hashes, or content ever transmitted.
- [x] **Clean Resource Lifecycle**: Hardware profile detection and reservation formulas implemented with explicit budgets in `src/core/hardware.ts`.
- [x] **Hostile Fixture Rejection**: Bounded OOXML preflight rejects ZIP bombs (> 1,000 entries, > 200 MiB uncompressed, > 100:1 ratio); PDF preflight strictly enforces `%PDF-` offset 0.
- [x] **Preserve-Original Integrity**: Macro-enabled packages (`vbaProject.bin`), digitally signed documents (`_xmlsignatures`, PDF `/Type /Sig`), animated images, multi-audio video tracks, and candidates >= source size are preserved byte-identical.
- [x] **Independent Output Validity**: Unit and edge tests across codecs, parser, OOXML, PDF, Video, sniffer, hardware, telemetry schema, and edge endpoints pass independently (71 tests).
- [x] **Worker Resource Lifecycle**: Explicit revocation of Object URLs, closing of MessagePorts, termination of workers on job completion/cancellation.
- [x] **Edge Security & Privacy**: Functions enforce Origin matching, Sec-Fetch-Site rejection, 16 KiB body streaming limit, kill-switch support, and security headers.

---

## Unresolved Risks & Mitigations

1. **SharedArrayBuffer & Cross-Origin Isolation**:
   - _Risk_: `SharedArrayBuffer` requires COOP/COEP headers. Non-isolated environments cannot run multithreaded FFmpeg.
   - _Mitigation_: Single-threaded WebCodecs / Mediabunny native pipeline as primary video path; fallback preserves original bytes byte-identical when WebCodecs is unsupported.
2. **Memory Ceilings on Mobile**:
   - _Risk_: Mobile browsers terminate tabs when worker pools exceed device thresholds.
   - _Mitigation_: Global semaphore (1–4 workers total, 1 worker on mobile profile) with chunked memory credit reservation.
3. **PNG Color Quantization Adapter Gate**:
   - _Risk_: Quantization requires tested color fidelity before enabling lossy PNG in Balanced/Heavy presets.
   - _Mitigation_: Set `quantizeColors=null`; Balanced/Heavy presets currently use lossless oxipng until explicit quantization license/fidelity test suite passes.
