#!/usr/bin/env bash
# RESTORE DRILL: proves that a backup can really be restored. Run it at least once a month and after every big schema change.
# It restores into a SCRATCH PostgreSQL (local docker / your laptop), never into Supabase production.
#
#   BACKUP_FILE          the .dump.age file
#   AGE_IDENTITY_FILE    the age PRIVATE key file (bring it from offline storage; delete the copy afterwards)
#   SCRATCH_ADMIN_URL    superuser URL of the scratch server, e.g. postgresql://postgres:pw@localhost:5432/postgres
#   SCRATCH_DB           name of the scratch database to (re)create (default salon_restore_drill)
set -euo pipefail

: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE is required}"
: "${SCRATCH_ADMIN_URL:?SCRATCH_ADMIN_URL is required}"
SCRATCH_DB="${SCRATCH_DB:-salon_restore_drill}"
here="$(cd "$(dirname "$0")" && pwd)"

case "$SCRATCH_ADMIN_URL" in *supabase*) echo "Refusing: the drill must never run against Supabase." >&2; exit 2;; esac
case "$SCRATCH_DB" in *[!a-zA-Z0-9_]*) echo "SCRATCH_DB may contain letters, digits and _ only" >&2; exit 2;; esac

if [ -f "$BACKUP_FILE.sha256" ]; then ( cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256" ); fi

umask 077
plain="$(mktemp "${TMPDIR:-/tmp}/salon-drill.XXXXXX")"
trap 'rm -f "$plain"' EXIT
age -d -i "$AGE_IDENTITY_FILE" -o "$plain" "$BACKUP_FILE"

base="${SCRATCH_ADMIN_URL%/*}"
echo "[1/4] creating scratch database $SCRATCH_DB"
psql "$SCRATCH_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $SCRATCH_DB" -c "CREATE DATABASE $SCRATCH_DB"
# the dump keeps the GRANTs (least privilege is part of the product): the role they name must exist
psql "$SCRATCH_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'salon_app') THEN CREATE ROLE salon_app NOLOGIN; END IF; END \$\$;"
psql "$base/$SCRATCH_DB" -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;"

echo "[2/4] restoring"
# the scratch database already has an (empty) schema public: leave "CREATE SCHEMA public" out of the restore list
pg_restore --list "$plain" | grep -v ' SCHEMA - public ' > "$plain.list"
trap 'rm -f "$plain" "$plain.list"' EXIT
pg_restore --dbname="$base/$SCRATCH_DB" --no-owner --exit-on-error --use-list="$plain.list" "$plain"

echo "[3/4] verifying"
psql "$base/$SCRATCH_DB" -v ON_ERROR_STOP=1 -At -f "$here/restore-verify.sql"

echo "[4/4] done. Drop the scratch database when you are finished:  DROP DATABASE $SCRATCH_DB;"
