#!/usr/bin/env bash
# pika's end-to-end check (AC-1, AC-2, AC-8): installs and builds everything from a fresh checkout, checks that the
# release binary refuses to start without a password, serves it with its embedded UI under /pika with a password, then
# runs services/pika/e2e/driver.ts: a real pi runtime with Subagents, Herder, and pika against a mock provider, read
# API and fidelity assertions across a server outage and a pi restart, a 5,000-entry session, and the UI in the locally
# installed Chrome; then pika relay between two `pi --mode rpc` processes logged in as two devices (questions and
# answers, the hop limit, expiry with a short TTL, `/relay off`, messages from the browser route and the dashboard, and
# revocation closing the connection); then a second machine pairing through `/pika login` while the browser denies and
# approves it, device revocation, browser sign-out, and the login rate limit. Screenshots go to a temporary artifacts
# directory whose path is printed at the end.
#
# PIKA_CHROME selects the Chrome or Chromium binary; no browser is ever downloaded. PIKA_E2E_SKIP_BUILD=1 reuses
# installed dependencies and earlier builds; PIKA_E2E_KEEP=1 keeps the temporary pi workspace and server data.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service="$(cd "$here/.." && pwd)"
repo="$(cd "$service/../.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/pika-target}"

find_chrome() {
  local candidate
  for candidate in \
    "${PIKA_CHROME:-}" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/usr/bin/google-chrome" "/usr/bin/google-chrome-stable" "/usr/bin/chromium" "/usr/bin/chromium-browser" \
    "/snap/bin/chromium" "/opt/google/chrome/chrome"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! chrome="$(find_chrome)"; then
  echo "e2e: no Chrome or Chromium found; install one or set PIKA_CHROME to its binary (no browser is downloaded)" >&2
  exit 1
fi
if [[ -n "${PIKA_CHROME:-}" && "$chrome" != "$PIKA_CHROME" ]]; then
  echo "e2e: PIKA_CHROME=$PIKA_CHROME is not an executable file" >&2
  exit 1
fi

tmp="${TMPDIR:-/tmp}"
tmp="${tmp%/}"
work="$(mktemp -d "$tmp/pika-e2e.XXXXXX")"
artifacts="$(mktemp -d "$tmp/pika-e2e-artifacts.XXXXXX")"
pidfile="$work/server.pid"
: >"$pidfile"
# The relay check's pi processes, one pid per line; pi renames its process, so only the pids find them.
pi_pids="$work/pi.pids"
: >"$pi_pids"
step_pid=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local pid
  # Read apart: the pidfile has no trailing newline, so `cat` of both would join two pids into one.
  for pid in $step_pid $(cat "$pidfile" 2>/dev/null) $(cat "$pi_pids" 2>/dev/null); do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      # A server the driver restarted is not this shell's child, so `wait` returns at once.
      for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.05; done
    fi
  done
  # Chrome processes the driver could not close run with a profile inside $work.
  pkill -f -- "--user-data-dir=$work/" 2>/dev/null || true
  if [[ $status -ne 0 && -s "$work/server.log" ]]; then
    echo "e2e: last server log lines:" >&2
    tail -n 30 "$work/server.log" >&2 || true
  fi
  if [[ "${PIKA_E2E_KEEP:-}" == 1 ]]; then
    echo "e2e: kept $work" >&2
  else
    rm -rf "$work"
  fi
  if [[ $status -eq 0 ]]; then
    echo "e2e: passed; screenshots in $artifacts"
  else
    echo "e2e: failed; screenshots so far in $artifacts" >&2
  fi
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

if [[ "${PIKA_E2E_SKIP_BUILD:-}" != 1 ]]; then
  echo "e2e: installing dependencies"
  step npm ci --prefix "$repo" --no-audit --no-fund
  step npm ci --prefix "$service/web" --no-audit --no-fund
  step npm ci --prefix "$service/e2e" --no-audit --no-fund
  echo "e2e: building the web UI"
  step npm run build --prefix "$service/web"
  echo "e2e: building the release binary"
  step cargo build --release --locked --manifest-path "$service/Cargo.toml" --bin pika
fi
echo "e2e: type-checking the driver"
step "$repo/node_modules/.bin/tsc" -p "$service/e2e/tsconfig.json"
pika="$CARGO_TARGET_DIR/release/pika"

# Without a password and without PIKA_AUTH the server refuses to start, with status 2.
env -u PIKA_PASSWORD -u PIKA_PASSWORD_FILE -u PIKA_AUTH PIKA_DATA_DIR="$work/fail-closed" \
  "$pika" serve --bind 127.0.0.1:0 >"$work/fail-closed.log" 2>&1 &
step_pid=$!
for _ in $(seq 1 200); do kill -0 "$step_pid" 2>/dev/null || break; sleep 0.05; done
if kill -0 "$step_pid" 2>/dev/null; then
  echo "e2e: the server started without a password" >&2
  exit 1
fi
status=0
wait "$step_pid" || status=$?
step_pid=""
if [[ $status -ne 2 ]] || ! grep -qF "pika: no password configured. Run 'pika password set'" "$work/fail-closed.log"; then
  echo "e2e: without a password the server exited with status $status instead of 2 and the no-password message:" >&2
  cat "$work/fail-closed.log" >&2
  exit 1
fi
echo "e2e: without a password the server refuses to start (status 2)"

port="$(node -e 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });')"
base_path="/pika"
url="http://127.0.0.1:$port$base_path"
export PIKA_PASSWORD="e2e-$(node -e 'console.log(require("crypto").randomBytes(9).toString("hex"))')"
# Test-only relay timings (docs/RELAY.md): undelivered messages expire after 6 s instead of 300, and the server pings
# and re-checks tokens every 2 s instead of 20. The driver restarts the server with the same environment.
export PIKA_RELAY_TTL_SECS=6 PIKA_RELAY_HEARTBEAT_SECS=2
data="$work/data"

PIKA_DATA_DIR="$data" "$pika" serve --bind "127.0.0.1:$port" --base-path "$base_path" >>"$work/server.log" 2>&1 &
echo $! >"$pidfile"
for _ in $(seq 1 200); do
  curl -fsS "$url/api/health" >/dev/null 2>&1 && break
  if ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "e2e: the server exited" >&2
    exit 1
  fi
  sleep 0.05
done
curl -fsS "$url/api/health" >/dev/null

# The release binary must embed the UI, not the placeholder page, and point it at the base path.
index="$(curl -fsS "$url/")"
if grep -q "does not include the web UI" <<<"$index"; then
  echo "e2e: the release binary serves the placeholder page instead of the embedded UI" >&2
  exit 1
fi
grep -q '<meta name="pika-base" content="/pika">' <<<"$index" || { echo "e2e: index.html lacks the pika-base meta tag" >&2; exit 1; }
script="$(grep -o 'src="[^"]*assets/[^"]*\.js"' <<<"$index" | head -n 1 | sed 's/^src="//; s/"$//')"
[[ -n "$script" ]] || { echo "e2e: index.html references no bundled script" >&2; exit 1; }
curl -fsS "$url/$script" -o /dev/null || { echo "e2e: the embedded script $script is not served" >&2; exit 1; }
echo "e2e: serving the embedded UI at $url"

token_laptop="$(PIKA_DATA_DIR="$data" "$pika" token create laptop)"
token_desktop="$(PIKA_DATA_DIR="$data" "$pika" token create desktop)"
# The relay check's two machines.
token_workstation="$(PIKA_DATA_DIR="$data" "$pika" token create workstation)"
token_notebook="$(PIKA_DATA_DIR="$data" "$pika" token create notebook)"
PIKA_DATA_DIR="$data" "$pika" token list | grep -q '^laptop' || { echo "e2e: token list does not show laptop" >&2; exit 1; }

# The driver runs with its own HOME so pi, git, and Chrome never read the user's configuration.
mkdir -p "$work/home"
step env \
  HOME="$work/home" \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_AUTHOR_NAME="pika e2e" GIT_AUTHOR_EMAIL="e2e@pika.invalid" GIT_COMMITTER_NAME="pika e2e" GIT_COMMITTER_EMAIL="e2e@pika.invalid" \
  PIKA_E2E_WORK="$work" PIKA_E2E_BIN="$pika" PIKA_E2E_DATA="$data" PIKA_E2E_PORT="$port" PIKA_E2E_BASE_PATH="$base_path" \
  PIKA_E2E_PIDFILE="$pidfile" PIKA_E2E_SERVER_LOG="$work/server.log" \
  PIKA_E2E_TOKEN_LAPTOP="$token_laptop" PIKA_E2E_TOKEN_DESKTOP="$token_desktop" \
  PIKA_E2E_TOKEN_WORKSTATION="$token_workstation" PIKA_E2E_TOKEN_NOTEBOOK="$token_notebook" PIKA_E2E_PI_PIDS="$pi_pids" \
  PIKA_E2E_CHROME="$chrome" PIKA_E2E_ARTIFACTS="$artifacts" \
  node --experimental-strip-types --no-warnings=ExperimentalWarning "$service/e2e/driver.ts"
