#!/bin/sh
# Installs this checkout for the current user: npm ci (node-pty builds from source where no prebuild exists),
# a native preflight (node-pty spawns /bin/sh -c 'exit 0' in a PTY), then records node's real path in .node-path, last.
# Usage: scripts/install.sh [--omit-dev]
set -eu
dir=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -s)" in
    Linux|Darwin) ;;
    *) echo "pika-node: unsupported platform $(uname -s) (Linux and macOS only)" >&2; exit 1 ;;
esac
command -v node >/dev/null || { echo "pika-node: node is not in PATH (run this from a login shell)" >&2; exit 1; }
node=$(node -p 'process.execPath')
"$node" -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 19)) { console.error(`pika-node: node ${process.versions.node} is too old; need >= 22.19`); process.exit(1); }'
cd "$dir"
if [ "${1:-}" = "--omit-dev" ]; then npm ci --omit=dev; else npm ci; fi
"$node" "$dir/scripts/preflight.ts"
printf '%s\n' "$node" > "$dir/.node-path.tmp"
mv -f "$dir/.node-path.tmp" "$dir/.node-path"
echo "pika-node installed in $dir with node $node ($("$node" --version)); run $dir/bin/pika-node start"
