#!/usr/bin/env bash
set -euo pipefail

pid="${1:?}"
grace="${2:-5}"

if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
  printf 'Session pid is invalid.\n' >&2
  exit 2
fi
if ! [[ "$grace" =~ ^[0-9]+$ ]]; then
  printf 'Session reap grace is invalid.\n' >&2
  exit 2
fi
if ! kill -0 "$pid" 2>/dev/null; then
  exit 0
fi

kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
deadline=$((SECONDS + grace))
while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
fi
