#!/bin/sh
# Writes THIRD_PARTY_LICENSES.txt: the licence texts of every Python distribution installed in a build env (default build/pyenv),
# minus the build-only tools (pip, setuptools, pyinstaller...), plus the OpenCV licence when build/opencv-min exists, plus the
# notices for the native libraries that wheels bundle (GEOS, PROJ, libosmium, expat, ...).
# Usage: scripts/gen-third-party-licenses.sh <env-dir> <out-file>
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENVD="${1:-$HERE/build/pyenv}"
OUT="${2:-$HERE/build/THIRD_PARTY_LICENSES.txt}"
"$ENVD/bin/python" -I - "$ENVD" "$OUT" "$HERE/build/opencv-min/LICENSE" "$HERE/scripts/third-party-notices.txt" <<'PY'
import sys, glob, os
from importlib import metadata
env, out, cvlic, notices = sys.argv[1:5]
SKIP = {"pip", "setuptools", "wheel", "pyinstaller", "pyinstaller-hooks-contrib", "altgraph", "macholib", "packaging"}
parts = ["Third-party software bundled with video2gpx (Python sidecar). video2gpx itself is AGPL-3.0-or-later.\n"]
for d in sorted(metadata.distributions(path=glob.glob(env + "/lib/python*/site-packages")), key=lambda d: d.metadata["Name"].lower()):
    name = d.metadata["Name"]
    if name.lower() in SKIP:
        continue
    if name.lower().startswith("opencv"):
        continue
    parts.append("=" * 78 + f"\n{name} {d.version}  License: {d.metadata.get('License-Expression') or d.metadata.get('License') or 'see below'}\n" + "=" * 78)
    texts = [f for f in (d.files or []) if os.path.basename(str(f)).upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS")) and "licenses" in str(f).lower() or os.path.basename(str(f)).upper() in ("LICENSE", "LICENSE.TXT", "COPYING", "NOTICE")]
    seen = set()
    for f in texts:
        p = str(d.locate_file(f))
        if p in seen or not os.path.isfile(p):
            continue
        seen.add(p)
        parts.append(f"--- {f} ---\n" + open(p, errors="replace").read())
    if not seen:
        parts.append(d.metadata.get("License") or "(no licence file in the distribution)")
if os.path.isfile(cvlic):
    parts.append("=" * 78 + "\nOpenCV 5.0.0 (minimal build: core, imgproc, video)  License: Apache-2.0\n" + "=" * 78 + "\n" + open(cvlic).read())
if os.path.isfile(notices):
    parts.append(open(notices).read())
open(out, "w").write("\n\n".join(parts) + "\n")
print("wrote", out, os.path.getsize(out), "bytes")
PY
