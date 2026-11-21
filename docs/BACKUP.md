# Backup and restore (Supabase Free plan)

The Free plan has no automated backups and the project can pause when idle. Until you upgrade, YOU own the backups.

## 1. What must be backed up

| Data | Where | How |
|---|---|---|
| Database (schema `public`: all business data, RLS policies, constraints, `_prisma_migrations`) | Supabase Postgres | `infra/backup/backup.sh` or `backup.ps1` (pg_dump, encrypted) |
| Uploaded files (salon documents, photos, payment receipts) | Supabase Storage bucket (private) | `npm run storage:backup` (the dump does NOT contain them) |
| Secrets (`JWT_ACCESS_SECRET`, `MFA_ENCRYPTION_KEY`, DB passwords, FCM key) | your secret manager | Keep a copy offline. `MFA_ENCRYPTION_KEY` is critical: without it every stored MFA secret is unreadable |

Supabase's own schemas (`auth`, `storage`, ...) are not backed up: this product does not use them.

## 2. Targets

* RPO (data you may lose): 24 hours with the daily job. Lower it by running the job more often.
* RTO (time to be running again): about 1 to 2 hours (create project, run `01-roles.sql`, restore, update environment variables).
* Retention: 30 days of encrypted dumps (`KEEP_DAYS`), GitHub artifacts 14 days. Keep one monthly copy offline for a year.

## 3. One-time setup

1. Install `age` (https://github.com/FiloSottile/age/releases; Windows: `winget install FiloSottile.age`) and PostgreSQL client tools matching your Supabase version.
2. On YOUR computer: `age-keygen -o age.key`. It prints the public key (`age1...`). Store `age.key` OFFLINE (password manager and a USB stick). Never put it in git, in GitHub secrets or on a server: the whole point is that a stolen backup file cannot be opened.
3. Backup role: use the Supabase `postgres` user from the SESSION pooler URL (`postgres.<ref>`, port 5432). It must have BYPASSRLS because every salon table uses FORCE ROW LEVEL SECURITY; any other role makes pg_dump stop with "query would be affected by row-level security policy" (it fails safe).
4. GitHub (private repo): add secrets `BACKUP_DATABASE_URL` and `BACKUP_AGE_RECIPIENT` (the PUBLIC key). The workflow `.github/workflows/backup.yml` runs daily at 02:30 Pakistan time. Run it once by hand (Actions > Database backup > Run workflow) and download the artifact.

Manual run (PowerShell):
```powershell
$env:BACKUP_DATABASE_URL = 'postgresql://postgres.<ref>:<url-encoded-pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'
$env:AGE_RECIPIENT = 'age1...'
.\infra\backup\backup.ps1 -BackupDir D:\salon-backups
```
Files: `salon-db-<UTC time>.dump.age` plus `.sha256`.

Storage files:
```powershell
$env:BACKUP_DIR = 'D:\salon-storage-backup'
cd apps\api; npm run storage:backup     # exit code 2 = some file failed or the bucket was cut off: read the output
age -r age1... -o D:\salon-storage-backup.tar.age (tar the folder first)   # encrypt before it leaves your machine
```

## 4. Restore drill (do it once now, then monthly)

A backup that was never restored is a hope, not a backup.
```powershell
# scratch PostgreSQL with PostGIS (never Supabase): docker run -d --name scratch -e POSTGRES_PASSWORD=pw -p 5433:5432 postgis/postgis:16-3.4
.\infra\backup\restore-drill.ps1 -BackupFile D:\salon-backups\salon-db-....dump.age -IdentityFile E:\offline\age.key `
  -ScratchAdminUrl 'postgresql://postgres:pw@localhost:5433/postgres'
```
The drill checks the checksum, decrypts, restores into a new database and runs `restore-verify.sql`: table count, applied migrations, RLS enabled everywhere, FORCE RLS on salon tables, the double-booking exclusion constraint, the append-only triggers, and the maintenance function. It prints row counts and the newest audit record so you can see how fresh the backup is. It refuses to run against anything that looks like Supabase. Delete the copy of the private key afterwards.

## 5. Real disaster (production restore)

1. Create a new Supabase project (same region). Enable extensions `postgis` (schema `extensions`), `btree_gist`, `pg_trgm`, `pgcrypto`.
2. Run `infra/supabase/01-roles.sql` in the SQL editor (new password for `salon_app`).
3. Decrypt and restore exactly as the drill does (`pg_restore --no-owner --use-list ...`, target = the new project's `postgres` session URL). The dump keeps the GRANT statements, so least privilege comes back with it (the drill verifies this: `salon_app` cannot change `audit_logs` or delete history). Then `npx prisma migrate deploy` must report nothing to apply.
4. Create the private bucket again (Public bucket OFF), restore the storage files with the same key paths.
5. Point `DATABASE_URL` / `DIRECT_URL` to the new project, rotate the database passwords, run the security e2e suite against a COPY, then switch traffic.
6. Run `npm run maintenance:run` in report-only mode: a restored database older than the files in the bucket shows up as orphans (and the safety rule refuses to delete them).

## 6. Upgrade path

Supabase Pro: daily backups (7 days), PITR add-on, no pausing, more connections. Keep this routine anyway: a logical backup outside the provider protects against account loss, a wrong `DELETE` after the PITR window, and provider outages.
