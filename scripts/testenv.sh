#!/usr/bin/env bash
# Brings up the database and a PostgREST in front of it, loads the schema, and
# prints the environment variables the full suite needs.
#
#   eval "$(scripts/testenv.sh)"   # start and export
#   scripts/testenv.sh down        # tear down
set -euo pipefail

# Git Bash rewrites /tmp/... into a Windows path before docker sees it. This
# is applied per-command, not exported: setting it globally also stops the
# conversion of /dev/null, which breaks curl on Windows.
NOCONV="MSYS_NO_PATHCONV=1"

PG_NAME=gated-mcp-pg
REST_NAME=gated-mcp-rest
NET=gated-net
PG_PORT=${PG_PORT:-55432}
REST_PORT=${REST_PORT:-3999}
JWT_SECRET=${JWT_SECRET:-super-secret-jwt-token-with-at-least-32-characters}

if [ "${1:-up}" = "down" ]; then
  docker rm -f "$REST_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "torn down" >&2
  exit 0
fi

docker network create "$NET" >/dev/null 2>&1 || true

if ! docker ps --format '{{.Names}}' | grep -q "^${PG_NAME}$"; then
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$PG_NAME" --network "$NET" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gated \
    -p "${PG_PORT}:5432" postgres:16 >/dev/null
  echo "waiting for postgres..." >&2
  until docker exec "$PG_NAME" pg_isready -U postgres -d gated >/dev/null 2>&1; do sleep 1; done
fi
docker network connect "$NET" "$PG_NAME" >/dev/null 2>&1 || true

# Schema must exist before PostgREST builds its cache.
docker cp sql/001_schema.sql "$PG_NAME:/tmp/001.sql"
docker cp sql/002_atomic_commit.sql "$PG_NAME:/tmp/002.sql"
docker cp sql/003_audit_append_rpc.sql "$PG_NAME:/tmp/003.sql"
env $NOCONV docker exec "$PG_NAME" psql -U postgres -d gated -q -v ON_ERROR_STOP=1 -f /tmp/001.sql >/dev/null
env $NOCONV docker exec "$PG_NAME" psql -U postgres -d gated -q -v ON_ERROR_STOP=1 -f /tmp/002.sql >/dev/null
env $NOCONV docker exec "$PG_NAME" psql -U postgres -d gated -q -v ON_ERROR_STOP=1 -f /tmp/003.sql >/dev/null

if ! docker ps --format '{{.Names}}' | grep -q "^${REST_NAME}$"; then
  docker rm -f "$REST_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$REST_NAME" --network "$NET" -p "${REST_PORT}:3000" \
    -e PGRST_DB_URI="postgres://postgres:postgres@${PG_NAME}:5432/gated" \
    -e PGRST_DB_SCHEMAS=public \
    -e PGRST_DB_ANON_ROLE=postgres \
    -e PGRST_JWT_SECRET="$JWT_SECRET" \
    postgrest/postgrest >/dev/null
fi

# PostgREST builds its schema cache at startup, so functions created after it
# came up are invisible until it is told to reload.
if docker ps --format '{{.Names}}' | grep -q "^${REST_NAME}$"; then
  env $NOCONV docker exec "$PG_NAME" psql -U postgres -d gated -q     -c "notify pgrst, 'reload schema';" >/dev/null
fi

# A service-role key is just a JWT carrying a database role, same as Supabase's.
SERVICE_KEY=$(JWT_SECRET="$JWT_SECRET" node -e '
  const { createHmac } = require("crypto");
  const secret = process.env.JWT_SECRET;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ role: "postgres", iss: "supabase", iat: now, exp: now + 31536000 });
  process.stdout.write(`${head}.${body}.` + createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url"));
')

for attempt in $(seq 1 30); do
  if curl -sf -o /dev/null "http://localhost:${REST_PORT}/"; then break; fi
  if [ "$attempt" = 30 ]; then
    echo "postgrest did not become ready; check: docker logs $REST_NAME" >&2
    exit 1
  fi
  sleep 1
done

echo "export DATABASE_URL=postgres://postgres:postgres@localhost:${PG_PORT}/gated"
echo "export POSTGREST_URL=http://localhost:${REST_PORT}"
echo "export SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}"
