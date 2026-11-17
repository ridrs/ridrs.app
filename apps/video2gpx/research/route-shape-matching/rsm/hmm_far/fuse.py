# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fusion smoother (rsm.fusion, variant (d), unchanged) on the far-yaw HMM route of Amalfi, with curve anchors from the far yaw; writes route_points.json and Amalfi.gpx.
The existing loaders hard-wire the vms route (rsm.refine.load._setup / RES, rsm.fusion.posterior.RES); this module swaps them in process for the far route, no file of
the existing packages is touched. python -m rsm.hmm_far.fuse"""
from __future__ import annotations

import json
import pickle
import sys
from datetime import timedelta

import numpy as np

from rsm.farrot import anchors as fan
from rsm.fusion import core, report as frep, run as frun
from rsm.hmm_cal import dp as dpm, run as crun
from rsm.refine import load
from rsm.fusion import posterior
from rsm.refine.gpx import EPOCH

from . import run as R

RES = R.RES
RES_REFINE = RES / "refine"
RES_FUSION = RES / "fusion"


def install(r: dict, st, tracks):
    """route the existing loaders to the far-yaw HMM result (name 'Amalfi' kept so that the portal truth and the tunnel producer work unchanged)"""
    RES_REFINE.mkdir(parents=True, exist_ok=True); RES_FUSION.mkdir(parents=True, exist_ok=True)
    load.RES = RES_REFINE
    posterior.RES = RES_FUSION

    def _setup(name):
        assert name == "Amalfi"
        g, E = crun.load_amalfi()
        k = r["par"].kappa
        return g, E, 30.0 * k, 10.0 * k, st, tracks, r, dpm
    load._setup = _setup


def points(vid, t_all, s, sd, conf_t, conf_p, lo, hi):
    ctx = vid.ctx
    ll = ctx.extra["g"].to_wgs84(ctx.path.xy_at(s))
    hd = ctx.path.heading_at(s)
    ok = np.isfinite(conf_p)
    conf = np.interp(t_all, conf_t[ok], conf_p[ok])
    out = []
    for t, b, h, c, sg_, ss in zip(t_all, ll, hd, conf, sd, s):
        ex = bool(t < lo or t > hi)
        out.append(dict(t=float(t), lat=round(float(b[1]), 7), lon=round(float(b[0]), 7), heading=round(float(h), 1), confidence=0.0 if ex else round(float(c), 4),
                        sd_m=round(float(sg_), 1), arc_m=round(float(ss), 1), extrapolated=ex))
    return out


def write_gpx(path_out, vid, t, s, name, desc):
    frun.write_gpx(path_out, vid, t, s, name, desc)


def main(log=print):
    r = pickle.load(open(RES / "scan_far.pkl", "rb"))
    S = R.far_series()
    st = R.far_steps(S)
    tracks = R.far_tracks(S)
    install(r, st, tracks)
    if not (RES_FUSION / "post_Amalfi.pkl").exists():
        load.post_stage("Amalfi", log=log)
        posterior.stage("Amalfi", log=log)
    vid = fan.load_video("Amalfi", None)          # ctx.tracks = far tracks of the stored (far) HMM result
    ctx = vid.ctx
    tsrc, tanc, P, ratio = frep.portal_truth(ctx)
    tp = np.array([p["t"] for p in P]); sp = np.array([p["s"] for p in P])
    log(f"portals {len(P)} ({len(tsrc.matched)} dark intervals); candidates {len(vid.cand)}", flush=True)
    V = frun.variants_at(vid, tp, with_extra=False)
    ent = np.array([p["portal"] == "entry" for p in P])
    res = {}
    for k in ("viterbi", "a_pm", "b_post", "c_ungated", "d_gated"):
        e = V[k]["s"] - sp
        stt = frep.portal_stats(e, P, ratio)
        e2 = e.copy(); e2[~ent] -= e[~ent].mean()
        stt.update(abs_mean_exit_bias_removed=float(np.abs(e2).mean()), err=e.tolist())
        res[k] = stt
        log(f"   {k:10s} abs mean {stt['abs_mean']:5.1f} med {stt['abs_median']:5.1f} max {stt['abs_max']:6.1f} signed in/out {stt['signed_entry']:+.1f}/{stt['signed_exit']:+.1f} w10/20/30 {stt['w10']:.2f}/{stt['w20']:.2f}/{stt['w30']:.2f} consistent16 {stt['consistent16_abs_mean']:.1f}", flush=True)
    gs = frep.gate_stats(V)
    log(f"   gate {gs['gate_rejected']} of {gs['candidates']} rejected {gs['gate_reasons']}, used {gs['final_gated']}", flush=True)
    # whole video, every 1 s of video time
    T = int(np.floor(S.tb[-1]))
    t_all = np.arange(0.0, T + 1.0, 1.0)
    lo, hi = float(ctx.t_step[0]), float(ctx.t_step[-1])
    fd = core.fuse(vid, V["_anchors"]["d"], t_all)
    post_ = r["post"]
    pts = points(vid, t_all, fd["s"], fd["s_sd"], post_["t"], post_["p_vit"], lo, hi)
    json.dump(dict(meta="Amalfi (motorcycle, POST HOC), dense HMM with the far-feature yaw (rsm.farrot fused far+vms heading), fusion smoother variant (d) with far-yaw curve anchors; "
                        "t = video seconds, one point per second for the whole video; lat/lon on the OSM centre line of the decoded route; heading = compass degrees clockwise from north; "
                        "confidence = forward-backward posterior of the decoded directed edge (0 and extrapolated=true outside the decoded span "
                        f"{lo:.0f}-{hi:.0f} s, where the position is clamped to the route end); sd_m = along-track sd of the smoother; arc_m = distance along the route polyline",
                   points=pts), open(RES.parent / "route_points.json", "w"))
    m = (t_all >= np.ceil(lo)) & (t_all <= hi)
    write_gpx(RES.parent / "Amalfi.gpx", vid, t_all[m], fd["s"][m], "Amalfi far-yaw HMM + fusion (d)", "dense HMM on the far-feature yaw, RTS fusion with gated far-yaw curve anchors; decoded span only.")
    # also the variant (c) and Viterbi/posterior mean for the route-difference table
    out = dict(portal=res, P=P, gate=gs, n_cand=len(vid.cand), kappa=ctx.kappa, a_ang=ctx.a_ang, span=[lo, hi], n_points=len(pts), n_extrap=int(sum(p["extrapolated"] for p in pts)),
               conf_mean_points=float(np.mean([p["confidence"] for p in pts if not p["extrapolated"]])),
               sd_m_quantiles=[float(x) for x in np.percentile(fd["s_sd"][m], [10, 50, 90, 99])])
    # fused vs Viterbi position along the route (m)
    sv = ctx.s_baseline(t_all[m])
    out["fused_minus_viterbi_m"] = dict(abs_mean=float(np.abs(fd["s"][m] - sv).mean()), p90=float(np.percentile(np.abs(fd["s"][m] - sv), 90)), max=float(np.abs(fd["s"][m] - sv).max()))
    json.dump(out, open(RES / "fuse_summary.json", "w"), indent=1, default=lambda o: float(o) if isinstance(o, (np.floating, np.integer)) else str(o))
    pickle.dump(dict(t=t_all, s=fd["s"], s_sd=fd["s_sd"], anchors=V["_anchors"]["d"]), open(RES / "fused.pkl", "wb"))
    log(f"wrote {len(pts)} points; fused vs Viterbi |ds| mean {out['fused_minus_viterbi_m']['abs_mean']:.1f} m", flush=True)


if __name__ == "__main__":
    main()
