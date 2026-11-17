# SPDX-License-Identifier: AGPL-3.0-or-later
"""Anchors -> merge -> segment correction -> scoring, for the three GPS videos and for Amalfi (tunnel portals as truth, then as anchors with leave-one-out).
python -m rsm.refine.analyse gps <Grimone|Roanne|Rousset|all> | amalfi"""
from __future__ import annotations

import json
import pickle
import sys

import numpy as np
from scipy.ndimage import gaussian_filter1d

from rsm.hmm import exp
from rsm.odometry.turns import TurnParams, detect_turns

from . import anchors as A
from . import curves, evaluate, load, segment, tunnels

RES = load.RES


LOCAL_TOL = 0.35   # relative; None = off


def run_curves(ctx, params=None, local_tol=LOCAL_TOL):
    src = curves.CurveAnchors(params)
    cand = src.anchors(ctx)
    acc, rej = A.merge(cand, ctx.D, ctx.gapfrac, ctx.kappa, local_tol=local_tol)
    return src, cand, acc, rej


def map_turns(ctx):
    ph = gaussian_filter1d(ctx.path.phi, 6.0, mode="nearest")
    return detect_turns(ctx.path.sg, ph, None, TurnParams(min_angle_deg=25.0))


def turn_index(mt, s: float, reach: float = 60.0) -> int:
    for i, t in enumerate(mt):
        if t.s_start - 5 <= s <= t.s_end + 5:
            return i
    c = np.array([0.5 * (t.s_start + t.s_end) for t in mt])
    if len(c) == 0:
        return -1
    i = int(np.argmin(np.abs(c - s)))
    return i if abs(c[i] - s) <= reach else -1


def assignment_report(ctx, src, acc) -> dict:
    """did the refinement change which MAP turn a video turn is assigned to? baseline = map turn at the Viterbi arc of the video turn's apex time"""
    mt = map_turns(ctx)
    rows = [d for d in src.last if d.get("accepted") or "delta" in d]
    kept = {round(a.t, 3) for a in acc}
    ch = same = none = 0
    shifts = []
    for d in rows:
        if round(d["t"], 3) not in kept:
            continue
        i0, i1 = turn_index(mt, d["s_h"]), turn_index(mt, d["s_h"] + d["delta"])
        shifts.append(d["delta"])
        if i0 < 0 and i1 < 0:
            none += 1
        elif i0 == i1:
            same += 1
        else:
            ch += 1
    sh = np.abs(np.array(shifts)) if shifts else np.zeros(0)
    return dict(n_map_turns=len(mt), n_anchors=len(shifts), same_turn=same, changed_turn=ch, no_map_turn=none,
                abs_shift_median=float(np.median(sh)) if len(sh) else None, abs_shift_p90=float(np.percentile(sh, 90)) if len(sh) else None, shift_gt15=int((sh > 15).sum()), shift_gt50=int((sh > 50).sum()))


def curve_summary(src, cand, acc, rej) -> dict:
    why = {}
    for d in src.last:
        k = "accepted by the detector" if d.get("accepted") else d.get("why", "?")
        why[k] = why.get(k, 0) + 1
    rr = {}
    for r in rej:
        rr[r["reason"]] = rr.get(r["reason"], 0) + 1
    m = [d["margin"] for d in src.last if "margin" in d and np.isfinite(d.get("margin", np.nan))]
    return dict(n_video_turns=len(src.last), detector=why, n_candidates=len(cand), n_accepted=len(acc), merge_rejected=rr,
                margin_quantiles=[float(x) for x in np.percentile(m, [10, 25, 50, 75, 90])] if m else None)


def seg_table(segs) -> dict:
    k = np.array([s.k for s in segs]); ku = np.array([s.k_used for s in segs]); L = np.array([s.L_map for s in segs])
    fl = [s.flag for s in segs]
    ok = np.isfinite(k)
    q = lambda x: [float(v) for v in np.percentile(x, [5, 25, 50, 75, 95])] if len(x) else None
    return dict(n=len(segs), flags={f: fl.count(f) for f in set(fl)}, k_quantiles_5_25_50_75_95=q(k[ok]), k_used_quantiles=q(ku), k_mean=float(k[ok].mean()) if ok.any() else None,
                k_sd=float(k[ok].std()) if ok.any() else None, L_map_median=float(np.median(L)) if len(L) else None, L_map_total=float(L.sum()))


