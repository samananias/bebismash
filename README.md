# BebiSmash 🚀

> **High-Performance, Zero-Upload In-Browser File Compression & Packaging**  
> Every byte remains strictly inside the user's browser memory space. Wasm and WebCodecs power ultra-fast compression across images, video, documents, and archives, while Cloudflare Pages + D1 provide anonymous edge telemetry.

---

## 📚 Documentation

All comprehensive planning, design specifications, and onboarding guides live in the [`docs/`](docs/) directory:

- 📐 **[Master Engineering Blueprint](docs/MASTER_ENGINEERING_BLUEPRINT.md)**  
  The core architectural contract, locked technology stack, execution topologies, and multi-agent implementation plan.
- 🛠️ **[Developer Onboarding & Scripts](docs/DOCS.md)**  
  Environment bootstrap instructions, script contracts, local D1 / Pages emulation, and ADR guidelines.
- 💡 **[System Foundation & Concept](docs/foundation.md)**  
  The conceptual design and foundational architecture of BebiSmash.
- 📈 **[Implementation Progress](docs/progress.md)**  
  Live roadmap tracking milestones (M0 through M4), capability gates, and open risks.

---

## 🤖 Contributor Contract & AI Agents

- **[AGENTS.md](AGENTS.md)**: Canonical contributor contract defining non-negotiable architectural boundaries, workstream ownership, and Definition of Done.

---

## ⚡ Tech Stack

| Domain                | Technology                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| **Framework & UI**    | React 19, TypeScript (strict mode), Tailwind CSS 4                                                   |
| **Toolchain & Build** | Node.js 24 LTS, pnpm 10, Vite 7                                                                      |
| **State Management**  | Zustand 5                                                                                            |
| **Media Engines**     | `@jsquash` (Images), Mediabunny + WebCodecs / FFmpeg.wasm (Video), `pdf-lib` + `fflate` (Docs & ZIP) |
| **Edge & Telemetry**  | Cloudflare Pages Functions + Cloudflare D1 (SQLite)                                                  |
| **Testing**           | Vitest (Unit), Playwright (Worker integration & E2E)                                                 |

---

## 🚦 Getting Started

See **[docs/DOCS.md](docs/DOCS.md)** for instructions on bootstrapping the development environment and running validation scripts.
