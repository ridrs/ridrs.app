# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY scoring of a finished pipeline run (imports research modules, needs GPS / evidence files). Not part of the packaged pipeline.
    python -m rsm.pipeline.validate roanne DIR      GPS scoring (GPS is used for scoring only)
from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path

import numpy as np

from rsm.network.graph import NetGraph

from . import config as C
from .common import jload


class PathView:
    def __init__(self, sg, xy):
        self.sg, self.xy = sg, xy

    def xy_at(self, s):
        s = np.clip(np.asarray(s, float), 0, self.sg[-1])
        return np.column_stack([np.interp(s, self.sg, self.xy[:, 0]), np.interp(s, self.sg, self.xy[:, 1])])


def _load(d: Path):
    R = np.load(d / "refine" / "result.npz")
    rp = jload(d / "route_points.json")["points"]
    return R, rp, PathView(R["sg"], R["xy"]), str(R["crs"])


def roanne(d: Path, video="vallee-de-roanne") -> dict:
    from rsm.quanta import gps
    from rsm.refine import evaluate
    R, rp, path, crs = _load(d)
    gc = gps.gps_curve(video, crs)
    ext = R["extrap"]
    t_all = R["t"]
    lo, hi = t_all[~ext][0], t_all[~ext][-1]
    sel = (t_all >= max(lo, gc["t"][0])) & (t_all <= min(hi, gc["t"][-1])) & ~ext
    tt, s = t_all[sel], R["s"][sel]
    gxy = gps.pos_at(gc, tt)
    s_gps, cross = evaluate.project_dp(path, gxy, s)
    mine = path.xy_at(s)
    d_pos = np.hypot(*(mine - gxy).T)
    road = (cross <= 20.0) & (np.abs(s_gps - s) <= 300.0)
    err = s - s_gps
    out = dict(n_scored=int(len(tt)), correct_road_share=float(road.mean()), along_track_correct_road=evaluate.stats(err[road], d_pos[road]), within_30m_all=float((d_pos <= 30).mean()))
    sc = evaluate.signed_cross(path, s_gps, gxy)                                        # GPS offset from the centre line, + = left of travel
    off = np.array([p["offset_m"] for p in rp])[sel]                                    # applied driving-line offset, + = right
    before, after = np.abs(sc[road]), np.abs(sc[road] + off[road])
    q = lambda x: dict(median=float(np.median(x)), p90=float(np.percentile(x, 90)), mean=float(x.mean()))
    out["cross_track_centre_line"] = q(before)
    out["cross_track_driving_line"] = q(after)
    out["gps_right_of_centre_share"] = float((sc[road] < 0).mean())
    out["gps_signed_median_left_positive"] = float(np.median(sc[road]))
    # distance of the written GPX points to the GPS (2-D, includes both along and cross)
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, crs, always_xy=True)
    P = {int(p["t"]): p for p in rp}
    ll = np.array([[P[int(t)]["lon"], P[int(t)]["lat"]] for t in tt])
    x, y = tr.transform(ll[:, 0], ll[:, 1])
    d2 = np.hypot(x - gxy[:, 0], y - gxy[:, 1])
    out["gpx_point_to_gps_distance_correct_road"] = dict(median=float(np.median(d2[road])), p90=float(np.percentile(d2[road], 90)), w10=float((d2[road] <= 10).mean()), w20=float((d2[road] <= 20).mean()), w30=float((d2[road] <= 30).mean()))
    return out

if __name__ == "__main__":
    d = Path(sys.argv[2])
    r = {"roanne": roanne}[sys.argv[1]](d)
    (d / "validation.json").write_text(json.dumps(r, indent=1, default=float))
    print(json.dumps(r, indent=1, default=float))
