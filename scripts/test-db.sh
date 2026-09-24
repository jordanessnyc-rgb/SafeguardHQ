#!/usr/bin/env bash
# Starts a throwaway local Postgres for integration tests and prints its connection URL.
# Usage: eval "$(scripts/test-db.sh start)"; pnpm test; scripts/test-db.sh stop
set -euo pipefail
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DIR="${TEST_PG_DIR:-/var/tmp/ess-crm-test-pg}"
PORT="${TEST_PG_PORT:-54329}"
# initdb refuses to run as root; drop to the postgres system user when we are root.
RUN=()
if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then RUN=(runuser -u postgres --); fi
case "${1:-start}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      [ ${#RUN[@]} -gt 0 ] && chown postgres "$DIR"
      "${RUN[@]}" "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
    fi
    if ! "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
      "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=localhost" -l "$DIR/log" start >/dev/null
    fi
    echo "export TEST_DATABASE_URL=postgres://postgres@localhost:$PORT/postgres"
    ;;
  stop)
    "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" stop >/dev/null || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 1 ;;
esac
