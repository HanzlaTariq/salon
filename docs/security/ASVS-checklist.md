# OWASP ASVS (level 2) review, Phase 15

Honest status per chapter. "Evidence" is a test or a file you can open. Items marked OPEN are not done.

| ASVS chapter | Status | Evidence / gap |
|---|---|---|
| V1 Architecture | Done | `docs/PHASE1.md`, tenancy through `TenantDb`, default deny, modular monolith |
| V2 Authentication | Done, 1 open | Argon2id, rotating refresh tokens with reuse detection, lockout, TOTP for platform roles (`auth.e2e-spec.ts`). OPEN: phone / SMS verification (R7) |
| V3 Session | Done | server-side session re-read on every request, revoke on logout / password change, `auth.e2e-spec.ts` |
| V4 Access control | Done | `security-audit`: every private route answers 401 without a token; RBAC and cross-tenant tests in every phase; FORCE RLS check on every salon table |
| V5 Validation | Done | whitelist + forbidNonWhitelisted, upload sniffing and re-encoding, HTML-escaped landing page, body size limit (413) |
| V6 Cryptography | Done | Argon2id, AES-256-GCM for MFA secrets, SHA-256 token hashes, `age` for backups. OPEN: device tokens in clear text (R92) |
| V7 Errors and logging | Done | error envelope, redaction, scrubbed monitoring events, `security.denied` events, immutable audit log |
| V8 Data protection | Partly | retention purge (Phase 15), query strings never logged. OPEN: offline SQLite not encrypted (R125), privacy policy text is yours to write |
| V9 Communication | Done in code | HTTPS / HSTS / CORS allow-list enforced in production env validation. Verify on your host |
| V10 Malicious code | Partly | gitleaks in CI, Dependabot, `npm audit`. OPEN: 5 high findings in dev-tool / env-only paths (R2, R3, R15-6) |
| V11 Business logic | Done | exclusion constraint against double booking, idempotent sync, append-only billing and audit, anti-hoarding limits, race tests |
| V12 Files | Done | private bucket, magic bytes, re-encode, signed short-lived URLs; PDF caveat R16 |
| V13 API | Done | `/api/v1`, uniform errors, rate limits per user and IP; Swagger off in production |
| V14 Configuration | Done | env validation fails fast in production, no secrets in git, Data API roles hold no grants (tested) |
