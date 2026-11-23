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

ARCH="$(uname -m)"
NATIVE_SRC="$RSM/rsm/hmm_cal/_dp_native.c"
NATIVE_SO="$RSM/rsm/hmm_cal/_dp_native_${ARCH}.so"
if [ -f "$NATIVE_SRC" ] && command -v cc >/dev/null && [ ! -f "$NATIVE_SO" -o "$NATIVE_SRC" -nt "$NATIVE_SO" ]; then
  cc -O3 -shared -fPIC -lm -lpthread -o "$NATIVE_SO" "$NATIVE_SRC" || true
fi
PBF_SRC="$RSM/rsm/pipeline/_pbf_native.c"
PBF_SO="$RSM/rsm/pipeline/_pbf_native_${ARCH}.so"
if [ -f "$PBF_SRC" ] && command -v cc >/dev/null && [ ! -f "$PBF_SO" -o "$PBF_SRC" -nt "$PBF_SO" ]; then
  cc -O3 -shared -fPIC -lz -lpthread -o "$PBF_SO" "$PBF_SRC" || true
fi
METAL_SRC="$RSM/rsm/pipeline/vmsx/_lk_metal.m"
METAL_SO="$RSM/rsm/pipeline/vmsx/_lk_metal_${ARCH}.so"
if [ "$(uname -s)" = "Darwin" ] && [ -f "$METAL_SRC" ] && command -v clang >/dev/null && [ ! -f "$METAL_SO" -o "$METAL_SRC" -nt "$METAL_SO" ]; then
  clang -O3 -shared -fPIC -fobjc-arc -framework Foundation -framework Metal -o "$METAL_SO" "$METAL_SRC" || true
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
