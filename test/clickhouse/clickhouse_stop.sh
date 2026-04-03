#!/bin/bash
CONTAINER_NAME="clickhouse-malloy"
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
echo "ClickHouse container removed"
