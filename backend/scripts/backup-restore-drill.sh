#!/usr/bin/env bash
# Backup/restore drill: dump the live DB, restore it into a throwaway scratch
# database, verify the double-entry ledger is still balanced (zero-sum across
# all accounts), then drop the scratch DB.
#
# Usage: DATABASE_URL=... ./scripts/backup-restore-drill.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set}"

DB_NAME="${DATABASE_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
SCRATCH="draughts_arena_drill_$(date +%s)"
DUMP="$(mktemp --suffix=.sql)"
# pg_dump/createdb/psql reject Prisma's trailing ?schema= query parameter.
DB_PSQL_URL="${DATABASE_URL%%\?*}"

# Pull connection params out of the URL for createdb/dropdb (no URL support).
DB_CREDS="${DB_PSQL_URL#*://}"
DB_CREDS="${DB_CREDS%@*}"
DB_USER="${DB_CREDS%:*}"
DB_PASS="${DB_CREDS#*:}"
DB_HOSTPORT="${DB_PSQL_URL#*@}"
DB_HOSTPORT="${DB_HOSTPORT%%/*}"
DB_HOST="${DB_HOSTPORT%%:*}"
DB_PORT="${DB_HOSTPORT##*:}"
export PGPASSWORD="$DB_PASS"

echo "== Dump =="
pg_dump "$DB_PSQL_URL" --no-owner --no-privileges -f "$DUMP"
# pg_dump 18 emits PG17+ SET lines the local PG15 server rejects; strip them.
sed -i '/^SET transaction_timeout/d' "$DUMP"
echo "Dumped $(wc -l < "$DUMP") lines to $DUMP"

echo "== Restore into $SCRATCH =="
createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$SCRATCH"
trap 'dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --if-exists "$SCRATCH" 2>/dev/null || true; rm -f "$DUMP"' EXIT
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$SCRATCH" -q -f "$DUMP" >/dev/null

echo "== Ledger zero-sum check =="
BALANCE=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$SCRATCH" -tAX \
  -c "
    SELECT COALESCE(SUM(\"amountMinorUnits\"), 0)
    FROM \"LedgerEntry\"
    WHERE \"transactionId\" IN (
      SELECT \"transactionId\" FROM \"LedgerEntry\" GROUP BY \"transactionId\"
      HAVING SUM(\"amountMinorUnits\") <> 0
    );")
echo "Transactions whose entries do not net to zero: $BALANCE"
if [ "$BALANCE" != "0" ]; then
  echo "FATAL: restored ledger is not balanced ($BALANCE)."
  exit 1
fi

echo "== Table count sanity =="
TABLES=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$SCRATCH" -tAX -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
echo "public tables restored: $TABLES"

echo "Backup/restore drill passed."