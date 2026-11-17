# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tables and figures for work/fable3/RESULTS.md from the pickles in work/fable3/res. python -m rsm.hmm.report <tag>   (tag: b0.0 | bself)"""
from __future__ import annotations

import json
import pickle
import sys

import numpy as np
from scipy.stats import rankdata

from rsm.quanta import gps

from . import decoy as D
from . import exp, figs

F_REF = {"Grimone": 390.0, "Roanne": 486.0, "Rousset": 494.0}
V3 = {"Grimone": dict(edges=0.53, w30=0.49), "Roanne": dict(edges=1.00, w30=0.95), "Rousset": dict(edges=0.97, w30=0.81)}


def auc(score, label):
    label = np.asarray(label, bool)
    if label.all() or (~label).all():
        return float("nan")
    r = rankdata(score)
    return float((r[label].sum() - label.sum() * (label.sum() + 1) / 2) / (label.sum() * (~label).sum()))


def parabola_peak(f, y):
    """peak of log-likelihood against log f by a parabola through the best grid point and its neighbours; nan at the edge"""
    i = int(np.argmax(y))
    if i == 0 or i == len(y) - 1:
        return float("nan")
    x = np.log(f[i - 1:i + 2]); a = np.polyfit(x, y[i - 1:i + 2], 2)
    return float(np.exp(-a[1] / (2 * a[0]))) if a[0] < 0 else float("nan")


def vms_table(tag="b0.0"):
    rows = []
    res = {}
    for v in exp.VIDEOS:
        n = exp.SHORT[v]
        r = pickle.load(open(exp.WORK / "res" / f"vms_{n}_{tag}.pkl", "rb"))
        res[n] = r
        S = r["scan"] / r["km"]
        yk = S[:, int(np.argmax(S.max(0)))]
        rows.append(dict(video=n, edges=r["on_road"], w30=r["on30"], w100=r["on100"], junc=(r["junc_correct"], r["junc_wrong"], r["junc_off"]), f_best=r["f_best"], kappa=r["kappa_best"],
                         f_parab=parabola_peak(np.array(r["fgrid"]), yk), per_km=r["score_per_km"], v3=V3[n], b=r["b_speed"], cells=r["cells"], steps=r["steps"], sec=r["seconds"],
                         conf=r["conf"] and dict(auc_edge=auc(r["conf"]["p"], r["conf"]["on_edge"]), auc_30=auc(r["conf"]["p"], r["conf"]["within30"]),
                                                  mean_ok=float(r["conf"]["p"][r["conf"]["on_edge"]].mean()), mean_bad=float(r["conf"]["p"][~r["conf"]["on_edge"]].mean()) if (~r["conf"]["on_edge"]).any() else None,
                                                  frac_wrong_below_half=float((r["conf"]["p"][~r["conf"]["within30"]] < 0.5).mean()) if (~r["conf"]["within30"]).any() else None,
                                                  frac_lowconf_wrong=float((~r["conf"]["within30"][r["conf"]["p"] < 0.5]).mean()) if (r["conf"]["p"] < 0.5).any() else None)))
    return rows, res


def make_figs(tag="b0.0"):
    rows, res = vms_table(tag)
    for v in exp.VIDEOS:
        n = exp.SHORT[v]
        r = res[n]
        g, truth = exp.load(v)
        gx = np.column_stack([truth.gc["x"], truth.gc["y"]])
        figs.map_fig(v, g, r["route"], exp.WORK / "figs" / f"map_{v}.png", f"{n}: decided route of the dense HMM (vms input, no GPS; f_eff {r['f_best']:.0f}, kappa {r['kappa_best']}); on edges {r['on_road']*100:.0f} %, within 30 m {r['on30']*100:.0f} %",
                     gps_xy=gx)
        figs.confidence_fig(r, exp.WORK / "figs" / f"confidence_{v}.png", title=f"{n}: posterior of the decoded edge against correctness (development data)")
    figs.scale_fig(res, F_REF, exp.WORK / "figs" / "scale_likelihood.png", exp.F_GRID, exp.K_GRID)
    return rows


if __name__ == "__main__" and (len(sys.argv) < 2 or sys.argv[1] != "extra"):
    tag = sys.argv[1] if len(sys.argv) > 1 else "b0.0"
    rows = make_figs(tag)
    print(json.dumps(rows, indent=1, default=float))


def decoy_figs():
    d, ranks = None, {}
    from . import tables
    _, ranks = tables.decoy_table()
    figs.decoy_fig(ranks, exp.WORK / "figs" / "decoy_rank.png")
    return ranks


def amalfi_figs(variant="base"):
    from pyproj import Transformer
    from rsm.nogps import cfg, verify
    from . import amalfi
    g, tracks = amalfi.load(variant)
    r = pickle.load(open(exp.WORK / "res" / f"amalfi_{variant}.pkl", "rb"))
    places = verify.place_nodes(json.loads((cfg.WORK / "area_amalfi.json").read_text())["bbox"])
    tr = Transformer.from_crs(4326, g.crs, always_xy=True)
    ev = []
    for p in places:
        if p["name"] in ("Vietri sul Mare", "Erchie"):
            ev.append((p["name"] + " (sign at " + ("30" if p["name"].startswith("V") else "790") + " s)", np.array(tr.transform(p["lon"], p["lat"]))))
    figs.map_fig("amalfi", g, r["route"], exp.WORK / "figs" / f"map_amalfi_{variant}.png",
                 f"Amalfi (motorcycle, no GPS), input {variant}: Viterbi route of the dense HMM, NOT significant against decoys (rank 9 of 20); red stars: place nodes of the two sign sightings", evidence_pts=ev)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "extra":
    decoy_figs(); amalfi_figs("base")
