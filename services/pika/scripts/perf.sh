#!/usr/bin/env bash
# pika's performance check (AC-7): builds the release binaries, generates one year of data from five machines and
# loads it through the ingest code, serves it on a free localhost port, and measures the read API. Exits non-zero
# when the dataset falls short of the required shape or a query class exceeds its p95 limit. See docs/PERF.md.
#
# PIKA_PERF_SCALE (such as 0.05) makes a smaller dataset of the same shape for trying the script.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service="$(cd "$here/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/pika-target}"
scale=()
if [[ -n "${PIKA_PERF_SCALE:-}" ]]; then
  scale=(--scale "$PIKA_PERF_SCALE")
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/pika-perf.XXXXXX")"
step_pid=""
server_pid=""
cleanup() {
  local status=$?
  for pid in $step_pid $server_pid; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Runs a step in the background and waits for it, so a signal interrupts the wait and the trap stops the step.
step() {
  "$@" &
  step_pid=$!
  wait "$step_pid"
  step_pid=""
}

# The full dataset takes about 10 GiB on disk.
if [[ -z "${PIKA_PERF_SCALE:-}" ]]; then
  free_kib="$(df -Pk "$work" | awk 'NR == 2 { print $4 }')"
  if (( free_kib < 12 * 1024 * 1024 )); then
    echo "perf: $work has $((free_kib / 1024 / 1024)) GiB free; the dataset needs about 12 GiB" >&2
    exit 1
  fi
fi

echo "perf: building release binaries"
step cargo build --release --locked --manifest-path "$service/Cargo.toml" --bin pika --example perf
pika="$CARGO_TARGET_DIR/release/pika"
perf="$CARGO_TARGET_DIR/release/examples/perf"

step "$perf" load --data-dir "$work/data" --plan "$work/plan.json" --stats "$work/load.json" ${scale[@]+"${scale[@]}"}
step "$perf" check --data-dir "$work/data" --shape "$work/shape.json" ${scale[@]+"${scale[@]}"}

"$pika" serve --data-dir "$work/data" --bind 127.0.0.1:0 >"$work/server.log" 2>&1 &
server_pid=$!
addr=""
for _ in $(seq 1 600); do
  addr="$(sed -n 's|.*listening on http://\([0-9.]*:[0-9]*\).*|\1|p' "$work/server.log" | head -n 1)"
  [[ -n "$addr" ]] && break
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$work/server.log"
    echo "perf: the server exited" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ -z "$addr" ]]; then
  cat "$work/server.log"
  echo "perf: the server did not start" >&2
  exit 1
fi
echo "perf: serving on $addr"

step "$perf" bench --addr "$addr" --plan "$work/plan.json" --data-dir "$work/data" --pid "$server_pid" \
  --load-stats "$work/load.json" --shape "$work/shape.json"
