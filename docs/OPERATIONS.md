# Operations runbook

## Signals to watch (log search in your log drain, for example Better Stack / Datadog / Vercel logs)

| Log event | Meaning | Alert when |
|---|---|---|
| `security.denied` status 403 / 429 | blocked access / rate limit | more than 50 per 5 minutes from one `userId` or from the whole API |
| `security.denied` status 401 | expired or missing session | only for a sudden jump (a deploy changed the secret) |
| `http.slow` | request slower than `SLOW_REQUEST_MS` | repeated for the same `route` |
| `maintenance.orphans` | files without a database row | count greater than 0 for 3 days in a row, or `skippedReason: TOO_MANY_ORPHANS` (wrong database!) |
| `maintenance.done` | daily housekeeping result | missing for 24 hours (worker or cron stopped) |
| `Unhandled server error` / Sentry issue | bug | any new issue |
| PostgreSQL WARNING `notification event ... was not queued` | notification trigger failed | any |

## Incident checklist
1. Suspected credential leak: rotate it (`JWT_ACCESS_SECRET` logs everybody out; database password; `SUPABASE_SERVICE_ROLE_KEY`; `FCM_SERVICE_ACCOUNT_B64`; cron secrets). Then check `audit_logs`.
2. Suspected cross-salon access: stop traffic, run `test/security-audit.e2e-spec.ts` against a copy, read `audit_logs` for the affected salon.
3. Data damaged: restore into a scratch database first (docs/BACKUP.md), compare, then repair or switch.
4. Bad deploy: roll back the API; migrations are forward-only, so a rollback of code must be compatible with the new schema (Phase 15 only adds).

## Routine
* Daily: backup workflow green. Weekly: Dependabot pull requests, `npm audit`. Monthly: restore drill, review `slow-queries.sql`, rotate nothing unless needed. Before launch: `docs/security/ASVS-checklist.md`.
