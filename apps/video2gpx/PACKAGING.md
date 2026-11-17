# Packaging (milestone M2)

Goal: one `.app` that needs neither the research `.venv` nor Homebrew. Status: **the pipeline sidecar is bundled and works; the
decode-only FFmpeg is not built yet** (see "Remaining steps").

## Done and verified

### 1. PyInstaller onedir sidecar of `rsm.pipeline`

```sh
scripts/guard.sh scripts/build-sidecar.sh      # -> build/sidecar/rsm-pipeline/ (onedir, ~207 MB with `du`, 304 MB inside the .app)
```

- Creates `build/pyenv` from the research venv's interpreter (Python 3.14) with exactly
  `research/route-shape-matching/requirements-pipeline.txt` plus PyInstaller 6.22.3, then freezes `sidecar/rsm_sidecar.py`
  (the same CLI as `python -m rsm.pipeline`: `run`, `retime`, and the internal `_step` / `_memguard`, which the pipeline starts as
  `[sys.executable, ...]` when `sys.frozen`).
- Needed flags (found by running the pipeline): `--collect-submodules rsm`, `--hidden-import rsm.pipeline.allmods` (imported only
  dynamically for the code hash; without it step 7 fails with `No module named 'rsm.pipeline.allmods'`) and
  `--add-data .../rsm/pipeline/frozen.json:rsm/pipeline`.
- Verified through the Rust command layer (`src-tauri/tests/e2e.rs`, `V2G_SIDECAR=build/sidecar/rsm-pipeline/rsm-pipeline`): live
  motion progress, cancel (exit 130, no processes left), `--resume` of the finished Roanne checkpoints with refine and gpx run live,
  result loading, `retime`, export. Same result as with Python (verdict confident, 2649 points).
- The frozen build computes the pipeline code hash from the bundle instead of the source tree, so `code_hash` in `project.json`
  differs from the Python run. Resume across a Python run and a frozen run therefore may re-run steps (not tested).

### 2. Bundling into the .app

```sh
scripts/guard.sh scripts/build-sidecar.sh
scripts/guard.sh pnpm tauri build --config src-tauri/tauri.sidecar.conf.json     # release, ad-hoc signed
```

- `src-tauri/tauri.sidecar.conf.json` adds the onedir as a resource (`Contents/Resources/sidecar/rsm-pipeline/`). It is an overlay
  so that normal builds do not need the sidecar.
- At run time `settings::sidecar()` picks, in this order: Settings field "Gebündelte Pipeline", `V2G_SIDECAR`,
  `Contents/Resources/sidecar/rsm-pipeline/rsm-pipeline` next to the executable. If one exists, it replaces `python -m rsm.pipeline`
  (no Python, no `PYTHONPATH`); otherwise Python (M1).
- Signing: Tauri signs ad hoc (`signingIdentity: "-"`); PyInstaller ad-hoc-signs its binaries. `codesign --verify --deep --strict`
  passes. `spctl` rejects the app (no notarisation, as planned for local use): open it with right click, then "Open", or
  `xattr -dr com.apple.quarantine video2gpx.app` after copying it.

### 3. Size (release build with sidecar)

| part | size |
|---|---|
| `video2gpx.app` | **309 MiB** (`du`: 310 MB) |
| `Contents/MacOS` (Tauri binary, LTO, stripped) | 5.7 MB |
| `Contents/Resources/sidecar` (PyInstaller onedir) | 304 MB |
| debug build without sidecar | 39 MB |

The sidecar is large because of OpenCV (headless), SciPy and NumPy with their dylibs. Possible shrinking, not done: exclude unused
SciPy submodules (`--exclude-module scipy.io ...` after checking imports), `strip`, `upx` (not recommended on macOS), zip the
onedir into the app and unpack on first start, or build NumPy/SciPy without extras.

## Remaining steps

1. **Decode-only LGPL FFmpeg and FFprobe** (not built; the build step was refused by the permission system in the beta session).
   - `ffmpeg-8.1.1.tar.xz` was downloaded from ffmpeg.org into `build/ffmpeg/`; its sha256
     `b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3` equals Homebrew's formula hash. It is not extracted.
   - `scripts/ffmpeg-decode-only.sh` holds the intended configure line (untested): `--disable-everything`, no GPL, decoders h264,
     hevc, vp9, vp8, mpeg4, mpeg2, mjpeg and `libdav1d` (the Roanne video is AV1, FFmpeg's native AV1 decoder is hwaccel-only),
     VideoToolbox hwaccels, demuxers mov/matroska/avi/mpegts, filters `scale format select framestep showinfo fps null`, muxers
     `rawvideo image2 mjpeg null`, encoders `mjpeg rawvideo` (preview JPEGs), protocols `file pipe`, no network.
   - `libdav1d` is only available as a dylib from Homebrew: copy `libdav1d.7.dylib` next to the binaries and rewrite the load path
     with `install_name_tool -change ... @loader_path/libdav1d.7.dylib` (BSD-2, compatible with LGPL). A static dav1d build would
     avoid this.
   - Check with the test videos: AV1 (Roanne), H.264, HEVC, VP9 in mkv; HDR tone mapping needs `zscale` (libzimg); without it the
     preview falls back to plain scaling (already handled in `video.rs`).
   - Put `ffmpeg` and `ffprobe` into the bundle (resource folder `Contents/Resources/ffmpeg/`, or Tauri `externalBin` with target-triple
     names), and extend `settings.rs`: when `ffmpeg` is not set, prefer the bundled one before PATH/Homebrew (`find_tool`). The pipeline already
     reads `RSM_FFMPEG` / `RSM_FFPROBE`, which the app sets.
   - Ship the LGPL notice and the FFmpeg source offer (the tarball plus the configure line) with the app.
2. **Python-free first start check:** run the .app on a Mac without Homebrew and without the research venv (e.g. a fresh user), with
   the bundled sidecar and ffmpeg; the settings screen should show all four checks green.
3. **Resource limits:** the sidecar keeps the pipeline's own memory guard (12 GB / 25 % free). Nothing else to bundle.
4. **Licence files** for the bundled Python packages (numpy, scipy, opencv, osmium, shapely, pyproj, requests) and the pipeline
   itself (AGPL-3.0-or-later); note that osmium and the pipeline are AGPL-3.0 compatible but check the combined notice.
5. **Notarisation** (later, for distribution): Developer ID signing of every Mach-O in the sidecar (`codesign --options runtime`),
   hardened-runtime entitlements for the unsigned-memory behaviour of NumPy/OpenCV if needed (`com.apple.security.cs.allow-unsigned-executable-memory`
   is usually not required), then `notarytool`. Direct distribution only (the import command cannot run in the App Store sandbox).
