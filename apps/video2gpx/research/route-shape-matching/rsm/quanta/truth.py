# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.quanta.truth <video>: map-match the GPS track, check the area (GPS used only for this report) -> work/quanta/truth_<video>.json"""
from __future__ import annotations

import json
import sys
import time

import numpy as np

from . import area as areamod
from . import evalrun as ev
from . import mapmatch


def main(vid: str) -> dict:
    ctx = ev.load_ctx(vid)
    t0 = time.time()
    ix = mapmatch.EdgeIndex(ctx.g)
    mm = mapmatch.match_track(ix, ctx.gc)
    xy = np.column_stack([mm["x"], mm["y"]])
    inside = areamod.inside(ctx.area, xy, ctx.g.crs)
    n = mm["n"]
    matched = mm["edge"] >= 0
    gc = ctx.gc
    q = ev.video_q(vid, "refined", 45)
    sc = ev.scorable(ctx, q)
    res = dict(video=vid, method=f"Viterbi over directed edges within {mapmatch.RADIUS:.0f} m and {mapmatch.MAX_DEG:.0f} deg of the GPS heading, samples every {mapmatch.STEP:.0f} m",
               gps_length_km=float(gc["s"][-1] / 1000), samples=n, inside_area_share=float(inside.mean()),
               inside_area_km=float(inside.sum() * mapmatch.STEP / 1000), matched_share=float(matched.mean()),
               no_candidate=int((~matched).sum()), no_candidate_inside_area=int((~matched & inside).sum()), jumps=int(mm["jumps"]),
               median_dist_to_nearest_edge_m=float(np.median(mm["dmin"][np.isfinite(mm["dmin"])])), seconds=time.time() - t0,
               video_quanta=int(len(sc)), video_quanta_in_area=int(sc.sum()),
               inside_video_time_s=[float(gc["t"][0]), float(gc["t"][-1])])
    # inside-area time ranges of the track
    ch = np.flatnonzero(np.diff(inside.astype(int)) != 0)
    res["area_transitions_at_km"] = [float(mm["s"][i] / 1000) for i in ch]
    res["matched_edges"] = int(len(np.unique(mm["edge"][matched])))
    np.savez_compressed(areamod.WORK / f"truth_{vid}.npz", s=mm["s"], t=mm["t"], x=mm["x"], y=mm["y"], edge=mm["edge"], off=mm["off"], inside=inside)
    (areamod.WORK / f"truth_{vid}.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res))
    return res


if __name__ == "__main__":
    main(sys.argv[1])
