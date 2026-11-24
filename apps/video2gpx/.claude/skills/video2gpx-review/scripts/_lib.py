# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared helpers of the video2gpx-review scripts. Run every script with the research venv's python
(numpy, scipy, pyproj, matplotlib); the rsm package is imported read-only from the runner worktree (or --rsm / V2G_RSM)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# This skill lives in the ridrs_app repo (apps/video2gpx/.claude/skills/<skill>/scripts); the repo is checked out as Ridrs/ridrs_app
# or as a worktree in Ridrs/ridrs_app-worktrees/<name>. The data (runs, test suite, caches) stay outside the repo, next to it in
# Ridrs/video2gpx-runs. V2G_RIDRS overrides the search.
APP_REPO = Path(__file__).resolve().parents[6]       # the ridrs_app checkout this skill belongs to


def _ridrs() -> Path:
    if os.environ.get("V2G_RIDRS"):
        return Path(os.environ["V2G_RIDRS"]).expanduser().resolve()
    for d in APP_REPO.parents:
        if (d / "video2gpx-runs").is_dir():
            return d
    sys.exit(f"no Ridrs folder with video2gpx-runs/ above {APP_REPO}; set V2G_RIDRS")


RIDRS = _ridrs()                                     # .../Ridrs
RUNS = RIDRS / "video2gpx-runs"
SUITE = Path(os.environ.get("V2G_SUITE") or RUNS / "_testsuite")   # V2G_SUITE: a scratch suite for trying things out
DEFAULT_RSM = RIDRS / "ridrs_app-worktrees/video2gpx-runner/apps/video2gpx/research/route-shape-matching"
OSM_DIR = Path.home() / "Library/Application Support/org.video2gpx.app/osm"


def rsm_dir(arg: str | None = None) -> Path:
    d = Path(arg or os.environ.get("V2G_RSM") or DEFAULT_RSM).expanduser().resolve()
    if not (d / "rsm" / "pipeline").is_dir():
        sys.exit(f"not a route-shape-matching directory: {d}")
    return d


def use_rsm(arg: str | None = None) -> Path:
    d = rsm_dir(arg)
    if str(d) not in sys.path:
        sys.path.insert(0, str(d))
    return d


def run_dir(arg: str) -> Path:
    """accepts a YouTube id, video2gpx-runs/<id>, or the run/ directory itself"""
    p = Path(arg)
    for c in (p, RUNS / arg):
        if (c / "run" / "project.json").exists():
            return c.resolve()
        if (c / "project.json").exists():
            return c.resolve().parent
    sys.exit(f"no finished run found for {arg} (expected <dir>/run/project.json)")


def jload(p: Path):
    return json.loads(Path(p).read_text())


def jdump(obj, p: Path):
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    Path(p).write_text(json.dumps(obj, indent=1, ensure_ascii=False, default=float))


def video_of(rd: Path) -> Path:
    v = jload(rd / "run" / "project.json")["params"]["video"]
    return Path(v)


def fmt_t(t: float) -> str:
    t = int(round(t))
    return f"{t // 3600}:{t // 60 % 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def ffmpeg(*args: str):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


class Path1D:
    """positions along the decoded path: arc length sg (m) -> xy in the run's metric CRS"""

    def __init__(self, sg, xy):
        import numpy as np
        self.sg, self.xy = np.asarray(sg, float), np.asarray(xy, float)

    def xy_at(self, s):
        import numpy as np
        s = np.clip(np.asarray(s, float), self.sg[0], self.sg[-1])
        return np.column_stack([np.interp(s, self.sg, self.xy[:, 0]), np.interp(s, self.sg, self.xy[:, 1])])

    def heading_at(self, s, ds: float = 5.0):
        import numpy as np
        a, b = self.xy_at(np.asarray(s) - ds), self.xy_at(np.asarray(s) + ds)
        return np.degrees(np.arctan2(b[:, 0] - a[:, 0], b[:, 1] - a[:, 1])) % 360


def transformer(crs: str, to_wgs: bool = True):
    from pyproj import Transformer
    return Transformer.from_crs(crs, 4326, always_xy=True) if to_wgs else Transformer.from_crs(4326, crs, always_xy=True)
