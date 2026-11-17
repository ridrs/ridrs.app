# SPDX-License-Identifier: AGPL-3.0-or-later
"""Variants (a)-(e), scoring, robustness test, GPX and Amalfi outputs. GPS is scoring only. Development data (bikes) and post hoc data (Amalfi).
python -m rsm.fusion.run gps | amalfi | robust | tune"""
from __future__ import annotations

import json
import pickle
import sys
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import numpy as np

from rsm.hmm import exp
from rsm.refine import analyse, evaluate, load, segment, tunnels
from rsm.refine import anchors as A
from rsm.refine.gpx import EPOCH

from . import core, gate, posterior, rts

WORK = posterior.WORK
RES = posterior.RES
BIKES = list(load.GPS_VIDEOS)
VARIANTS = ["a_pm", "b_post", "c_ungated", "d_gated"]


def write_gpx(path_out, v: core.Video, t: np.ndarray, s: np.ndarray, name: str, desc: str):
    ctx = v.ctx
    ll = ctx.extra["g"].to_wgs84(ctx.path.xy_at(s))
    rows = [f'<trkpt lat="{b:.7f}" lon="{a:.7f}"><time>{(EPOCH + timedelta(seconds=float(x))).strftime("%Y-%m-%dT%H:%M:%SZ")}</time></trkpt>' for x, (a, b) in zip(t, ll)]
    open(path_out, "w").write('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="rsm.fusion" xmlns="http://www.topografix.com/GPX/1/1">\n'
                              f'<metadata><desc>{name}: {desc} Position on the OSM centre line. time = 2000-01-01T00:00:00Z + video seconds. Map data (c) OpenStreetMap contributors, ODbL.</desc></metadata>\n'
                              f'<trk><name>{name}</name><trkseg>\n' + "\n".join(rows) + "\n</trkseg></trk></gpx>\n")


def variants_at(v: core.Video, t: np.ndarray, fp=None, pp=None, gp=None, extra_anchors: list | None = None, with_extra=True) -> dict:
    """positions (and fusion outputs) of every variant at times t"""
    ctx = v.ctx
    out = {}
    out["a_pm"] = dict(s=ctx.s_baseline(t, "pm"))
    out["viterbi"] = dict(s=ctx.s_baseline(t))
    out["b_post"] = core.fuse(v, [], t, fp, pp)
    ac, _, rm_c, _ = core.pipeline_anchors(v, v.cand, False)
    ad, rg_d, rm_d, feats = core.pipeline_anchors(v, v.cand, True, gp)
    out["c_ungated"] = core.fuse(v, ac, t, fp, pp)
    out["d_gated"] = core.fuse(v, ad, t, fp, pp)
    out["old_segment"] = dict(s=core.old_method(v, v.acc, t))
    if with_extra:
        out["c0_ungated_nomerge"] = core.fuse(v, sorted(v.cand, key=lambda a: a.t), t, fp, pp)
        ad0, _, _, _ = core.pipeline_anchors(v, v.cand, True, gp, merged=False)
        out["d0_gated_nomerge"] = core.fuse(v, ad0, t, fp, pp)
    out["_anchors"] = dict(c=ac, d=ad, gate_rej=rg_d, merge_rej_c=rm_c, merge_rej_d=rm_d, feats=feats)
    return out


def score_gps(name: str, fp=None, pp=None, gp=None, with_extra=True) -> dict:
    v = core.load_video(name)
    A_ = pickle.load(open(load.RES / f"analysis_{name}.pkl", "rb"))
    tt, sg, road, cross = A_["tt"], A_["s_gps"], A_["road"], A_["cross"]
    g, truth = exp.load(load.GPS_VIDEOS[name])
    gxy = truth.pos(tt)
    V = variants_at(v, tt, fp, pp, gp, with_extra=with_extra)
    dist = evaluate.nearest_anchor_distance(V["old_segment"]["s"], v.acc)   # distance to the nearest merged ungated curve anchor (as in work/refine)
    res = {}
    for k, o in V.items():
        if k.startswith("_"):
            continue
        s = o["s"]
        err = s - sg
        d2 = np.hypot(*(v.ctx.path.xy_at(s) - gxy).T)
        res[k] = dict(correct_road=evaluate.stats(err[road], d2[road]), by_anchor_dist=evaluate.by_anchor_distance(err[road], dist[road]), err=err)
    return dict(v=v, tt=tt, s_gps=sg, road=road, cross=cross, V=V, res=res, dist=dist, gxy=gxy, cross_stats=A_["cross_stats"], truth_old=A_)


def tune(log=print):
    """small grid on the bike videos for the fusion parameters (infl, q_rho); variant d scored on the mean of the three abs-mean errors. Amalfi is not used."""
    vids = {n: core.load_video(n) for n in BIKES}
    sc = {n: pickle.load(open(load.RES / f"analysis_{n}.pkl", "rb")) for n in BIKES}
    rows = []
    for infl in (1.0, 2.0, 3.0, 5.0):
        for q_rho in (1e-3, 2.5e-3, 5e-3, 1e-2):
            m = []
            for n in BIKES:
                v, A_ = vids[n], sc[n]
                ad, _, _, _ = core.pipeline_anchors(v, v.cand, True)
                o = core.fuse(v, ad, A_["tt"], rts.FuseParams(q_rho=q_rho), core.PostParams(infl=infl))
                m.append(float(np.abs(o["s"] - A_["s_gps"])[A_["road"]].mean()))
            rows.append(dict(infl=infl, q_rho=q_rho, abs_mean=m, mean=float(np.mean(m))))
            log(f"infl {infl} q_rho {q_rho:g}: {np.round(m, 2)} mean {np.mean(m):.3f}", flush=True)
    json.dump(rows, open(RES / "tune.json", "w"), indent=1)


def main():
    cmd = sys.argv[1]
    RES.mkdir(parents=True, exist_ok=True)
    if cmd == "tune":
        tune()
    elif cmd == "gps":
        from . import report
        report.gps_all()
    elif cmd == "amalfi":
        from . import report
        report.amalfi()
    elif cmd == "robust":
        from . import report
        report.robust()


if __name__ == "__main__":
    main()
