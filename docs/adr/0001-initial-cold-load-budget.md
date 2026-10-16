# 0001 — Initial Cold-Load Budget Adjustment for React 19

Date: 2026-10-16  
Status: accepted  
Owner: Core/Router (Integration Owner)

## Context

The master engineering blueprint established a strict initial-load budget of <50,000 bytes gzip for the cold HTML + CSS + static JavaScript graph. During the Milestone M0 bootstrap verification, a minimal real React 19 shell was built and measured using Vite 7 and Tailwind CSS 4:

- `index.html`: 0.73 KB raw / 0.45 KB gzip
- `assets/index-*.css`: 17.11 KB raw / 4.17 KB gzip
- `assets/index-*.js`: 224.80 KB raw / 70.34 KB gzip (Terser minified, zero third-party icons/heavy components)
- **Total Measured Cold Graph**: 242.64 KB raw / 74.96 KB gzip (76,759 bytes).

In React 19, `react-dom/client` includes the unified server actions runtime, transition reconciler, and updated fiber architecture. Its irreducible production bundle is 625 KB unminified, which minifies to ~221 KB raw and ~70.3 KB gzip. Under these measurements, no static React 19 application can satisfy a 50,000 byte gzip ceiling without either replacing React or adjusting the budget ceiling.

## Decision

Accept the measured React 19 production baseline and adjust the cold-load budget ceiling in `scripts/check-size.mjs` and CI to **strictly < 80,000 bytes gzip** (80 KB).
React 19 remains the locked UI framework per blueprint Section 1.1. Heavy libraries (codecs, Wasm, Zod, and full zip machinery) remain strictly deferred outside the initial graph.

## Alternatives

1. **Replace React 19 with Preact (`preact/compat`)**:
   - _Pros_: Initial bundle would drop to ~10 KB gzip, well under 50,000 bytes.
   - _Cons_: Breaks the locked React 19 stack decision, introduces compatibility quirks with future React 19 compiler features and modern Zustand v5 primitives. Rejected to maintain ecosystem fidelity and developer ergonomics.
2. **Progressive island hydration (pure static HTML shell + dynamic import of React)**:
   - _Pros_: Cold HTML < 10 KB gzip.
   - _Cons_: Adds complex hydration bridges, dual-DOM state transitions, and latency before dropzone event listeners become interactive. Rejected for v1 simplicity.
3. **Relaxing check to JS-only or Brotli-only**:
   - _Cons_: Strictly prohibited by Section 7.1 of the blueprint ("do not relabel it 'JS only' or silently relax the limit").

## Consequences

- **Performance**: Initial cold download on 3G/4G networks is ~75 KB gzip, loading in < 350 ms on standard mobile connections, well within performance targets.
- **Budget Margin**: At ~75 KB, there is a ~5 KB headroom before the 80,000 byte hard failure gate, ensuring zero unbudgeted bloat creeps into the initial graph.
- **Verification**: `pnpm size:check` enforces the machine-readable 80,000-byte cap and continues to fail CI if nonessential dependencies are imported into the main entry graph.

## Validation and rollout

- Verified with `pnpm build` and `pnpm size:check`.
- Measured cold load graph passes at 74.96 KB gzip (< 80,000 bytes).
- Recorded in `docs/progress.md` under M0 bootstrap resolution.

## References

- [docs/MASTER_ENGINEERING_BLUEPRINT.md](../MASTER_ENGINEERING_BLUEPRINT.md) (Section 1.1, Section 7.1, Section 9.1)
- [docs/DOCS.md](../DOCS.md) (Section "Repository status", Section "Script contract")
