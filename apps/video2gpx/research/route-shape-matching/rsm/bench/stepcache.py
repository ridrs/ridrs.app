# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY step cache of the regression bench (docs/CONCEPT_fast_testing.md, block A). Not frozen, not in the sidecar.

Every pipeline step of a bench case gets a key from what it really depends on:
  - the key of the step before it (a chain: a changed step reruns everything after it),
  - the code it runs: the static import closure (rsm.* only) of the step's module, file contents hashed; config.py is not hashed as a file,
  - the values of the config names its code reads (`C.NAME`, `config.NAME`, `from .config import NAME`),
  - the parameters of the case that reach it (motion and rotation: the video only; later steps: all params, with file signatures).
So a change in local.py reruns refine and gpx only; a changed LOCAL_* value the same; a change in the vms code reruns everything.

Known limits: the closure is static, so a module that is only reached through a string import is missed (none in rsm.pipeline today); motion and
rotation share steps_a.py, so an edit of steps_a reruns both; network.* and pipeline.osm are left out of motion / rotation (they only compute the
bbox size for a status there)."""
from __future__ import annotations

import ast
import hashlib
import json
import re
import runpy
import shutil
from pathlib import Path

STEP_ENTRY = dict(motion=["rsm.pipeline.steps_a"], rotation=["rsm.pipeline.steps_a"], map=["rsm.pipeline.steps_b"], route_search=["rsm.pipeline.steps_b"],
                  plausibility=["rsm.pipeline.steps_b"], refine=["rsm.pipeline.steps_c"], gpx=["rsm.pipeline.steps_d"])
EXCLUDE = dict(motion=("rsm.network", "rsm.pipeline.osm"), rotation=("rsm.network", "rsm.pipeline.osm"))
VIDEO_ONLY = ("motion", "rotation")
ROOT_FILES = dict(gpx=("project.json", "route.gpx", "route_points.json"))   # files a step writes next to its directory
ROOT_DIRS = dict(motion=("extract",))         # directories a step writes next to its own (the extraction, which the rotation step reads too)
_CFG = re.compile(r"\b(?:C|config)\.([A-Z][A-Z0-9_]*)\b")
VERSION = "stepcache1"


def _mod_file(root: Path, m: str) -> Path | None:
    p = root.joinpath(*m.split("."))
    for f in (p.with_suffix(".py"), p / "__init__.py"):
        if f.exists():
            return f
    return None


def _imports(root: Path, m: str) -> set[str]:
    f = _mod_file(root, m)
    tree = ast.parse(f.read_text())
    pkg = m if f.name == "__init__.py" else m.rsplit(".", 1)[0]
    out = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            out |= {a.name for a in n.names if a.name.startswith("rsm")}
        elif isinstance(n, ast.ImportFrom):
            base = n.module or ""
            if n.level:
                parts = pkg.split(".")
                parts = parts[:len(parts) - n.level + 1]
                base = ".".join(parts + ([base] if base else []))
            if not base.startswith("rsm"):
                continue
            for a in n.names:
                cand = f"{base}.{a.name}"
                out.add(cand if _mod_file(root, cand) else base)
    return {x for x in out if _mod_file(root, x)}


def closure(root: Path, entries, exclude=()) -> list[str]:
    seen, todo = set(), list(entries)
    while todo:
        x = todo.pop()
        if x in seen or any(x == e or x.startswith(e + ".") for e in exclude):
            continue
        seen.add(x)
        todo += sorted(_imports(root, x))
    return sorted(seen)


def _config_names(src: str) -> set[str]:
    names = set(_CFG.findall(src))
    for n in ast.walk(ast.parse(src)):
        if isinstance(n, ast.ImportFrom) and (n.module or "").endswith("config"):
            names |= {a.name for a in n.names}
    return names


def _file_hash(p) -> str | None:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()[:16] if Path(p).exists() else None


def step_keys(root: Path, P: dict, steps: list[str], video_sig=None) -> dict:
    """{step: key} for the code under `root` (the directory that holds the rsm package) and the case params P. `video_sig` replaces the
    signature of the video file (path, size, mtime), for example by its sha256 for a frozen stage (rsm.bench.stages) whose source may move."""
    root = Path(root)
    cfg = runpy.run_path(str(root / "rsm" / "pipeline" / "config.py"))
    out, prev = {}, VERSION

    def sig(p):
        if not p or not Path(p).exists():
            return None
        s = Path(p).stat()
        return [str(Path(p).resolve()), s.st_size, int(s.st_mtime)]

    hint = P.get("hint")
    p_all = dict(P, video=video_sig if video_sig is not None else sig(P.get("video")), pbf=sig(P.get("pbf")), hint=(hashlib.sha256(Path(hint).read_bytes()).hexdigest()[:16] if hint and Path(hint).exists() else hint))
    for sid in steps:
        mods = closure(root, STEP_ENTRY[sid], EXCLUDE.get(sid, ()))
        files, names = {}, set()
        for m in mods:
            src = _mod_file(root, m).read_text()
            names |= _config_names(src)
            if m != "rsm.pipeline.config":
                files[m] = hashlib.sha256(src.encode()).hexdigest()[:16]
        vals = {n: repr(cfg[n]) for n in sorted(names) if n in cfg}
        params = (dict(video=p_all["video"], **({"calibration": _file_hash(P["calibration"])} if P.get("calibration") else {}),
                       **({"frame0": int(P["frame0"])} if P.get("frame0") else {}),
                       **({"horizon": P["horizon"]} if P.get("horizon", "running") != "running" else {}))
                  if sid in VIDEO_ONLY else p_all)
        h = hashlib.sha256(json.dumps([prev, sid, files, vals, params], sort_keys=True, default=str).encode()).hexdigest()[:16]
        out[sid] = prev = h
    return out


# ------------------------------------------------------------------ the store
def entry(cache: Path, case: str, sid: str, key: str) -> Path:
    return Path(cache) / case / sid / key


def has(cache: Path, case: str, sid: str, key: str) -> bool:
    e = entry(cache, case, sid, key)
    return (e / sid).is_dir() and (e / "done.json").exists() and all((e / "_root" / f).exists() for f in ROOT_FILES.get(sid, ()))


def fetch(cache: Path, case: str, sid: str, key: str, d: Path) -> bool:
    if not has(cache, case, sid, key):
        return False
    e = entry(cache, case, sid, key)
    if (d / sid).exists():
        shutil.rmtree(d / sid)
    shutil.copytree(e / sid, d / sid)
    (d / "steps").mkdir(exist_ok=True)
    shutil.copy2(e / "done.json", d / "steps" / f"{sid}.done.json")
    for f in ROOT_FILES.get(sid, ()):
        if (e / "_root" / f).exists():
            shutil.copy2(e / "_root" / f, d / f)
    for x in ROOT_DIRS.get(sid, ()):
        if (d / x).exists():
            shutil.rmtree(d / x)
        if (e / "_root" / x).is_dir():
            shutil.copytree(e / "_root" / x, d / x)
    return True


def store(cache: Path, case: str, sid: str, key: str, d: Path, note: str = "") -> None:
    e = entry(cache, case, sid, key)
    tmp = e.with_name(e.name + ".tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    shutil.copytree(d / sid, tmp / sid)
    shutil.copy2(d / "steps" / f"{sid}.done.json", tmp / "done.json")
    for f in ROOT_FILES.get(sid, ()):
        if (d / f).exists():
            (tmp / "_root").mkdir(exist_ok=True)
            shutil.copy2(d / f, tmp / "_root" / f)
    for x in ROOT_DIRS.get(sid, ()):
        if (d / x).is_dir():
            shutil.copytree(d / x, tmp / "_root" / x)
    (tmp / "origin.json").write_text(json.dumps(dict(run_dir=str(d), note=note)))
    if e.exists():
        shutil.rmtree(e)
    tmp.rename(e)
