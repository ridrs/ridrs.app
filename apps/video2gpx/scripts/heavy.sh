#!/bin/sh
# Machine-wide lock for heavy jobs: only one at a time (see docs/README.md). Usage: scripts/heavy.sh <command...>
# Waits for the lock, then runs the command under scripts/guard.sh. Stale locks (dead pid) are taken over.
LOCK="${V2G_HEAVY_LOCK:-/tmp/video2gpx-heavy.lock}"
while ! mkdir "$LOCK" 2>/dev/null; do
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  sleep 5
done
echo $$ > "$LOCK/pid"
# a run started from the app (user's job) also counts as heavy: wait until it is finished. The bundled sidecar is `rsm-pipeline run`, a dev app or
# a manual run is `python -m rsm.pipeline run`; the bench runs single steps (`_step`) and is not matched. Only processes whose program is the
# sidecar or a Python count: the shells that start this script (and this script itself) carry the same words in their command line, and a
# `heavy.sh python -m rsm.pipeline run` would otherwise wait for itself forever.
PAT='^[^ ]*python[0-9.]* (-[^ ]+ )*-m rsm\.pipeline run( |$)|^[^ ]*rsm-pipeline run( |$)'
running() { ps -axo command= | grep -Eq "$PAT"; }
while running; do sleep 15; done
trap 'rm -rf "$LOCK"' EXIT INT TERM
"$(dirname "$0")/guard.sh" "$@"
