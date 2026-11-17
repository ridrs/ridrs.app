# SPDX-License-Identifier: AGPL-3.0-or-later
"""Curve anchors + fusion with the far-feature yaw, scored against GPS (bikes, development data) or the 18 tunnel portals (Amalfi, post hoc). Existing pipeline unchanged.
python -m rsm.farrot.run gps <Grimone|Roanne|Rousset> [--nolean] | amalfi [--nolean]   (heavy: run under memguard)"""
from __future__ import annotations

import json
import pickle
import sys

import numpy as np

from rsm.fusion import core, report as frep, run as frun
from rsm.hmm import exp
from rsm.refine import evaluate, load

from . import anchors as an
from . import report as rep
from . import series

WORK = series.WORK
RES = WORK / "res"
VNAMES = ["viterbi", "a_pm", "b_post", "c_ungated", "d_gated"]


def _series(name: str, nolean: bool) -> series.Series:
    key = name.lower()
    csv = an.vms_config(name)["csv"]
    return series.build(key, csv, p=series.SeriesParams(lean=not nolean))


def gate_info(V) -> dict:
    return frep.gate_stats(V)


def gps(name: str, nolean: bool = False, log=print):
    tag = "_nolean" if nolean else ""
    S = _series(name, nolean)
    A_ = pickle.load(open(load.RES / f"analysis_{name}.pkl", "rb"))
    tt, sg, road = A_["tt"], A_["s_gps"], A_["road"]
    g, truth = exp.load(load.GPS_VIDEOS[name])
    gxy = truth.pos(tt)
    out = {}
    for lab, vid in (("vms", an.load_video(name, None)), ("far", an.load_video(name, S))):
        V = frun.variants_at(vid, tt, with_extra=False)
        res = {}
        for k in VNAMES:
            s = V[k]["s"]; err = s - sg
            d2 = np.hypot(*(vid.ctx.path.xy_at(s) - gxy).T)
            res[k] = dict(correct_road=evaluate.stats(err[road], d2[road]), err=err)
        gs = gate_info(V)
        out[lab] = dict(res=res, gate=gs, n_cand=len(vid.cand), n_acc_old=len(vid.acc), yaw_noise_median=float(np.nanmedian([f.get("yaw_noise", np.nan) for f in V["_anchors"]["feats"] if f])))
        if lab == "far":
            ctx = vid.ctx
            t = np.arange(np.ceil(ctx.t_step[0]), ctx.t_step[-1], 1.0)
            s = core.fuse(vid, V["_anchors"]["d"], t)["s"]
            frun.write_gpx(WORK / f"{name}_far_d_gated{tag}.gpx", vid, t, s, f"{name} far-feature yaw, gated", "RTS fusion, posterior + gated curve anchors from the far-feature yaw series.")
            # anchor errors against GPS (scoring only)
            def aerr(lst):
                e = []
                for a in lst:
                    i = int(np.clip(np.searchsorted(tt, a.t), 0, len(tt) - 1))
                    if road[i]:
                        e.append(a.s - sg[i])
                return np.array(e)
            ea = aerr(V["_anchors"]["d"])
            out[lab]["anchor_abs_err_median"] = float(np.median(np.abs(ea))) if len(ea) else None
            out[lab]["anchor_gt30"] = int((np.abs(ea) > 30).sum()); out[lab]["anchor_n_scored"] = int(len(ea))
        if lab == "vms":
            ea = np.array([a.s - sg[int(np.clip(np.searchsorted(tt, a.t), 0, len(tt) - 1))] for a in V["_anchors"]["d"] if road[int(np.clip(np.searchsorted(tt, a.t), 0, len(tt) - 1))]])
            out[lab]["anchor_abs_err_median"] = float(np.median(np.abs(ea))) if len(ea) else None
            out[lab]["anchor_gt30"] = int((np.abs(ea) > 30).sum()); out[lab]["anchor_n_scored"] = int(len(ea))
        log(f"== {name} {lab}: candidates {len(vid.cand)}, gate {gs['gate_rejected']} rejected, used {gs['final_gated']}", flush=True)
        for k in VNAMES:
            log(f"   {k:10s} {frep.fmt(res[k])}", flush=True)
    pickle.dump(out, open(RES / f"gps_{name}{tag}.pkl", "wb"))
    json.dump({l: {k: v for k, v in o.items() if k != "res"} | {"res": {k: {kk: vv for kk, vv in r.items() if kk != "err"} for k, r in o["res"].items()}} for l, o in out.items()},
              open(RES / f"gps_{name}{tag}.json", "w"), indent=1, default=lambda o: float(o) if isinstance(o, (np.floating, np.integer)) else str(o))


