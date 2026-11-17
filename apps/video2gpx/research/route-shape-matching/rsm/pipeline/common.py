# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared helpers: environment (ffmpeg, data dir), JSON-lines events, checkpoints, code hash. Writes only under --out and RSM_DATA_DIR."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

PKG = Path(__file__).resolve().parent
ROOT = PKG.parents[1]


# ------------------------------------------------------------------ environment
def ffmpeg_bin() -> str:
    return os.environ.get("RSM_FFMPEG", "ffmpeg")


def ffprobe_bin() -> str:
    """RSM_FFPROBE, else `ffprobe` next to RSM_FFMPEG if that is a path, else `ffprobe` on PATH"""
    if os.environ.get("RSM_FFPROBE"):
        return os.environ["RSM_FFPROBE"]
    f = os.environ.get("RSM_FFMPEG")
    if f and os.sep in f:
        return str(Path(f).with_name("ffprobe"))
    return "ffprobe"


def hwaccel_enabled() -> bool:
    return os.environ.get("RSM_HWACCEL", "1") != "0"


def data_dir(out: Path) -> Path:
    d = Path(os.environ["RSM_DATA_DIR"]) if os.environ.get("RSM_DATA_DIR") else Path(out) / "_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ------------------------------------------------------------------ events (JSON lines)
def emit(obj: dict, stream=None) -> None:
    (stream or sys.stdout).write(json.dumps(obj, separators=(",", ":"), default=_js) + "\n")
    (stream or sys.stdout).flush()


def _js(o):
    import numpy as np
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, Path):
        return str(o)
    return str(o)


class Worker:
    """what a step worker (a subprocess) prints on stdout: progress / status / log lines for the parent to forward"""

    def __init__(self):
        self._last = 0.0

    def progress(self, pct: float, phase: str = "", force: bool = False):
        now = time.time()
        if force or now - self._last >= 0.7 or pct >= 100:
            self._last = now
            emit({"type": "progress", "pct": round(float(pct), 1), "phase": phase})

    def status(self, signal: str, level: str, value, message: str):
        emit({"type": "status", "signal": signal, "level": level, "value": value, "message": message})

    def log(self, level: str, message: str):
        emit({"type": "log", "level": level, "message": message})


def jdump(path: Path, obj) -> None:
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, default=_js))
    os.replace(tmp, path)


def jload(path: Path):
    return json.loads(Path(path).read_text())


def sha(*parts) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(json.dumps(p, sort_keys=True, default=str).encode())
    return h.hexdigest()[:16]


def file_sig(p) -> dict:
    s = Path(p).stat()
    return {"path": str(Path(p).resolve()), "size": s.st_size, "mtime": int(s.st_mtime)}


def frozen_info() -> dict:
    """version and code hash of the frozen pipeline, from the frozen.json that ships next to the code (also inside the sidecar bundle)"""
    try:
        f = json.loads((PKG / "frozen.json").read_text())
        return dict(version=f.get("version"), code_hash=f.get("code_hash"))
    except (OSError, ValueError):
        return dict(version=None, code_hash=None)


# ------------------------------------------------------------------ code hash of every module the pipeline uses
def used_modules() -> list[str]:
    """modules of the package pipeline, found in a clean interpreter (other imports of the calling process do not count)"""
    import subprocess
    code = "import sys, rsm.pipeline.allmods; print(chr(10).join(sorted(m for m in sys.modules if m == 'rsm' or m.startswith('rsm.'))))"
    try:
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(ROOT), env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"), timeout=60)
        if r.returncode == 0 and r.stdout.strip():
            import importlib
            mods = r.stdout.split()
            for m in mods:
                importlib.import_module(m)
            return mods
    except (OSError, subprocess.SubprocessError):
        pass
    import importlib
    importlib.import_module("rsm.pipeline.allmods")
    return sorted(m for m in sys.modules if m == "rsm" or m.startswith("rsm."))


def code_hash() -> tuple[str, dict]:
    h = hashlib.sha256()
    files = {}
    for m in used_modules():
        f = getattr(sys.modules[m], "__file__", None)
        if f and Path(f).exists():
            b = Path(f).read_bytes()
            files[m] = hashlib.sha256(b).hexdigest()[:12]
            h.update(m.encode()); h.update(b)
    return h.hexdigest()[:16], files
