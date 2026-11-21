# RESTORE DRILL for WINDOWS: restores an encrypted backup into a SCRATCH PostgreSQL (never Supabase) and verifies it.
#
#   .\infra\backup\restore-drill.ps1 -BackupFile .\backups\salon-db-....dump.age -IdentityFile D:\offline\age.key `
#       -ScratchAdminUrl 'postgresql://postgres:pw@localhost:5432/postgres' [-ScratchDb salon_restore_drill]
param(
  [Parameter(Mandatory)][string]$BackupFile,
  [Parameter(Mandatory)][string]$IdentityFile,
  [Parameter(Mandatory)][string]$ScratchAdminUrl,
  [string]$ScratchDb = 'salon_restore_drill'
)
$ErrorActionPreference = 'Stop'
if ($ScratchAdminUrl -match 'supabase') { throw 'Refusing: the drill must never run against Supabase.' }
if ($ScratchDb -notmatch '^[a-zA-Z0-9_]+$') { throw 'ScratchDb may contain letters, digits and _ only' }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = $ScratchAdminUrl.Substring(0, $ScratchAdminUrl.LastIndexOf('/'))

if (Test-Path "$BackupFile.sha256") {
  $expected = (Get-Content "$BackupFile.sha256").Split(' ')[0]
  if ((Get-FileHash -Algorithm SHA256 $BackupFile).Hash.ToLower() -ne $expected) { throw 'checksum mismatch: the backup file is damaged' }
}
$plain = Join-Path ([IO.Path]::GetTempPath()) ("salon-drill-" + [guid]::NewGuid().ToString('N'))
$listFile = "$plain.list"
try {
  & age -d -i $IdentityFile -o $plain $BackupFile
  if ($LASTEXITCODE -ne 0) { throw 'age could not decrypt the file (wrong key?)' }

  Write-Host "[1/4] creating scratch database $ScratchDb"
  & psql $ScratchAdminUrl -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $ScratchDb" -c "CREATE DATABASE $ScratchDb"
  if ($LASTEXITCODE -ne 0) { throw 'could not create the scratch database' }
  # the dump keeps the GRANTs (least privilege is part of the product): the role they name must exist
  & psql $ScratchAdminUrl -v ON_ERROR_STOP=1 -q -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN CREATE ROLE salon_app NOLOGIN; END IF; END `$`$;"
  & psql "$base/$ScratchDb" -v ON_ERROR_STOP=1 -q -c 'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;'
  if ($LASTEXITCODE -ne 0) { throw 'could not create extensions' }

  Write-Host '[2/4] restoring'
  & pg_restore --list $plain | Where-Object { $_ -notmatch ' SCHEMA - public ' } | Set-Content -Encoding ascii $listFile
  & pg_restore --dbname="$base/$ScratchDb" --no-owner --exit-on-error --use-list=$listFile $plain
  if ($LASTEXITCODE -ne 0) { throw 'pg_restore failed' }

  Write-Host '[3/4] verifying'
  & psql "$base/$ScratchDb" -v ON_ERROR_STOP=1 -At -f (Join-Path $here 'restore-verify.sql')
  if ($LASTEXITCODE -ne 0) { throw 'verification FAILED' }
  Write-Host "[4/4] done. Drop the scratch database when finished:  DROP DATABASE $ScratchDb;"
}
finally {
  foreach ($f in @($plain, $listFile)) { if (Test-Path $f) { Remove-Item -Force $f } }
}
