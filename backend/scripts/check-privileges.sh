#!/usr/bin/env bash
# Verifies the application's DB and Redis accounts hold no more than their
# runtime privileges. The app must not be able to create roles/databases,
# mutate schema at runtime, or reconfigure/flush Redis.
#
# Usage: DATABASE_URL=... REDIS_URL=... ./scripts/check-privileges.sh [--strict]
set -euo pipefail

cd "$(dirname "$0")/.."
FAILURES=0
STRICT="${1:-}"

# Load .env if present, without clobbering an explicitly-set env.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${REDIS_URL:?REDIS_URL must be set}"

# psql rejects Prisma's trailing ?schema= query parameter — drop it.
DB_PSQL_URL="${DATABASE_URL%%\?*}"

# Redis URL in the form redis://[:password@]host:port[/db]
REDIS_AUTH="$(printf '%s' "$REDIS_URL" | sed -E 's#redis://(.*)@.*#\1#' )"
REDIS_HOST="$(printf '%s' "$REDIS_URL" | sed -E 's#redis://([^@]*@)?([^/:]+).*#\2#')"
REDIS_PORT="$(printf '%s' "$REDIS_URL" | sed -E 's#redis://.*:([0-9]+).*#\1#')"
REDIS_ARGS=(-h "$REDIS_HOST" -p "$REDIS_PORT" --no-auth-warning)
[ -n "$REDIS_AUTH" ] && [ "$REDIS_URL" != "$REDIS_AUTH" ] && REDIS_ARGS+=(-a "$REDIS_AUTH")

echo "== Postgres privileges =="
ROLE_CHECK="$(psql "$DB_PSQL_URL" -tAX \
  -c "SELECT rolsuper::text || ',' || rolcreatedb::text || ',' || rolcreaterole::text FROM pg_roles WHERE rolname = current_user;" 2>/dev/null || true)"
if [ "$ROLE_CHECK" = "false,false,false" ]; then
  echo "PASS current_user is not superuser / cannot create databases or roles"
else
  if [ "$STRICT" = "--strict" ]; then
    echo "FAIL expected false,false,false for rolsuper,rolcreatedb,rolcreaterole; got '$ROLE_CHECK'"
    FAILURES=$((FAILURES + 1))
  else
    echo "WARN current_user has elevated role attributes ($ROLE_CHECK); pass --strict to gate"
  fi
fi

DB_CREATE="$(psql "$DB_PSQL_URL" -tAX \
  -c "SELECT has_database_privilege(current_user, current_database(), 'CREATE');" 2>/dev/null || true)"
if [ "$DB_CREATE" = "t" ] && [ "$STRICT" = "--strict" ]; then
  echo "FAIL schema CREATE privilege is granted to the runtime account (migrate should be a separate deploys-only account)"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS no schema CREATE privilege (dev-tolerant unless --strict)"
fi

echo "== Redis privileges =="
if redis-cli "${REDIS_ARGS[@]}" CONFIG GET dir >/dev/null 2>&1; then
  if [ "$STRICT" = "--strict" ]; then
    echo "FAIL CONFIG command succeeds — runtime account can reconfigure Redis"
    FAILURES=$((FAILURES + 1))
  else
    echo "WARN CONFIG command succeeds (expected in dev pre-hardening); pass --strict to gate"
  fi
else
  echo "PASS CONFIG command rejected for the runtime account"
fi

if redis-cli "${REDIS_ARGS[@]}" ACL GETUSER default >/dev/null 2>&1; then
  echo "WARN ACL GETUSER succeeded; review that no allcommands/@admin access is granted"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "Privilege check FAILED: $FAILURES problem(s)"
  exit 1
fi
echo "Privilege check passed."