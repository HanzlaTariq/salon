#!/usr/bin/env bash
# Encrypted logical backup of the Supabase database (Linux / macOS / GitHub Actions / WSL / Git Bash).
#
#   BACKUP_DATABASE_URL  Supabase SESSION pooler URL, user postgres.<ref>, port 5432 (same as DIRECT_URL). Never the app role.
#                        The role MUST have BYPASSRLS (Supabase's `postgres` has it): every salon table uses FORCE ROW LEVEL SECURITY,
#                        so a dump by any other role stops with "query would be affected by row-level security policy" (fails safe, never half-dumps).
#   AGE_RECIPIENT        age PUBLIC key (age1...). The matching private key is NOT on this machine: keep it offline.
#   BACKUP_DIR           where the .age files go (default ./backups)
#   KEEP_DAYS            delete encrypted dumps older than this (default 30)
#
# Needs: pg_dump / pg_restore (client version >= the server's), age.   See docs/BACKUP.md
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT (age public key) is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
case "$AGE_RECIPIENT" in age1*) ;; *) echo "AGE_RECIPIENT must be an age public key (age1...)" >&2; exit 2;; esac

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
plain="$(mktemp "${TMPDIR:-/tmp}/salon-dump.XXXXXX")"
cleanup() { rm -f "$plain"; }
trap cleanup EXIT

echo "[1/4] dumping schema public (custom format)"
# Only our schema: Supabase's own schemas (auth, storage, realtime...) are managed by Supabase and are not used by this product.
pg_dump --dbname="$BACKUP_DATABASE_URL" --schema=public --format=custom --no-owner --file="$plain"

echo "[2/4] checking that the dump is readable"
listing="$(pg_restore --list "$plain")"   # (not piped into grep -q: with pipefail an early grep exit would fail the pipeline)
tables="$(printf '%s\n' "$listing" | grep -c ' TABLE DATA ' || true)"
if [ "$tables" -lt 20 ]; then echo "dump looks wrong: only $tables tables with data" >&2; exit 3; fi
printf '%s\n' "$listing" | grep -c ' TABLE DATA public _prisma_migrations ' >/dev/null || { echo "dump has no _prisma_migrations data" >&2; exit 3; }

echo "[3/4] encrypting for the offline key"
out="$BACKUP_DIR/salon-db-$stamp.dump.age"
age -r "$AGE_RECIPIENT" -o "$out" "$plain"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )

echo "[4/4] removing encrypted dumps older than $KEEP_DAYS days"
find "$BACKUP_DIR" -name 'salon-db-*.dump.age*' -type f -mtime +"$KEEP_DAYS" -delete

echo "OK: $out ($(wc -c < "$out") bytes, $tables tables with data)"
