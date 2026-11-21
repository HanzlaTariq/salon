# Encrypted logical backup of the Supabase database for WINDOWS (PowerShell 5.1 or 7).
#
#   $env:BACKUP_DATABASE_URL = 'postgresql://postgres.<ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'
#   $env:AGE_RECIPIENT       = 'age1...'      # PUBLIC key; keep the private key offline
#   .\infra\backup\backup.ps1 [-BackupDir .\backups] [-KeepDays 30]
#
# Needs pg_dump / pg_restore (version >= server) and age on PATH.  The role must have BYPASSRLS (Supabase `postgres`). See docs/BACKUP.md
param([string]$BackupDir = '.\backups', [int]$KeepDays = 30)
$ErrorActionPreference = 'Stop'

if (-not $env:BACKUP_DATABASE_URL) { throw 'BACKUP_DATABASE_URL is required' }
if (-not $env:AGE_RECIPIENT -or -not $env:AGE_RECIPIENT.StartsWith('age1')) { throw 'AGE_RECIPIENT must be an age public key (age1...)' }
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$plain = Join-Path ([IO.Path]::GetTempPath()) ("salon-dump-" + [guid]::NewGuid().ToString('N'))
$out = Join-Path $BackupDir "salon-db-$stamp.dump.age"

try {
  Write-Host '[1/4] dumping schema public (custom format)'
  & pg_dump --dbname=$env:BACKUP_DATABASE_URL --schema=public --format=custom --no-owner --file=$plain
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }

  Write-Host '[2/4] checking that the dump is readable'
  $list = & pg_restore --list $plain
  if ($LASTEXITCODE -ne 0) { throw 'pg_restore --list failed' }
  $tables = @($list | Where-Object { $_ -match ' TABLE DATA ' }).Count
  if ($tables -lt 20) { throw "dump looks wrong: only $tables tables with data" }
  if (-not ($list | Where-Object { $_ -match ' TABLE DATA public _prisma_migrations ' })) { throw 'dump has no _prisma_migrations data' }

  Write-Host '[3/4] encrypting for the offline key'
  & age -r $env:AGE_RECIPIENT -o $out $plain
  if ($LASTEXITCODE -ne 0) { throw 'age failed' }
  $hash = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLower()
  Set-Content -Path "$out.sha256" -Value "$hash  $(Split-Path $out -Leaf)" -Encoding ascii
}
finally {
  if (Test-Path $plain) { Remove-Item -Force $plain }
}

Write-Host "[4/4] removing encrypted dumps older than $KeepDays days"
Get-ChildItem $BackupDir -Filter 'salon-db-*.dump.age*' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } | Remove-Item -Force

Write-Host ("OK: {0} ({1} bytes, {2} tables with data)" -f $out, (Get-Item $out).Length, $tables)
