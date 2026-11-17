# SPDX-License-Identifier: AGPL-3.0-or-later
"""Amalfi (no GPS, post hoc). Phase 1: the 9 tunnels are TRUTH (portal arcs from OSM tunnel=yes edges on the route, portal times from the luminance) and the curve
refinement never sees them. Phase 2 (labelled separately): the portals are anchors too; evaluated leave-one-out (both portals of one tunnel are removed, the other 8
tunnels and the curves anchor, the 2 portals of the left-out tunnel are measured)."""
from __future__ import annotations

import json
import pickle

import numpy as np

from . import anchors as A
from . import load, segment, tunnels
from .analyse import LOCAL_TOL, RES, run_curves, seg_table, assignment_report, curve_summary


def positions(t, anchors, ctx, smax):
    s, segs = segment.position(t, anchors, ctx.D, ctx.gapfrac, ctx.kappa, smax)
    return s, segs


def points_json(ctx, anchors, ts, path_out):
    s, _ = positions(np.asarray(ts, float), anchors, ctx, ctx.path.sg[-1])
    ll = ctx.extra["g"].to_wgs84(ctx.path.xy_at(s))
    hd = ctx.path.heading_at(s)
    out = [dict(t=float(t), lat=float(b[1]), lon=float(b[0]), heading=round(float(h), 1), arc_m=round(float(a), 1)) for t, b, h, a in zip(ts, ll, hd, s)]
    json.dump(out, open(path_out, "w"), indent=1)
    return out


