# BebiSmash Implementation Progress

## Monoterm integration — 2026-10-16

Promoted the selected Crisp Monoterm design into the production entry on `codex/monoterm-ui`: cream/charcoal/cobalt styling, tactile buttons, compact file rows, an empty queue and actual scheduler result sizes. The prototype pages and picker are removed. Fonts are self-hosted with OFL licenses and a source/hash manifest. A native privacy dialog contains keyboard focus, closes on Escape and restores focus. Telemetry remains opt-in and independent of processing completion.

Queue and preset edits are locked during a batch. Cancellation invalidates late completions/rejections, retry retains the original file handles, and reset revokes the archive URL. No codec, worker, protocol, reservation or backpressure implementation changed. Processing is indeterminate rather than displaying simulated percentages; result sizes exclude ZIP overhead, while batch savings include it. See [design.md](design.md).

Validation: 77 unit/edge tests passed, including six new store lifecycle tests. Three production-build Chrome E2E tests passed: valid ZIP extraction against a synthetic source, no uploads/external requests or pre-interaction engine requests, preset selection, mobile long filenames, reduced motion, keyboard dialog containment/restoration, cancellation, injected worker error and retry. Desktop/mobile screenshots were inspected. Repository formatting, lint, TypeScript, asset preparation, production build, existing size check, diff whitespace check and the in-memory SQLite migration test passed using installed CLI entry points. The pnpm launcher remains unable to fetch its selected version. The cold HTML/CSS/static-JS graph is 78,323 gzip bytes, below the existing ADR 0001/script ceiling of 80,000 and above the original 50,000-byte contract; this change does not alter either contract or gate. Fonts are outside that script's measured graph. Firefox/WebKit and the dedicated worker suite were not run (matching browser binaries and the worker configuration are absent). No deployed or physical-device validation was performed.

## Isolated image-interface exploration — 2026-10-16

Explored three React variants: PICO-8 Warm Arcade, GBC Cyber-Chunky and Crisp Monoterm. The fixed prototype picker supported keyboard switching, replay and URL persistence. The variants explored a card collection, a queue with a settings rail, and compact paper rows. Local file selection, preset changes, simulated progress/cancellation, removal/reset and illustrative sample-report downloads were available. The prototype labeled sample results and did not invoke codecs, read file contents or upload data. Monoterm was subsequently selected and promoted; the exploratory surface was removed. See the [selected design](design.md).

Validation: repository-wide Prettier, ESLint and TypeScript checks passed through their installed CLI entry points (the pnpm launcher could not fetch its selected version from the registry). Local Chrome exercised all three variants at 1440px and 390px, including presets, preview start/cancel/completion, download, local selection/removal, keyboard navigation, URL persistence and reduced motion. No page exceptions, non-GET requests or horizontal overflow occurred. Desktop and mobile screenshots were inspected. The design detector flagged the console thumbnail's 3px separator; retained as part of the requested chunky border system. Codec/worker/database suites and production build gates were not run for this isolated visual exploration; no processing or deployment paths changed.

## Preview worker packaging fix — 2026-10-16

Cloudflare preview rejected `image.worker-*.ts` as `video/mp2t`. The scheduler passed processing worker URLs through a variable, so Vite emitted raw TypeScript assets. Image, PDF, Office, video and generic dispatch now each use a literal `new Worker(new URL(..., import.meta.url), { type: 'module' })` expression so Vite compiles their worker graphs. Worker creation remains inside job dispatch; codec imports and transfer ownership are unchanged.

Validation: asset preparation and production build passed; all six application workers emit `.js`, with no `.ts` assets in the output. All 71 unit tests, repository formatting, ESLint and TypeScript checks passed using the installed CLI entry points. The pnpm launcher could not fetch its selected version from the npm registry. Browser worker/E2E suites have no configuration in this checkout; deployed preview verification remains required after redeployment.

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
