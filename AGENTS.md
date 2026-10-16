# BebiSmash contributor contract

Use Node 24 LTS, pnpm 10, React, TypeScript and Vite; exact versions belong to the bootstrap package/lockfiles.
This is currently a documentation baseline; the scripts and paths below are implementation requirements until M0 creates them.

## Read when

- Read [docs/MASTER_ENGINEERING_BLUEPRINT.md](docs/MASTER_ENGINEERING_BLUEPRINT.md) before implementation or changing contracts, memory policy, codec behavior or infrastructure.
- Read [docs/DOCS.md](docs/DOCS.md) before bootstrapping, testing, migrations or deployment; [docs/foundation.md](docs/foundation.md) is the original concept, and the blueprint resolves conflicts.
- Once implementation begins, record changing status in [docs/progress.md](docs/progress.md) rather than this file.

## Workstream ownership

| Role                              | Allowed implementation paths                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core/Router and integration owner | src/core/**, src/services/**, src/workers/zip.worker.ts, core/protocol tests, root build/config/package/lockfiles, shared fixtures and root docs |
| Media Workers                     | src/workers/** except zip.worker.ts, src/codecs/**, domain media fixtures and tests                                                              |
| UI/State                          | src/components/**, src/store/**, src/styles/**, src/App.tsx, src/main.tsx, UI and E2E tests                                                      |
| Edge/Telemetry                    | functions/**, migrations/**, domain edge tests/fixtures, docs/edge/**                                                                            |

- Only the integration owner edits src/core/types.ts, package/lockfiles, Vite/TS/lint config, wrangler.toml, public/_headers, CI and shared fixture manifests.
- Propose cross-domain edits to that owner; merge the shared contract before dependent implementation, and obtain affected-domain review.
- Use separate workstream branches once Git is initialized; do not concurrently edit another role's paths.

## Non-negotiable boundaries

- Never import Wasm or codec runtime modules on the main thread or eagerly at worker entry top level; dynamically import an adapter inside an admitted worker job.
- Always send materialized ArrayBuffer payloads with postMessage(data, [buffer]); never structured-clone large binary buffers or transfer a Wasm heap.
- Transfer MessagePorts explicitly; File handles may be structured-cloned for range reads, and SharedArrayBuffer is never transferable.
- Never perform synchronous file reads, decode, encode, inflation or compression on the main thread; use async slices and admitted workers.
- Keep the initial cold HTML/CSS/static-JS graph strictly below 50,000 gzip bytes; no pre-interaction engine fetching.
- Reserve memory before allocation, honor chunk credits and output caps, and retain the original File until retry is no longer needed.
- Close frames/codecs/ports, revoke owned Blob URLs, terminate job workers and release registries on success, failure and cancellation; never claim forced production GC.
- Never upload source files, filenames, hashes or extracted metadata; telemetry is opt-in, schema-limited and independent of processing success.
- Keep binaries out of Zustand and persistent browser storage; local disk output requires an explicit user-selected sink.
- Preserve unsupported/signed/encrypted content as original or reject it; never claim fidelity or compression operations the adapter cannot perform.
- Never commit credentials, .dev.vars, private fixtures, generated dist, codec downloads, local Wrangler state or test traces.
- Keep applied migrations append-only and preview D1 separate from production; never use production secrets in fork PR jobs.
- If a check fails, fix its cause; never skip, delete or weaken tests to obtain green results, and report which checks actually ran.

## Definition of Done

- Quick after source changes: run pnpm format:check, pnpm lint and pnpm typecheck when the bootstrap scripts exist.
- Before a PR: run applicable pnpm test:unit, pnpm test:workers, pnpm db:test and pnpm test:e2e; run pnpm assets:prepare, pnpm build and pnpm size:check.
- Include cancellation, error cleanup, transfer/backpressure and reservation tests for changed processing paths; include a11y and no-upload assertions for changed UI flows.
- Demonstrate independent output validity/fidelity for codec changes and record physical-device memory checks before releasing new heavy capabilities.
- Review the diff for ownership, secrets/private files, generated assets, contract changes and unsupported claims; update documentation and codec license/hash manifests as needed.
- State unrun checks and reasons; documentation-only changes require link/fence/consistency review rather than nonexistent application tests.

## Tool portability

Keep this file as the single instruction source; configure Cursor, Claude Code, Windsurf and Copilot using their supported instruction/import mechanism to read it, without divergent copied rules.
