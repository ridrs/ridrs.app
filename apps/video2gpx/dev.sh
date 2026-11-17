#!/bin/zsh
# Start video2gpx in debug mode: Tauri dev build (Rust debug, Vite with hot reload on port 1450) and the pipeline from the source
# (research/route-shape-matching/.venv, `python -m rsm.pipeline`) instead of the frozen sidecar.
# Usage: ./dev.sh            (sets developer mode in the app settings if it is off)
#        ./dev.sh --no-settings   (leaves the settings as they are)
set -e
cd "$(dirname "$0")"
RSM=research/route-shape-matching
SETTINGS="$HOME/Library/Application Support/org.video2gpx.app/settings.json"

if pgrep -x video2gpx >/dev/null; then
  echo "video2gpx is already running (pid $(pgrep -x video2gpx | tr '\n' ' ')); quit it first." >&2
  exit 1
fi
[ -x "$RSM/.venv/bin/python" ] || { echo "missing $RSM/.venv (python venv of the pipeline)" >&2; exit 1; }
command -v cargo >/dev/null || export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo "cargo not found" >&2; exit 1; }
[ -d node_modules ] || pnpm install

if [ "$1" != "--no-settings" ] && [ -f "$SETTINGS" ]; then
  "$RSM/.venv/bin/python" - "$SETTINGS" "$PWD/$RSM" <<'EOF'
import json, sys
f, rsm = sys.argv[1], sys.argv[2]
s = json.load(open(f))
want = dict(dev_mode=True, sidecar="", python=f"{rsm}/.venv/bin/python", rsm_dir=rsm)
if any(s.get(k) != v for k, v in want.items()):
    s.update(want)
    json.dump(s, open(f, "w"), indent=2)
    print("settings: developer mode on, pipeline from", rsm)
EOF
fi

export RUST_BACKTRACE=1 RUST_LOG="${RUST_LOG:-debug}"
exec pnpm tauri dev
