# BebiSmash developer onboarding

Read [MASTER_ENGINEERING_BLUEPRINT.md](MASTER_ENGINEERING_BLUEPRINT.md) before implementation and [AGENTS.md](../AGENTS.md) before editing. [foundation.md](foundation.md) preserves the original concept. The blueprint resolves conflicts and defines capabilities, contracts and limits.

## Repository status

For the revised compression rollout, local result reasons, unchanged single-file behavior and bounded range-read video, see [the investigation](compression-limits-and-fidelity-investigation.md), [ADR 0006](adr/0006-compression-outcomes-and-bounded-video.md) and the latest [progress](progress.md). PDF now has independent lossless stream compression, selective opt-in metadata cleanup and a tested RGB/gray image subset at Balanced 150 DPI/Q75 and Heavy 96 DPI/Q55. See the [PDF implementation audit](pdf-compression-implementation-audit.md) and [ADR 0008](adr/0008-pdf-stream-and-image-compression.md). Physical-device memory certification, CMYK/ICC lossy support and large transformed disk output remain separate gates.

For implemented telemetry/offline behavior, see [ADR 0005](adr/0005-local-first-statistics-and-offline-assets.md) and [progress.md](progress.md). The original baseline language and command templates below are historical; verify installed CLI flags. In Wrangler 4.151, Pages dev rejects custom `--config` paths. Use local D1/variable overrides and an isolated `--persist-to` directory for tests; never use `--remote` for local validation.

This repository is a documentation baseline. It has no package.json, application, tests, Wrangler resources or Git repository yet. The commands below become runnable during M0 bootstrap; they are not claims about existing scripts. Do not run remote commands until real Cloudflare resources and environment bindings are configured.

## Toolchain and first bootstrap

Use Node 24 LTS and pnpm 10. Bootstrap owner selects exact patches, verifies compatibility with the blueprint's Vite 7/React 19 baseline, writes `.node-version`, `engines.node` and the exact `packageManager` version in package.json, and commits pnpm-lock.yaml. Avoid global Wrangler; pin it as a development dependency. Do not upgrade toolchain majors independently across workstreams.

M0 creates the Vite React TypeScript shell, Tailwind, separate TypeScript projects for DOM/worker/edge, lint/format configuration, and the script contract below. Use `pnpm exec` for installed tools. Copy the reviewed Vite/Wrangler/SQL templates from the blueprint into their named paths, replace infrastructure placeholders and prove the minimal build budget before adding features.

After M0, a normal checkout uses:

```powershell
pnpm install --frozen-lockfile
pnpm assets:prepare
pnpm typecheck
pnpm lint
pnpm build
pnpm size:check
```

`assets:prepare` copies only allowlisted codec assets from pinned dependencies, verifies hashes and license metadata, and emits a versioned manifest. Never fetch arbitrary CDN scripts during app execution. Generated dist, Playwright traces, local Wrangler state, .dev.vars files and local configuration are ignored by Git. Synthetic fixtures are committed; private user files are not.

## Script contract

| Script                         | Required behavior                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `dev`                          | Vite at 127.0.0.1:5173 with COOP/COEP and local API proxy.                                                              |
| `typecheck`                    | `tsc --build` over no-emit typecheck projects (or equivalent separate no-emit checks), including Functions and workers. |
| `lint` / `format:check`        | ESLint boundaries and Prettier check.                                                                                   |
| `test:unit`                    | `vitest run` for bounded pure logic; one file via `pnpm test:unit -- src/core/hardware.test.ts`.                        |
| `test:workers`                 | Playwright-backed actual worker/codec integration against built output.                                                 |
| `test:e2e`                     | Three-browser user flows, keyboard/a11y, privacy network checks and bounded memory regressions.                         |
| `db:test`                      | Fresh isolated local D1 migrations, schema/API tests, duplicate inserts and rollups.                                    |
| `build`                        | Vite production build after integrity-checked assets are prepared.                                                      |
| `size:check`                   | Strict <50,000 gzip bytes over cold HTML/CSS/static JS graph, with machine-readable report.                             |
| `infra:check`                  | Environment origins, distinct DB IDs, no placeholders, required static headers/routes/assets.                           |
| `smoke:remote -- --origin URL` | Headers, MIME, API contract and synthetic generic/image processing on deployed origin.                                  |

Scripts must fail on unimplemented gates, not print a success placeholder. Full checks use synthetic fixtures and require no production credentials. Large codec stress runs can be separately tagged but remain required before releasing that capability.

## Local D1 and Pages

Provision two Cloudflare D1 databases outside local development, one for production and one for previews. Put their IDs in the reviewed wrangler.toml; IDs are configuration, API tokens are secrets. Set the project's production branch to main. Preview bindings must never point at production.

Generate an ignored `wrangler.local.toml` containing `name`, `pages_build_output_dir`, compatibility date, a DB binding and migrations_dir matching the blueprint, but local `APP_ORIGIN=http://127.0.0.1:8788`. Local Miniflare D1 does not require cloud credentials. Always use the same config and state directory for migrations, seeding and serving.