def main(log=print):
    ctx = load.build_ctx("Amalfi")
    smax = ctx.path.sg[-1]
    kg = ctx.kappa
    tsrc = tunnels.TunnelAnchors()
    tanc = tsrc.anchors(ctx)
    rows = [r for r in tsrc.matched if r.get("run") is not None]
    log(f"tunnel intervals {len(tsrc.matched)}, matched to an OSM tunnel run of the route {len(rows)}; path tunnel runs {len(ctx.path.tunnel_runs())}", flush=True)
    src, cand, acc, rej = run_curves(ctx)
    log(f"curve anchors: candidates {len(cand)}, accepted {len(acc)}", flush=True)
    # truth table: 18 portals
    P = []
    for i, r in enumerate(tsrc.matched):
        if r.get("run") is None:
            continue
        P.append(dict(tunnel=i, portal="entry", t=r["t_entry"], s=r["s_entry"])); P.append(dict(tunnel=i, portal="exit", t=r["t_exit"], s=r["s_exit"]))
    tp = np.array([p["t"] for p in P]); sp = np.array([p["s"] for p in P])
    variants = {"viterbi": ctx.s_baseline(tp)}
    if ctx.s_pm is not None:
        variants["posterior_mean"] = ctx.s_baseline(tp, "pm")
    variants["step2"] = segment.position_global(tp, acc, ctx.D, kg, smax)
    s23, segs = positions(tp, acc, ctx, smax)
    variants["step2+3"] = s23
    # phase 2: leave-one-out
    loo = {"tunnels_only_LOO": np.full(len(P), np.nan), "curves+tunnels_LOO": np.full(len(P), np.nan)}
    loo_info = []
    for i in sorted({p["tunnel"] for p in P}):
        keep = [a for a in tanc if a.meta["tunnel"] != i]
        idx = [k for k, p in enumerate(P) if p["tunnel"] == i]
        for nm, base in (("tunnels_only_LOO", keep), ("curves+tunnels_LOO", cand + keep)):
            a2, rj = A.merge(base, ctx.D, ctx.gapfrac, kg, local_tol=LOCAL_TOL)
            s, _ = positions(tp[idx], a2, ctx, smax)
            for k, v in zip(idx, s):
                loo[nm][k] = v
            loo_info.append(dict(left_out=i, set=nm, n_anchors=len(a2), rejected=[(r["anchor"].kind, round(r["anchor"].t, 1), r["reason"]) for r in rj if r["anchor"].kind == "tunnel_portal"]))
    variants.update(loo)
    # all tunnels in (not independent): consistency of the portals with the curves
    a_all, rj_all = A.merge(cand + tanc, ctx.D, ctx.gapfrac, kg, local_tol=LOCAL_TOL)
    s_all, segs_all = positions(tp, a_all, ctx, smax)
    err = {k: v - sp for k, v in variants.items()}
    tun_ratio = {i: r.get('len_ratio') for i, r in enumerate(tsrc.matched)}
    summ = {}
    for k, e in err.items():
        a = np.abs(e)
        inner = np.array([1 <= p["tunnel"] <= 7 for p in P])
        cons = np.array([0.4 <= (tun_ratio.get(p['tunnel']) or 1.0) <= 2.5 for p in P])
        summ[k] = dict(consistent_abs_mean=float(np.nanmean(a[cons])), consistent_abs_median=float(np.nanmedian(a[cons])), n_consistent=int(cons.sum()), interior_abs_mean=float(np.nanmean(a[inner])), interior_abs_median=float(np.nanmedian(a[inner])), n=int(len(e)), abs_mean=float(np.nanmean(a)), abs_median=float(np.nanmedian(a)), abs_max=float(np.nanmax(a)), signed_mean=float(np.nanmean(e)),
                       w10=float(np.nanmean(a <= 10)), w20=float(np.nanmean(a <= 20)), w30=float(np.nanmean(a <= 30)),
                       entry_signed=float(np.nanmean(e[[p["portal"] == "entry" for p in P]])), exit_signed=float(np.nanmean(e[[p["portal"] == "exit" for p in P]])))
    tun_rows = [dict(tunnel=i, t_entry=r["t_entry"], t_exit=r["t_exit"], dark=(r["dark_t0"], r["dark_t1"]), len_osm=r["len_osm"], len_ratio=r.get("len_ratio"), s_entry=r["s_entry"], s_exit=r["s_exit"]) for i, r in enumerate(tsrc.matched) if r.get("run") is not None]
    out = dict(P=P, err=err, summary=summ, tunnels=tun_rows, unmatched=[i for i, r in enumerate(tsrc.matched) if r.get("run") is None], loo_info=loo_info, n_curve_cand=len(cand), n_curve_acc=len(acc),
               all_in=dict(n_anchors=len(a_all), tunnel_rejected=[(r["anchor"].kind, round(r["anchor"].t, 1), r["reason"]) for r in rj_all if r["anchor"].kind == "tunnel_portal"],
                           err_at_portals=(s_all - sp).tolist()), curve_summary=curve_summary(src, cand, acc, rej), assignment=assignment_report(ctx, src, acc), k_table=seg_table(segment.segments(acc, ctx.D, ctx.gapfrac, kg)),
               k_table_all_in=seg_table(segs_all), path_km=ctx.path.length / 1000, arc_over_nominal=float((ctx.s_vit[-1] - ctx.s_vit[0]) / (ctx.D(ctx.t_step[-1]) - ctx.D(ctx.t_step[0]))))
    # difference of the variants over the whole video (no truth): mean |s_step23 - s_vit|
    tg = np.arange(np.ceil(ctx.t_step[0]), ctx.t_step[-1], 1.0)
    sv = ctx.s_baseline(tg); s2, _ = positions(tg, acc, ctx, smax)
    out["whole_video_abs_diff_step23_vs_viterbi"] = dict(mean=float(np.abs(s2 - sv).mean()), p90=float(np.percentile(np.abs(s2 - sv), 90)), max=float(np.abs(s2 - sv).max()))
    # verify points
    vp = json.load(open(load.ROOT / "work" / "amalfi_cal" / "verify_points.json"))
    ts = [p["t"] for p in vp]
    points_json(ctx, acc, ts, load.WORK / "amalfi_verify_points.json")
    points_json(ctx, a_all, ts, load.WORK / "amalfi_verify_points_with_tunnels.json")
    from . import gpx
    gpx.write_gpx(load.WORK / "Amalfi.gpx", ctx, acc, "Amalfi (steps 2+3, curves only)")
    gpx.write_gpx(load.WORK / "Amalfi_with_tunnels.gpx", ctx, a_all, "Amalfi (curves + tunnel portals; portals not independent)")
    out["verify_shift_m"] = dict(step23_vs_old_viterbi=[float(x) for x in (positions(np.array(ts), acc, ctx, smax)[0] - ctx.s_baseline(np.array(ts)))])
    pickle.dump(dict(out=out, acc=acc, tanc=tanc, cand=cand, a_all=a_all), open(RES / "analysis_Amalfi.pkl", "wb"))
    json.dump(out, open(RES / "amalfi_summary.json", "w"), indent=1, default=lambda o: float(o) if isinstance(o, (np.floating, np.integer)) else str(o))
    for k, s in summ.items():
        log(f"{k:20s} n {s['n']} |err| mean {s['abs_mean']:.1f} median {s['abs_median']:.1f} max {s['abs_max']:.1f} signed {s['signed_mean']:+.1f} (entry {s['entry_signed']:+.1f}, exit {s['exit_signed']:+.1f}) within 10/20/30 {s['w10']:.2f}/{s['w20']:.2f}/{s['w30']:.2f}", flush=True)
    return out
