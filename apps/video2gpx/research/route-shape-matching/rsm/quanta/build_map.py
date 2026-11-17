# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.quanta.build_map <video> [--thr 45] [--straight-max 3000]: map events and legs of the video's area -> work/quanta/map_<video>_<thr>.npz"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np

from rsm.network.graph import NetGraph

from . import legs
from .area import WORK


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--thr", type=float, default=45.0)
    ap.add_argument("--straight-max", type=float, default=3000.0)
    ap.add_argument("--workers", type=int, default=10)
    a = ap.parse_args()
    g = NetGraph.load(WORK / "cache" / f"graph_{a.video}.npz")
    t0 = time.time()
    m = legs.build_legs(g, a.thr, a.straight_max, a.workers)
    legs.save(WORK / f"map_{a.video}_{int(a.thr)}.npz", m)
    q = m["q"]
    # self-ambiguity: legs sharing a coarse key
    key = np.stack([q["sign1"], np.round(np.log(q["ang1"]) / 0.25), q["sign2"], np.round(np.log(q["ang2"]) / 0.25)], 1)
    _, cnt = np.unique(key, axis=0, return_counts=True)
    st = dict(video=a.video, thr=a.thr, straight_max=a.straight_max, events=int(len(m["events"]["sign"])), legs=int(len(q["sign1"])), seconds=time.time() - t0,
              median_legs_per_event=float(np.median(np.bincount(m["leg_a"], minlength=len(m["events"]["sign"])))), coarse_key_classes=int(len(cnt)),
              coarse_key_share_of_legs_in_largest=float(cnt.max() / cnt.sum()))
    print(json.dumps(st))
    (WORK / f"map_{a.video}_{int(a.thr)}.json").write_text(json.dumps(st, indent=1))


if __name__ == "__main__":
    main()
