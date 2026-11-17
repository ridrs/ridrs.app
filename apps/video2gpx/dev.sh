#!/usr/bin/env bash
# Start video2gpx in debug mode: Tauri dev build (Rust debug, Vite with hot reload on port 1450) and the pipeline from the source
# (research/route-shape-matching/.venv, `python -m rsm.pipeline`) instead of the frozen sidecar. macOS and Linux.
# Usage: ./dev.sh                 (creates the pipeline venv if missing; sets developer mode in the app settings if it is off)
#        ./dev.sh --no-settings   (leaves the settings as they are)
# Environment: PYTHON (interpreter for a new venv, default python3.14), and on Linux any WEBKIT_* variables you need.
set -euo pipefail
cd "$(dirname "$0")"
RSM=research/route-shape-matching
ID=org.video2gpx.app
case "$(uname -s)" in
  Darwin) DATA="$HOME/Library/Application Support/$ID" ;;
  *)      DATA="${XDG_DATA_HOME:-$HOME/.local/share}/$ID" ;;
esac
SETTINGS="$DATA/settings.json"

if pgrep -x video2gpx >/dev/null; then
  echo "video2gpx is already running (pid $(pgrep -x video2gpx | tr '\n' ' ')); quit it first." >&2
  exit 1
fi

if [ ! -x "$RSM/.venv/bin/python" ]; then
  PY="${PYTHON:-python3.14}"
  command -v "$PY" >/dev/null || { echo "missing $RSM/.venv and no $PY to create it (set PYTHON=...)" >&2; exit 1; }
  echo "creating $RSM/.venv with $PY (pipeline requirements)"
  "$PY" -m venv "$RSM/.venv"
  "$RSM/.venv/bin/pip" install -q -r "$RSM/requirements-pipeline.txt"
fi

command -v cargo >/dev/null || export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "cargo not found (install Rust with rustup: https://rustup.rs)" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm not found (npm install -g pnpm@10, or corepack enable pnpm)" >&2; exit 1; }
[ -d node_modules ] || pnpm install

if [ "${1:-}" != "--no-settings" ]; then
  mkdir -p "$DATA"
  "$RSM/.venv/bin/python" - "$SETTINGS" "$PWD/$RSM" <<'EOF'
import json, os, sys
f, rsm = sys.argv[1], sys.argv[2]
s = json.load(open(f)) if os.path.exists(f) else {}
want = dict(dev_mode=True, sidecar="", python=f"{rsm}/.venv/bin/python", rsm_dir=rsm)
if any(s.get(k) != v for k, v in want.items()):
    s.update(want)
    json.dump(s, open(f, "w"), indent=2)
    print("settings: developer mode on, pipeline from", rsm)
EOF
fi

export RUST_BACKTRACE=1 RUST_LOG="${RUST_LOG:-debug}"
exec pnpm tauri dev
