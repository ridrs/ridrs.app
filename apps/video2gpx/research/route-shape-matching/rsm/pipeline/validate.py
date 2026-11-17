# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEVELOPMENT-ONLY scoring of a finished pipeline run (imports research modules, needs GPS / evidence files). Not part of the packaged pipeline.
    python -m rsm.pipeline.validate roanne DIR      GPS scoring (GPS is used for scoring only)
    python -m rsm.pipeline.validate amalfi DIR      decoy verdict, Vietri / ERCHIE sign distances, tunnel hits, runtimes"""
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


def amalfi(d: Path) -> dict:
    from rsm.hmm_cal import area as carea
    from rsm.nogps import verify
    R, rp, path, crs = _load(d)
    g = NetGraph.load(d / "map" / "graph_real.npz")
    E = np.load(d / "map" / "edges_real.npy")
    import types

    class Rt:
        pass
    rt = Rt()
    ext = R["extrap"]
    tun = np.asarray(R["tunnel"], bool)
    ts = R["t"][~ext]
    rt.t = np.asarray(ts, float)
    rt.E = tun[np.minimum(R["s"][~ext].astype(int), len(tun) - 1)].astype(int)       # fake edge ids: 1 = tunnel (the per-second FUSED position is checked)
    gtun = types.SimpleNamespace(edge_tunnel=np.array([False, True]))
    rt.gap_edges = []
    rt.inc = np.zeros(len(rt.t))
    rt.xy = path.xy_at(R["s"])[~ext]
    ts = R["t"][~ext]
    root = Path(__file__).resolve().parents[2]
    ev = json.loads((root / "work" / "amalfi" / "evidence.json").read_text())
    ivs = [x for x in ev["dark_intervals"] if x.get("tunnel_by_eye")]
    T = int(R["t"][-1])
    tc = verify.tunnel_check(rt, gtun, ivs, T=T)
    places = json.loads((root / "work" / "amalfi_cal" / "cache" / "places.json").read_text())
    rt2 = Rt(); rt2.t = ts; rt2.xy = rt.xy
    v = verify.place_check(rt2, g, places, "Vietri", 30.0)
    e = verify.place_check(rt2, g, places, "Erchie", 790.0)
    out = dict(tunnels=dict(n=tc["n"], hits=tc["hits"], tunnel_share_of_route_time=tc["tunnel_share_of_route_time"], shifted_p95=tc["shifted_hits_p95"], shifted_mean=tc["shifted_hits_mean"], p_shift=tc["p_shift"]),
               vietri_window_m=min([x["dist_m"] for x in v["named"]] or [np.nan]), erchie_window_m=min([x["dist_m"] for x in e["named"]] or [np.nan]),
               vietri_nearest_at_30s=v["nearest_places_at_t"][:2], erchie_nearest_at_790s=e["nearest_places_at_t"][:2])
    return out


if __name__ == "__main__":
    d = Path(sys.argv[2])
    r = {"roanne": roanne, "amalfi": amalfi}[sys.argv[1]](d)
    (d / "validation.json").write_text(json.dumps(r, indent=1, default=float))
    print(json.dumps(r, indent=1, default=float))
