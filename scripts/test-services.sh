#!/usr/bin/env bash
#
# Local services for integration tests.
#
# Integration tests run against the machine's own PostgreSQL and Redis rather
# than throwaway containers. PostgreSQL is shared: each package gets its own
# logical database inside the one instance. Redis cannot be shared the same way
# — the cache tests need a replication pair and a password-protected instance,
# which are per-process settings — so this script starts four small Redis
# instances on dedicated ports.
#
#   start    start the Redis instances and create the logical databases
#   stop     stop the Redis instances started here (the main 6379 is untouched)
#   status   report what is up, connecting to each database as the tests do;
#            exits 1 when anything is down
#
set -euo pipefail

PG_HOST="${PGHOST:-127.0.0.1}"
PG_PORT="${PGPORT:-5432}"
PG_SUPERUSER="${PGUSER:-$(whoami)}"
STATE_DIR="${SPFN_TEST_STATE_DIR:-$HOME/.spfn-test/redis}"

# port:role — 6479 standalone, 6480 master, 6481 replica of 6480, 6482 password
REDIS_PORTS=(6479 6480 6481 6482)
REDIS_MASTER_PORT=6480
REDIS_PASSWORD_PORT=6482
REDIS_TEST_PASSWORD=secret123

# The password-protected instance needs the password even to answer PING.
ping_redis()
{
    if [ "$1" = "$REDIS_PASSWORD_PORT" ]
    then
        redis-cli -p "$1" -a "$REDIS_TEST_PASSWORD" --no-auth-warning ping >/dev/null 2>&1
    else
        redis-cli -p "$1" ping >/dev/null 2>&1
    fi
}

start_redis()
{
    for port in "${REDIS_PORTS[@]}"
    do
        if ping_redis "$port"
        then
            echo "redis :$port already up"
            continue
        fi

        mkdir -p "$STATE_DIR/$port"

        local extra=()
        if [ "$port" = "$REDIS_PASSWORD_PORT" ]
        then
            extra+=(--requirepass "$REDIS_TEST_PASSWORD")
        fi
        if [ "$port" = 6481 ]
        then
            extra+=(--replicaof 127.0.0.1 "$REDIS_MASTER_PORT")
        fi

        # ${a[@]+"${a[@]}"} — an empty array is unset under `set -u` in bash 3.2,
        # which is what macOS ships.
        redis-server --port "$port" --daemonize yes --save '' --appendonly no \
            --dir "$STATE_DIR/$port" --logfile "$STATE_DIR/$port/redis.log" \
            ${extra[@]+"${extra[@]}"}

        echo "redis :$port started"
    done

    wait_for_replication
}

# The replica needs a moment to finish its first sync. Tests that read from the
# replica fail if they start before the link is up.
wait_for_replication()
{
    for _ in $(seq 1 30)
    do
        if redis-cli -p 6481 info replication 2>/dev/null | grep -q 'master_link_status:up'
        then
            echo "redis 6480→6481 replication up"
            return 0
        fi
        sleep 0.2
    done

    echo "redis 6480→6481 replication did not come up" >&2
    return 1
}

stop_redis()
{
    for port in "${REDIS_PORTS[@]}"
    do
        if [ "$port" = "$REDIS_PASSWORD_PORT" ]
        then
            redis-cli -p "$port" -a "$REDIS_TEST_PASSWORD" --no-auth-warning shutdown nosave 2>/dev/null || true
        else
            redis-cli -p "$port" shutdown nosave 2>/dev/null || true
        fi
        echo "redis :$port stopped"
    done
}

# package:role:password:database — one logical database per package, all inside
# the single local PostgreSQL instance.
PG_DATABASES=(
    "@spfn/core:testuser:testpass:spfn_test"
    "@spfn/auth:authtest:authtest123:spfn_auth_test"
    "@spfn/cms:cmstest:cmstest123:spfn_cms_test"
)

run_sql()
{
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 "$@"
}

create_databases()
{
    for entry in "${PG_DATABASES[@]}"
    do
        IFS=':' read -r package role password database <<< "$entry"

        run_sql -q -c "DO \$\$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role') THEN
                CREATE ROLE $role LOGIN PASSWORD '$password';
            END IF;
        END \$\$;"

        if ! run_sql -Atc "SELECT 1 FROM pg_database WHERE datname = '$database'" | grep -q 1
        then
            run_sql -q -c "CREATE DATABASE $database OWNER $role"
        fi

        echo "postgres :$PG_PORT — $database ready ($package)"
    done
}

# As the tests connect: as the package's role, to its database, through
# `localhost` — the name their URLs resolve, which can answer on ::1 where
# 127.0.0.1 does. A database the tests cannot reach is skipped by some of them
# rather than failed, so it is reported here, with psql's reason.
connect_as_role()
{
    PGPASSWORD="$3" psql -h localhost -p "$PG_PORT" -U "$1" -d "$2" -w -Atc 'SELECT 1' 2>&1
}

# Exits 1 when anything it reports is down.
report_status()
{
    local down=0

    for port in "${REDIS_PORTS[@]}"
    do
        if ping_redis "$port"
        then
            echo "redis :$port — up"
        else
            echo "redis :$port — down"
            down=1
        fi
    done

    replication=$(redis-cli -p 6481 info replication 2>/dev/null | grep -c 'master_link_status:up' || true)
    if [ "$replication" = 1 ]
    then
        echo "redis 6480→6481 replication — up"
    else
        echo "redis 6480→6481 replication — down"
        down=1
    fi

    for entry in "${PG_DATABASES[@]}"
    do
        IFS=':' read -r _ role password database <<< "$entry"

        if reason=$(connect_as_role "$role" "$database" "$password")
        then
            echo "postgres localhost:$PG_PORT — $database up (as $role)"
        else
            echo "postgres localhost:$PG_PORT — $database down (as $role): $reason"
            down=1
        fi
    done

    return "$down"
}

case "${1:-start}" in
    start)
        start_redis
        create_databases
        ;;
    stop)
        stop_redis
        ;;
    status)
        report_status
        ;;
    *)
        echo "usage: $0 {start|stop|status}" >&2
        exit 1
        ;;
esac
