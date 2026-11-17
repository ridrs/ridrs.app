#!/bin/sh
# Run a heavy command under the research package's memory guard (kills the group above 12 GB or below 25 % free).
RSM="${RSM_DIR:-$(cd "$(dirname "$0")/.." && pwd)/research/route-shape-matching}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
exec "$RSM/.venv/bin/python" "$RSM/tools/memguard.py" --max-gb 12 --min-free 25 -- "$@"