def analyse_gps(name: str, log=print, params=None, tag: str = "") -> dict:
    video = load.GPS_VIDEOS[name]
    ctx = load.build_ctx(name)
    g, truth = exp.load(video)
    src, cand, acc, rej = run_curves(ctx, params)
    kg = ctx.kappa
    smax = ctx.path.sg[-1]
    tt = np.arange(np.ceil(max(ctx.t_step[0], truth.t0)), min(ctx.t_step[-1], truth.t1), 1.0)
    s_vit = ctx.s_baseline(tt)
    gxy = truth.pos(tt)
    s_gps, cross = evaluate.project_dp(ctx.path, gxy, s_vit)
    road = evaluate.on_correct_road(ctx, truth, tt) & (cross <= 50.0)
    pos = {"viterbi": s_vit}
    if ctx.s_pm is not None:
        pos["posterior_mean"] = ctx.s_baseline(tt, "pm")
    pos["step2"] = segment.position_global(tt, acc, ctx.D, kg, smax)
    s23, segs = segment.position(tt, acc, ctx.D, ctx.gapfrac, kg, smax)
    pos["step2+3"] = s23
    # curve anchors without the merge (all detector-accepted) for the k_i of the raw consecutive pairs
    raw_sorted = sorted(cand, key=lambda a: a.t)
    raw_segs = segment.segments(raw_sorted, ctx.D, ctx.gapfrac, kg)
    dist = evaluate.nearest_anchor_distance(s23, acc)
    out = dict(name=name, tt=tt, s_gps=s_gps, cross=cross, road=road, pos=pos, dist=dist, kappa=kg, anchors=acc, segs=segs, raw_segs=raw_segs, cand=cand, rej=rej, src_last=src.last,
               s_vit_step=ctx.s_vit, t_step=ctx.t_step)
    res = {}
    for nm, s in pos.items():
        err = s - s_gps
        d2 = np.hypot(*(ctx.path.xy_at(s) - gxy).T)
        m = road
        res[nm] = dict(correct_road=evaluate.stats(err[m], d2[m]), wrong_road=evaluate.stats(err[~m], d2[~m]) if (~m).any() else dict(n=0),
                       by_anchor_dist=evaluate.by_anchor_distance(err[m], dist[m]))
        out.setdefault("err", {})[nm] = err; out.setdefault("d2", {})[nm] = d2
    out["metrics"] = res
    sc = evaluate.signed_cross(ctx.path, s_gps, gxy)
    out["signed_cross"] = sc
    def cs(m):
        x = sc[m]
        return dict(n=int(m.sum()), abs_mean=float(np.abs(x).mean()), abs_median=float(np.median(np.abs(x))), abs_p90=float(np.percentile(np.abs(x), 90)), signed_mean=float(x.mean()), signed_median=float(np.median(x)),
                    share_right=float((x < 0).mean()))
    # curvature of the path at the GPS position: straight (|turn| < 0.2 deg/m over +-15 m) against curve
    ph = gaussian_filter1d(ctx.path.phi, 6.0, mode="nearest")
    kap = np.abs(np.gradient(ph))                       # rad / m on the 1 m grid
    kk = np.interp(s_gps, ctx.path.sg, gaussian_filter1d(kap, 15.0))
    straight = np.degrees(kk) < 0.2
    out["cross_stats"] = dict(all=cs(road), straight=cs(road & straight), curve=cs(road & ~straight))
    if "--no-gpx" not in sys.argv and not tag:
        from . import gpx
        gpx.write_gpx(load.WORK / f"{name}.gpx", ctx, acc, f"{name} (steps 2+3)")
    out["curve_summary"] = curve_summary(src, cand, acc, rej)
    out["assignment"] = assignment_report(ctx, src, acc)
    out["k_table"] = seg_table(segs)
    out["k_table_raw"] = seg_table(raw_segs)
    out["n_times"] = dict(total=int(len(tt)), correct_road=int(road.sum()))
    out["path_arc_over_nominal"] = float((ctx.s_vit[-1] - ctx.s_vit[0]) / (ctx.D(ctx.t_step[-1]) - ctx.D(ctx.t_step[0])))
    pickle.dump(out, open(RES / f"analysis_{name}{tag}.pkl", "wb"))
    log(f"{name}: anchors {len(acc)} (cand {len(cand)}), segments {len(segs)}, correct-road samples {int(road.sum())}/{len(tt)}", flush=True)
    for nm in pos:
        r = res[nm]["correct_road"]
        log(f"   {nm:15s} abs mean {r['abs_mean']:.1f} median {r['abs_median']:.1f} signed {r['signed_mean']:+.1f} | within 10/20/30 {r['w10']:.3f}/{r['w20']:.3f}/{r['w30']:.3f}", flush=True)
    return out


def main():
    if sys.argv[1] == "gps":
        for n in (load.GPS_VIDEOS if sys.argv[2] == "all" else [sys.argv[2]]):
            if "--min-angle" in sys.argv:   # sensitivity run
                a = float(sys.argv[sys.argv.index("--min-angle") + 1])
                analyse_gps(n, params=curves.CurveParams(min_angle_deg=a), tag=f"_ang{int(a)}")
            else:
                analyse_gps(n)
    elif sys.argv[1] == "amalfi":
        from . import amalfi
        amalfi.main()


if __name__ == "__main__":
    main()
