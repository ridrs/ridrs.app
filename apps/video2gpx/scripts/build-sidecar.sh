#!/bin/sh
# M2: freeze rsm.pipeline into a PyInstaller onedir bundle (build/sidecar/rsm-pipeline/). Run under the machine-wide lock:
#   scripts/heavy.sh scripts/build-sidecar.sh
# Size steps (PACKAGING.md, plan steps 1, 3-5): unused stdlib/tooling excluded, bytecode at optimize level 2, the top-level
# dylib symlinks removed (Tauri copies symlinks as files: +97 MB) and replaced by rpaths to the package .dylibs folders,
# every Mach-O stripped (-x) and ad-hoc re-signed.
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RSM="${RSM_DIR:-$(cd "$(dirname "$0")/.." && pwd)/research/route-shape-matching}"
PY="$HERE/build/pyenv/bin/python"
if [ ! -x "$PY" ]; then
  "$RSM/.venv/bin/python" -m venv "$HERE/build/pyenv"
  "$HERE/build/pyenv/bin/pip" install -r "$RSM/requirements-pipeline.txt" pyinstaller
fi
cd "$HERE/build"
ARCH=$(uname -m)
NATIVE_SO="$RSM/rsm/hmm_cal/_dp_native_${ARCH}.so"
if [ -f "$RSM/rsm/hmm_cal/_dp_native.c" ] && [ ! -f "$NATIVE_SO" -o "$RSM/rsm/hmm_cal/_dp_native.c" -nt "$NATIVE_SO" ]; then
  cc -O3 -shared -fPIC -lpthread -o "$NATIVE_SO" "$RSM/rsm/hmm_cal/_dp_native.c"
fi
PBF_SO="$RSM/rsm/pipeline/_pbf_native_${ARCH}.so"
if [ -f "$RSM/rsm/pipeline/_pbf_native.c" ] && [ ! -f "$PBF_SO" -o "$RSM/rsm/pipeline/_pbf_native.c" -nt "$PBF_SO" ]; then
  cc -O3 -shared -fPIC -lz -lpthread -o "$PBF_SO" "$RSM/rsm/pipeline/_pbf_native.c"
fi
METAL_SO="$RSM/rsm/pipeline/vmsx/_lk_metal_${ARCH}.so"
if [ "$(uname -s)" = "Darwin" ] && [ -f "$RSM/rsm/pipeline/vmsx/_lk_metal.m" ] && [ ! -f "$METAL_SO" -o "$RSM/rsm/pipeline/vmsx/_lk_metal.m" -nt "$METAL_SO" ]; then
  clang -O3 -shared -fPIC -fobjc-arc -framework Foundation -framework Metal -o "$METAL_SO" "$RSM/rsm/pipeline/vmsx/_lk_metal.m"
fi
NATIVE_ARGS=""
if [ -f "$NATIVE_SO" ]; then
  NATIVE_ARGS="$NATIVE_ARGS --add-binary $NATIVE_SO:rsm/hmm_cal"
fi
if [ -f "$PBF_SO" ]; then
  NATIVE_ARGS="$NATIVE_ARGS --add-binary $PBF_SO:rsm/pipeline"
fi
if [ -f "$METAL_SO" ]; then
  NATIVE_ARGS="$NATIVE_ARGS --add-binary $METAL_SO:rsm/pipeline/vmsx"
fi
PYTHONDONTWRITEBYTECODE=1 "$PY" -m PyInstaller --noconfirm --clean --onedir --name rsm-pipeline \
  --distpath sidecar --workpath sidecar-work --specpath sidecar-work --optimize 2 \
  --paths "$RSM" --collect-submodules rsm --hidden-import rsm.pipeline.allmods \
  --add-data "$RSM/rsm/pipeline/frozen.json:rsm/pipeline" \
  $NATIVE_ARGS \
  --exclude-module tkinter --exclude-module matplotlib --exclude-module pandas \
  --exclude-module IPython --exclude-module pytest --exclude-module pip --exclude-module setuptools \
  --exclude-module lib2to3 --exclude-module xmlrpc --exclude-module curses --exclude-module sqlite3 \
  "$HERE/sidecar/rsm_sidecar.py"
du -sh sidecar/rsm-pipeline

INT="$HERE/build/sidecar/rsm-pipeline/_internal"
# 1. symlink de-dup: drop the top-level links into <pkg>/.dylibs, give every Mach-O an rpath to each such folder
DIRS=$(cd "$INT" && find . -maxdepth 1 -type l -exec readlink {} \; | grep '/\.dylibs/' | sed 's#/[^/]*$##' | sort -u)
(cd "$INT" && find . -maxdepth 1 -type l | while read -r l; do case "$(readlink "$l")" in */.dylibs/*) rm "$l";; esac; done)
# a link to a removed link (libzstd.1.dylib -> libzstd.1.5.7.dylib, for the stdlib _zstd module) now points into the void:
# point it at the real file instead (Tauri copies it once, 0.6 MB); a bundle with a dangling link does not build
(cd "$INT" && find . -maxdepth 1 -type l ! -exec test -e {} \; -print | while read -r l; do
  t=$(for d in $DIRS; do [ -f "$d/$(readlink "$l")" ] && echo "$d/$(readlink "$l")" && break; done)
  if [ -n "$t" ]; then ln -sfh "$t" "$l"; else echo "dangling link $l" >&2; exit 1; fi
done)
# (the main executable carries the appended PyInstaller archive: neither rewritten nor stripped)
MACHOS=$(find "$INT" -type f \( -name '*.so' -o -name '*.dylib' \) ! -path '*Python.framework*')
for f in $MACHOS; do
  otool -l "$f" | grep -q LC_RPATH || continue
  fdir=$(dirname "$f")
  for d in $DIRS; do
    rel=$("$PY" -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$INT/$d" "$fdir")
    install_name_tool -add_rpath "@loader_path/$rel" "$f" 2>/dev/null || true
  done
done
# 2. strip local symbols, 3. ad-hoc re-sign (install_name_tool and strip invalidate the signature; arm64 refuses unsigned code)
for f in $MACHOS; do strip -x "$f" 2>/dev/null || true; codesign -f -s - "$f" 2>/dev/null; done
du -sh sidecar/rsm-pipeline
