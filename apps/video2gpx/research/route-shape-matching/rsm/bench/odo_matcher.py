# SPDX-License-Identifier: AGPL-3.0-or-later
"""Task 5: feed COLMAP and vms-odometry paths of the same stretch to rsm.core.matcher.match.

(i)   query = COLMAP path (central 70 % of a vms piece) vs candidates [vms path of the piece + 20 % context each side, stand-ins]
(ii)  query = vms path (the same central 70 %)           vs candidates [COLMAP path of the whole model window, stand-ins]
(iii) control: a vms path of the same nominal length from elsewhere in the video (>= 120 s from the window) vs the (ii) candidates
Stand-ins: the incyclist fixture tracks of `rsm bench --standin`, the library built like the benchmark (windows 1.5 L + 100 m, stride L/2).
Status thresholds: FINDINGS dev-derived gap_ratio 3.66, max_score 0.0204 (rank_by rmse_rel). Run twice: scale prior 0.7..1.4 and wide 0.35..2.8.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from ..core.matcher import Candidate, MatchOptions, StatusThresholds, match
from ..core.trajectory import RelativeTrajectory, ScalePrior
from ..odometry import GateParams, NOMINAL, dead_reckon, integrate
from . import tracks as T
from .odo_colmap import load_route
from .odo_compare import ROUTES, MIN_PIECE_S, load_vms, pieces_for

THRESH = StatusThresholds(gap_ratio=3.66, max_score=0.0204)
MIN_PIECE_LENGTH_M = 150.0  # windows whose longest vms piece is shorter (COLMAP metres) are skipped
CENTRAL = 0.70
CONTEXT = 0.20
MIN_SEPARATION_S = 120.0
N_CONTROL = 5


def prep(xy: np.ndarray) -> np.ndarray:
    tr = RelativeTrajectory(np.asarray(xy, float)).dedup(T.DEDUP_M).smooth(T.SMOOTH_SIGMA_M).resample_by_distance(T.STEP_M)
    return np.asarray(tr.points)


def sub(t, xy, a, b):
    m = (t > a) & (t < b)
    tt = np.concatenate([[a], t[m], [b]])
    return np.column_stack([np.interp(tt, t, xy[:, 0]), np.interp(tt, t, xy[:, 1])])


def length(p):
    return float(np.hypot(*np.diff(p, axis=0).T).sum())


def vms_xy(v, seg, f, ta, tb):
    tr = integrate(v.pairs, seg, v.flags, f)
    a, b = max(ta, tr.t[0]), min(tb, tr.t[-1])
    m = (tr.t > a) & (tr.t < b)
    t = np.concatenate([[a], tr.t[m], [b]])
    th, s = np.interp(t, tr.t, tr.theta), np.interp(t, tr.t, tr.s)
    x, y = dead_reckon(th - th[0], s - s[0])
    return np.column_stack([x, y])


def run_match(query_xy, cands, lib, prior, ids_true):
    q = RelativeTrajectory(prep(query_xy), scale=ScalePrior(known=False, min=prior[0], max=prior[1]))
    res = match(q, cands + lib, MatchOptions(rank_by="rmse_rel", thresholds=THRESH))
    rec = {"query_length_m": q.length, "status": res.ambiguity.status, "best_id": res.ambiguity.best_id, "best_score": res.ambiguity.best_score,
           "second_id": res.ambiguity.second_id, "gap_ratio": res.ambiguity.gap_ratio, "n_candidates": len(cands) + len(lib),
           "best_scale": res.distinct[0].scale, "best_scale_clamped": res.distinct[0].scale_clamped, "reason": res.ambiguity.reason, "true": {}}
    for tid in ids_true:
        e = [d for d in res.distinct if d.origin_id == tid]
        if e:
            e = e[0]
            rec["true"][tid] = {"rank": e.rank, "score": e.score, "scale": e.scale, "scale_clamped": e.scale_clamped,
                                "window_m": [e.window_start_m, e.window_start_m + e.window_length_m]}
        else:
            rec["true"][tid] = {"rank": None}
    return rec


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", required=True)
    ap.add_argument("--colmap", required=True)
    ap.add_argument("--vms", required=True)
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args(argv)
    gate = GateParams(exclude_before_s=20.0)
    vms = {vid: load_vms(Path(args.vms) / f"{vid}.csv", vid, gate) for vid in ("gotthard", "cayolle")}
    stand = T.available_tracks(standin=True)
    wins = []
    for r in ROUTES:
        wins += load_route(Path(args.routes) / r, Path(args.colmap) / f"{r}.models.json", 60)
    out = []
    for w in wins:
        vid = "gotthard" if w.route.startswith("gotthard") else "cayolle"
        v, f = vms[vid], NOMINAL[vid].f360
        pcs = pieces_for(w, v, f)
        best = None
        for pc in pcs:
            cl = float(np.interp(pc.tb, w.t, w.s) - np.interp(pc.ta, w.t, w.s))
            if cl >= MIN_PIECE_LENGTH_M and (best is None or cl > best[1]):
                best = (pc, cl)
        if best is None:
            out.append({"window": w.name, "skipped": f"no vms piece of at least {MIN_PIECE_LENGTH_M:.0f} m (COLMAP metres)"})
            continue
        pc, cl = best
        seg = v.segs[pc.seg_id]
        d = pc.tb - pc.ta
        qa, qb = pc.ta + d * (1 - CENTRAL) / 2, pc.tb - d * (1 - CENTRAL) / 2
        ca, cb = max(seg.t0, pc.ta - CONTEXT * d), min(seg.t1, pc.tb + CONTEXT * d)
        wxy = w.xy
        col_q = prep(sub(w.t, wxy, qa, qb))
        vms_q = prep(vms_xy(v, seg, f, qa, qb))
        vms_c = prep(vms_xy(v, seg, f, ca, cb))
        col_c = prep(wxy)
        Lq = length(col_q)
        lib_i = T.build_library(stand, max(Lq, 100.0))
        # control windows: same nominal length as vms_q from elsewhere
        nomlen = length(vms_q)
        ctrl = []
        far = [s for s in v.usable if (s.t1 < w.t[0] - MIN_SEPARATION_S or s.t0 > w.t[-1] + MIN_SEPARATION_S)]
        long = []
        for s in far:
            tr = integrate(v.pairs, s, v.flags, f)
            if tr.s[-1] >= nomlen * 1.05:
                long.append((s, tr))
        pick = [long[i] for i in np.unique(np.linspace(0, len(long) - 1, min(N_CONTROL, len(long))).round().astype(int))] if long else []
        for s, tr in pick:
            mid = np.interp(tr.s[-1] / 2, tr.s, tr.t)
            t_lo = np.interp(max(tr.s[-1] / 2 - nomlen / 2, 0), tr.s, tr.t)
            t_hi = np.interp(min(tr.s[-1] / 2 + nomlen / 2, tr.s[-1]), tr.s, tr.t)
            ctrl.append((s, t_lo, t_hi))
        rec = {"window": w.name, "video": vid, "piece": [pc.ta, pc.tb], "colmap_piece_length_m": cl, "query_t": [qa, qb], "vms_nominal_over_colmap_length": float(pc.s[-1] / cl),
               "query_colmap_length_m": Lq, "query_vms_length_m": nomlen, "runs": {}}
        for pname, prior in (("prior_0.7_1.4", (0.7, 1.4)), ("prior_0.35_2.8", (0.35, 2.8))):
            ri = run_match(col_q, [Candidate("vms_segment", vms_c, origin_id="vms_segment")], lib_i, prior, ["vms_segment"])
            rii = run_match(vms_q, [Candidate("colmap_window", col_c, origin_id="colmap_window")], lib_i, prior, ["colmap_window"])
            riii = []
            for s, ta, tb in ctrl:
                xy = vms_xy(v, s, f, ta, tb)
                r = run_match(xy, [Candidate("colmap_window", col_c, origin_id="colmap_window")], lib_i, prior, ["colmap_window"])
                r["control_t"] = [float(ta), float(tb)]
                riii.append(r)
            rec["runs"][pname] = {"i_colmap_query_vs_vms": ri, "ii_vms_query_vs_colmap": rii, "iii_control": riii}
        out.append(rec)
        print(w.name, "done", flush=True)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"thresholds": {"gap_ratio": THRESH.gap_ratio, "max_score": THRESH.max_score}, "rank_by": "rmse_rel",
                                          "min_piece_length_m": MIN_PIECE_LENGTH_M, "central": CENTRAL, "context": CONTEXT, "windows": out}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
