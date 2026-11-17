# SPDX-License-Identifier: AGPL-3.0-or-later
"""Approach B, fresh reconstruction of one short window with the road-reconstruction pipeline (preprocess, camera tracking, alignment only),
with the route folder in work/angle/colmap/ (video-derived data stays under work/) and COLMAP limited to 4 threads.

Run with the road-reconstruction venv, under tools/memguard.py:
  cd ../road-reconstruction && PYTHONPATH=../route-shape-matching .venv/bin/python -m rsm.angle.colmaprun <video-name> <start> <duration>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RR = Path(__file__).resolve().parents[3] / "road-reconstruction"
sys.path.insert(0, str(RR))

THREADS = 4


def patch_threads():
    import pycolmap
    ex, ms, ip = pycolmap.extract_features, pycolmap.match_sequential, pycolmap.incremental_mapping

    def extract_features(*a, **k):
        k["extraction_options"].num_threads = THREADS
        return ex(*a, **k)

    def match_sequential(*a, **k):
        mo = pycolmap.FeatureMatchingOptions()
        mo.num_threads = THREADS
        k["matching_options"] = mo
        return ms(*a, **k)

    def incremental_mapping(*a, **k):
        k["options"].num_threads = THREADS
        return ip(*a, **k)

    pycolmap.extract_features, pycolmap.match_sequential, pycolmap.incremental_mapping = extract_features, match_sequential, incremental_mapping


def main(name: str, start: float, duration: float):
    from backend import alignment, camera_tracking, preprocessing
    from backend.workspace import Route

    from . import videos

    patch_threads()
    rid = f"{name}-{int(start)}-{int(duration)}"
    route = Route.open(rid, routes_dir=videos.WORK / "colmap")
    route.save_config(dict(video=str(videos.VIDEOS[name]["video"]), start=start, duration=duration, use_gpx=0, scale_source="camera_height"))
    route.run_stage("preprocess", preprocessing.run)
    route.run_stage("camera_tracking", camera_tracking.run)
    route.run_stage("alignment", alignment.run)
    st = route.state()["stages"]
    print(json.dumps({k: st[k].get("seconds") for k in st}))


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]))