```powershell
pnpm exec wrangler d1 migrations apply DB --local --config wrangler.local.toml
pnpm exec wrangler d1 execute DB --local --config wrangler.local.toml --file tests/fixtures/edge/seed.sql
pnpm build
pnpm exec wrangler pages dev dist --config wrangler.local.toml --ip 127.0.0.1 --port 8788
```

The seed file created in M0 contains only synthetic records with fixed UUIDs and uses `ON CONFLICT(event_id) DO NOTHING`; the migration itself creates the initial counter. Never seed production. Keep wrangler commands local unless explicitly doing an authorized deployment. A local DB reset is restricted to its verified `.wrangler` state path and is never part of normal tests against a shared developer database.

For UI development, start Pages on 8788 and Vite in another terminal with `pnpm dev`. Vite proxies /api; the local endpoint's origin policy accepts the explicitly configured 5173 origin in development only. For production-fidelity checks browse the built Pages server on 8788. Vite preview alone cannot test Pages Functions or D1.

## Secure context and isolation

Loopback HTTP is a potentially trustworthy development origin; verify `window.isSecureContext` and `window.crossOriginIsolated` instead of assuming. Vite config adds COOP/COEP in development; built Pages output uses public/_headers. A non-loopback LAN IP requires HTTPS with a locally trusted certificate to test on a physical phone. Use a team-approved certificate tool and Wrangler's pinned-version local HTTPS options; trust the certificate on the device, and never commit its private key. Do not bypass browser certificate validation to claim production-equivalent testing.

Check in window and a dedicated worker: `crossOriginIsolated === true` and `typeof SharedArrayBuffer !== 'undefined'`. Test a separate non-isolated origin for graceful fallback. Fonts/codecs/scripts are same-origin and served with correct MIME; missing .wasm files must be 404 rather than SPA HTML. Functions set their own headers because static `_headers` does not cover them.

Local development may use a narrow HMR WebSocket CSP exception; production keeps the strict blueprint CSP. Serve production assets and run CSP/header smoke tests before interpreting successful dev-server behavior as deploy readiness.

## Working in parallel

Use the four ownership domains in AGENTS.md. Core publishes protocol and mocked scheduler facades first. Propose shared contract/dependency/config changes to the integration owner; do not edit those files concurrently. Keep changing status in `docs/progress.md` once implementation begins. No agent should create a new workstream, deploy or message another chat merely because this blueprint describes parallel work.

For a work item, declare scope, capability impact, IDs/ownership transitions, reservation and cleanup behavior, fixtures, and completion checks. PRs include checks actually run and relevant limits. Report unsupported codec paths clearly; do not treat unsupported browser APIs as successful compression.

## Architecture Decision Records

Create sequential records in `docs/adr/NNNN-short-title.md` for contract version changes, codec additions, fidelity changes, memory policy, dependency/license changes, privacy or hosting decisions. The integration owner approves changes affecting other domains.

```markdown
# NNNN — Decision title

Date: YYYY-MM-DD
Status: proposed | accepted | superseded
Owner: workstream / reviewer

## Context

Concrete constraint, failing example and affected browsers/devices.

## Decision

Selected API/configuration, contract version and exact ownership changes.

## Alternatives

Options considered and measurable tradeoffs.

## Consequences

Memory, performance, security, privacy, accessibility and license effects.

## Validation and rollout

Fixtures, thresholds, checks, migration order, fallback and rollback.

## References

Primary documentation, measurements and related ADRs.
```

## JSDoc and ownership documentation

Document public contracts and non-obvious resource ownership; do not narrate simple assignments. State units, caps, mutation/transfer behavior, cancellation, thrown error codes and cleanup responsibility. Note codec fidelity limitations. Keep contracts and runtime guards synchronized.

```typescript
/**
 * Sends one owned output chunk after the bundler grants matching credit.
 * @param buffer Standalone exact-sized bytes, at most 256 KiB.
 * Ownership transfers to the bundler; buffer is detached on return.
 * Never pass a view over a Wasm heap. The caller retains its File for retry.
 * @throws A protocol error if credit is absent or the attempt is stale.
 */
```

## Validation and release

Quick after source edits: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`. Before a PR: applicable unit, worker, D1 and E2E cases; prepare assets, build and size gate. See blueprint section 8 for required stress/device checks, including cancellation and failure. Documentation-only edits need link/fence/consistency review, not nonexistent app tests.

Remote deploys use the CI templates after configuration is real. Apply append-only migrations to preview, deploy staging, smoke test, then migrate production and deploy main. Maintain compatibility with the prior Function while schema expands. Keep telemetry disabled until rate protection, origin configuration and retention job are verified. Production rollback restores application code against a compatible schema; use a reviewed forward correction for schema fixes.

Do not claim successful checks that were not run. This documentation baseline has not validated real codecs, a measured 50 KB React shell, physical-device memory ceilings, or Cloudflare deployment; those are M0/release gates with named owners in the blueprint.
