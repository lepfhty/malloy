#!/bin/bash
set -e

SCRIPTDIR=$(cd $(dirname $0); pwd)
DATADIR=$(dirname $SCRIPTDIR)/data/malloytest-parquet
CONTAINER_NAME="clickhouse-malloy"
HTTP_PORT="${CLICKHOUSE_PORT:-18123}"
NATIVE_PORT="${CLICKHOUSE_NATIVE_PORT:-19000}"

# Check for existing container
if docker container inspect "$CONTAINER_NAME" > /dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" = "true" ]; then
    echo "$CONTAINER_NAME is already running"
  else
    echo "Restarting existing $CONTAINER_NAME container..."
    docker start "$CONTAINER_NAME"
    sleep 3
  fi
else
  echo "Starting ClickHouse container on HTTP port $HTTP_PORT..."
  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "$HTTP_PORT":8123 \
    -p "$NATIVE_PORT":9000 \
    -v "$DATADIR":/var/lib/clickhouse/user_files/data \
    -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
    clickhouse/clickhouse-server:26.3

  echo -n "Waiting for ClickHouse to start"
  counter=0
  while ! docker exec "$CONTAINER_NAME" clickhouse-client --query "SELECT 1" > /dev/null 2>&1; do
    sleep 2
    counter=$((counter+1))
    if [ $counter -eq 30 ]; then
      echo
      echo "ClickHouse did not start in time"
      docker logs "$CONTAINER_NAME"
      exit 1
    fi
    echo -n "."
  done
  echo
fi

echo "Loading test data..."
docker exec "$CONTAINER_NAME" clickhouse-client --query "CREATE DATABASE IF NOT EXISTS malloytest"

load_table() {
  local table=$1
  local order_by=$2
  local sample_by=${3:-}
  echo "  Loading $table (ORDER BY $order_by)..."
  local engine="MergeTree() ORDER BY ($order_by)"
  if [ -n "$sample_by" ]; then
    engine="$engine SAMPLE BY $sample_by"
  fi
  docker exec "$CONTAINER_NAME" clickhouse-client --query \
    "CREATE OR REPLACE TABLE malloytest.\`$table\` ENGINE = $engine AS SELECT * FROM file('data/${table}.parquet', Parquet)"
}

load_table aircraft       "coalesce(tail_num, '')"
load_table aircraft_models "coalesce(aircraft_model_code, '')"
load_table airports       "cityHash64(coalesce(id, 0)), coalesce(id, 0)" "cityHash64(coalesce(id, 0))"
load_table alltypes       "tuple()"
load_table carriers       "coalesce(code, '')"
load_table flights        "cityHash64(coalesce(id2, 0)), coalesce(id2, 0)" "cityHash64(coalesce(id2, 0))"
load_table ga_sample      "coalesce(fullVisitorId, '')"
load_table state_facts    "coalesce(state, '')"

echo "ClickHouse running on HTTP port $HTTP_PORT with malloytest database loaded"
echo ""
echo "To run tests:"
echo "  export CLICKHOUSE_HOST=http://localhost:$HTTP_PORT"
echo "  export CLICKHOUSE_DATABASE=malloytest"
echo "  MALLOY_DATABASE=clickhouse npx jest test/src/databases/all/expr.spec.ts"