def amalfi(nolean: bool = False, log=print):
    tag = "_nolean" if nolean else ""
    S = _series("Amalfi", nolean)
    out = {}
    for lab, vid in (("vms", an.load_video("Amalfi", None)), ("far", an.load_video("Amalfi", S))):
        ctx = vid.ctx
        tsrc, tanc, P, ratio = frep.portal_truth(ctx)
        tp = np.array([p["t"] for p in P]); sp = np.array([p["s"] for p in P])
        V = frun.variants_at(vid, tp, with_extra=False)
        ent = np.array([p["portal"] == "entry" for p in P])
        res = {}
        for k in VNAMES:
            e = V[k]["s"] - sp
            st = frep.portal_stats(e, P, ratio)
            e2 = e.copy(); e2[~ent] -= e[~ent].mean()                  # POST HOC: common portal-exit bias removed (mean signed exit error)
            e3 = e - e.mean()                                          # POST HOC: one common bias removed
            st.update(abs_mean_exit_bias_removed=float(np.abs(e2).mean()), abs_median_exit_bias_removed=float(np.median(np.abs(e2))), abs_mean_common_bias_removed=float(np.abs(e3).mean()))
            res[k] = st
            log(f"   {lab} {k:10s} abs mean {st['abs_mean']:5.1f} med {st['abs_median']:5.1f} max {st['abs_max']:6.1f} signed in/out {st['signed_entry']:+.1f}/{st['signed_exit']:+.1f} w10/20/30 {st['w10']:.2f}/{st['w20']:.2f}/{st['w30']:.2f} | exit-bias removed {st['abs_mean_exit_bias_removed']:.1f}", flush=True)
        gs = gate_info(V)
        out[lab] = dict(res=res, gate=gs, n_cand=len(vid.cand), n_acc_old=len(vid.acc), err={k: (V[k]["s"] - sp).tolist() for k in VNAMES},
                        yaw_noise_quantiles=[float(x) for x in np.nanpercentile([f.get("yaw_noise", np.nan) for f in V["_anchors"]["feats"] if f], [10, 50, 90])])
        log(f"== Amalfi {lab}: candidates {len(vid.cand)}, gate rejected {gs['gate_rejected']} ({gs['gate_reasons']}), used {gs['final_gated']}; yaw noise q {out[lab]['yaw_noise_quantiles']}", flush=True)
        if lab == "far":
            t = np.arange(np.ceil(ctx.t_step[0]), ctx.t_step[-1], 1.0)
            for k, an_ in (("d_gated", V["_anchors"]["d"]), ("c_ungated", V["_anchors"]["c"])):
                s = core.fuse(vid, an_, t)["s"]
                frun.write_gpx(WORK / f"Amalfi_far_{k}{tag}.gpx", vid, t, s, f"Amalfi far {k}", "RTS fusion, posterior + curve anchors from the far-feature yaw series.")
            vp = json.load(open(load.ROOT / "work" / "amalfi_cal" / "verify_points.json"))
            ts = np.array([p_["t"] for p_ in vp], float)
            sv = core.fuse(vid, V["_anchors"]["d"], ts)["s"]
            ll = ctx.extra["g"].to_wgs84(ctx.path.xy_at(sv)); hd = ctx.path.heading_at(sv)
            pts = [dict(t=float(t_), lat=float(b[1]), lon=float(b[0]), heading=round(float(h), 1), arc_m=round(float(a), 1)) for t_, b, h, a in zip(ts, ll, hd, sv)]
            json.dump(pts, open(WORK / f"amalfi_verify_points{tag}.json", "w"), indent=1)
            old = ctx.s_baseline(ts)
            out[lab]["verify_shift_vs_viterbi"] = (sv - old).tolist()
        out[lab]["P"] = P
    pickle.dump(out, open(RES / f"amalfi{tag}.pkl", "wb"))
    json.dump({l: {k: v for k, v in o.items() if k not in ("err",)} for l, o in out.items()}, open(RES / f"amalfi{tag}.json", "w"), indent=1, default=lambda o: float(o) if isinstance(o, (np.floating, np.integer)) else str(o))


def main():
    nolean = "--nolean" in sys.argv
    if sys.argv[1] == "gps":
        gps(sys.argv[2], nolean)
    elif sys.argv[1] == "amalfi":
        amalfi(nolean)


if __name__ == "__main__":
    main()
