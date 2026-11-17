#!/bin/sh
# Minimal OpenCV 5.0.0 (core + imgproc + video + python3 bindings; no ffmpeg, codecs, gui, OpenCL, DNN) for the sidecar.
# The pipeline only uses calcOpticalFlowPyrLK, goodFeaturesToTrack, fillPoly, setNumThreads and TERM_CRITERIA_* (frames come
# from the ffmpeg pipe), so the PyPI wheel's ~110 MB of FFmpeg/x264/x265/tesseract/... is dead weight (and GPL-flavoured).
# Usage (heavy: one job at a time):  scripts/heavy.sh scripts/build-opencv-min.sh [PYTHON]
#   PYTHON defaults to build/pyenv/bin/python (its version and numpy headers are used).
# Result: build/opencv-min/cv2/ (a ready-to-copy package, ~5-8 MB, apache-2.0) + build/opencv-min/LICENSE.
# Idempotent: exits at once when build/opencv-min/cv2 exists for the same Python ABI (delete the folder to rebuild).
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
B="$HERE/build"
PY="${1:-${PYENV_DIR:-$B/pyenv}/bin/python}"
VER=5.0.0
SHA=b0528f5a1d379d59d4701cb28c36e22214cc51cf64594e5b56f2d3e6c0233095
ABI="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
OUT="$B/opencv-min"
if [ -f "$OUT/abi" ] && [ "$(cat "$OUT/abi")" = "$ABI" ] && [ -d "$OUT/cv2" ]; then echo "opencv-min present ($ABI)"; exit 0; fi

# build tools (cmake, ninja) from PyPI into an own venv; the project needs no system cmake
if [ ! -x "$B/tools-venv/bin/cmake" ]; then
  "$PY" -m venv "$B/tools-venv"
  "$B/tools-venv/bin/pip" install -q cmake ninja
fi
export PATH="$B/tools-venv/bin:$PATH"

# source tarball, checked against a pinned hash
mkdir -p "$B/opencv-src-dl"
TAR="$B/opencv-src-dl/opencv-$VER.tar.gz"
if [ ! -f "$TAR" ]; then curl -fsSL -o "$TAR" "https://github.com/opencv/opencv/archive/refs/tags/$VER.tar.gz"; fi
[ "$(shasum -a 256 "$TAR" | cut -d' ' -f1)" = "$SHA" ] || { echo "opencv tarball hash mismatch" >&2; exit 1; }
SRC="$B/opencv-src/opencv-$VER"
if [ ! -d "$SRC" ]; then mkdir -p "$B/opencv-src" && tar xzf "$TAR" -C "$B/opencv-src"; fi

BLD="$B/opencv-min-build"
rm -rf "$BLD" "$OUT"
mkdir -p "$BLD" "$OUT"
cmake -S "$SRC" -B "$BLD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_INSTALL_PREFIX="$OUT/prefix" \
  -DBUILD_LIST=core,imgproc,video,python3 \
  -DBUILD_SHARED_LIBS=OFF -DOPENCV_FORCE_3RDPARTY_BUILD=OFF \
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_DOCS=OFF -DBUILD_opencv_apps=OFF -DBUILD_JAVA=OFF \
  -DWITH_FFMPEG=OFF -DWITH_OPENCL=OFF -DWITH_IPP=OFF -DWITH_TBB=OFF -DWITH_PNG=OFF -DWITH_JPEG=OFF -DWITH_TIFF=OFF \
  -DWITH_WEBP=OFF -DWITH_OPENEXR=OFF -DWITH_AVIF=OFF -DWITH_JASPER=OFF -DWITH_OPENJPEG=OFF -DWITH_PROTOBUF=OFF \
  -DWITH_ITT=OFF -DWITH_AVFOUNDATION=OFF -DWITH_OBSENSOR=OFF -DWITH_GSTREAMER=OFF -DWITH_QUIRC=OFF \
  -DWITH_ADE=OFF -DWITH_EIGEN=OFF -DWITH_LAPACK=OFF -DWITH_OPENCV_PYTHON=ON \
  -DPYTHON3_EXECUTABLE="$PY" -DOPENCV_PYTHON3_INSTALL_PATH="$OUT/py" -DOPENCV_PYTHON_SKIP_DETECTION=OFF \
  -DBUILD_opencv_python3=ON -DBUILD_opencv_python_bindings_generator=ON
cmake --build "$BLD" -j "${CARGO_BUILD_JOBS:-4}"
cmake --install "$BLD"
mv "$OUT/py/cv2" "$OUT/cv2"
cp "$SRC/LICENSE" "$OUT/LICENSE"
echo "$ABI" > "$OUT/abi"
rm -rf "$BLD" "$OUT/prefix" "$OUT/py"
du -sh "$OUT/cv2"
