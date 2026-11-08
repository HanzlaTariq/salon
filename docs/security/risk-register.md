# Security risk register

Updated: 2026-11-08 (Phase 1). Source: `npm audit --omit=dev`, 6 "high" findings, no non-breaking fix available.

| ID | Finding | Exposure in this codebase today | Decision / action | Status |
|----|---------|--------------------------------|-------------------|--------|
| R1 | `multer` (via `@nestjs/platform-express`): DoS via pending async `fileFilter` after request teardown | No upload endpoints exist yet. Becomes relevant in Phase 3 (uploads). | Upgrade `@nestjs/platform-express` to a release that pulls multer >= 2.5.0 before Phase 3; do not use async `fileFilter`; enforce size caps. | **Open, must close before Phase 3** |
| R2 | `deepmerge-ts` (via `@prisma/config` / `prisma` CLI) stack exhaustion on recursive objects | Prisma CLI config loading only; not reachable from request data. | Upgrade Prisma when a patched release is available; re-run audit each phase. | Open, low exposure |
| R3 | `zod` < 4.6.6 memory exhaustion on oversized constrained collections | Zod validates **environment variables only** (trusted, operator-controlled). Request validation uses class-validator. | If zod is later used on request bodies, upgrade to 4.x first (breaking API changes; plan migration). | Open, not reachable |
| R4 | `react-router` / `react-router-dom` 6.x: open redirect via backslash in `<Link>`/`useNavigate`; SSR `deserializeErrors` injection | App is client-only (no SSR). No navigation to user-supplied URLs exists yet. Fix requires v7 (breaking). | Never pass untrusted input to `navigate()`/`<Link to>`; migrate to React Router 7 before Phase 2 ships login redirects (`?next=` must be validated against an allowlist of internal paths). | **Open, review before Phase 2** |

Resolved in Phase 1: vitest (critical, dev-only) upgraded to 5.x.

No phase may be called production-ready while R1 is open and uploads are enabled.
