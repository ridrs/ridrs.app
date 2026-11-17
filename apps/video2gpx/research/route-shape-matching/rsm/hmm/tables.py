# SPDX-License-Identifier: AGPL-3.0-or-later
"""Markdown tables for work/fable3/RESULTS.md from the pickles. python -m rsm.hmm.tables > work/fable3/tables.md"""
from __future__ import annotations

import pickle

import numpy as np

from . import decoy as D
from . import exp
from .report import V3, F_REF, auc, parabola_peak


def gps_table():
    d = pickle.load(open(exp.WORK / "res" / "gps_h30_d30_r10.pkl", "rb"))
    out = ["| video (dev data) | cells x steps | on correct edges | within 30 m | within 100 m | junctions c/w/off | beam tracker on GPS (v3 tracker-on-GPS, 5 anchors) | confidence correct / wrong |", "|---|---|---|---|---|---|---|---|"]
    beam = {"Grimone": "56 %", "Roanne": "97 %", "Rousset": "94 %"}
    for v in exp.VIDEOS:
        r = d[v]; n = exp.SHORT[v]
        out.append(f"| {n} | {r['cells']} x {r['steps']} | {r['on_road']*100:.1f} % | {r['on30']*100:.1f} % | {r['on100']*100:.1f} % | {r['junc_correct']}/{r['junc_wrong']}/{r['junc_off']} | {beam[n]} | {r['conf_correct']['mean_conf_correct']:.2f} / {r['conf_correct']['mean_conf_wrong']:.2f} |")
    return "\n".join(out), d


def vms_table(tag="b0.0"):
    out = ["| video (dev data) | cells x steps | best f_eff (grid / parabola) | kappa | on correct edges (v3) | within 30 m (v3) | within 100 m | junctions c/w/off | score per km | seconds |", "|---|---|---|---|---|---|---|---|---|---|"]
    res = {}
    for v in exp.VIDEOS:
        n = exp.SHORT[v]
        r = pickle.load(open(exp.WORK / "res" / f"vms_{n}_{tag}.pkl", "rb")); res[n] = r
        S = r["scan"] / r["km"]; yk = S[:, int(np.argmax(S.max(0)))]
        pb = parabola_peak(np.array(r["fgrid"]), yk)
        out.append(f"| {n} | {r['cells']} x {r['steps']} | {r['f_best']:.0f} / {pb:.0f} | {r['kappa_best']} | {r['on_road']*100:.1f} % ({V3[n]['edges']*100:.0f} %) | {r['on30']*100:.1f} % ({V3[n]['w30']*100:.0f} %) | {r['on100']*100:.1f} % | {r['junc_correct']}/{r['junc_wrong']}/{r['junc_off']} | {r['score_per_km']:.2f} | {r['seconds']:.0f} |")
    return "\n".join(out), res


def scan_table(res):
    out = []
    for n, r in res.items():
        S = r["scan"] / r["km"]
        out.append(f"{n} (best-path log-likelihood per km; rows f_eff, columns kappa {list(r['kgrid'])}; GPS reference f_eff {F_REF[n]:.0f})")
        out.append("")
        out.append("| f_eff | " + " | ".join(f"{k}" for k in r["kgrid"]) + " |")
        out.append("|---|" + "---|" * len(r["kgrid"]))
        for i, f in enumerate(r["fgrid"]):
            out.append(f"| {f:.0f} | " + " | ".join(f"{x:.2f}" for x in S[i]) + " |")
        out.append("")
    return "\n".join(out)


def conf_table(res):
    out = ["| video | AUC (posterior of the decoded edge vs on a correct edge) | AUC (vs within 30 m) | mean posterior when on correct edge / not | share of time at posterior < 0.5 that is > 30 m off | share of the > 30 m time at posterior < 0.5 |", "|---|---|---|---|---|---|"]
    for n, r in res.items():
        c = r["conf"]; p = c["p"]
        bad = ~c["within30"]
        out.append(f"| {n} | {auc(p, c['on_edge']):.2f} | {auc(p, c['within30']):.2f} | {p[c['on_edge']].mean():.2f} / {p[~c['on_edge']].mean() if (~c['on_edge']).any() else float('nan'):.2f} | "
                   f"{(bad[p < 0.5]).mean() if (p < 0.5).any() else float('nan'):.2f} (n={int((p<0.5).sum())}) | {(p[bad] < 0.5).mean() if bad.any() else float('nan'):.2f} |")
    return "\n".join(out)


def decoy_table():
    out = ["| video | real (log-lik per km) | best decoy (name) | decoy mean by family | rank of the real run | p |", "|---|---|---|---|---|---|"]
    ranks = {}
    for v in exp.VIDEOS:
        n = exp.SHORT[v]
        try:
            done = pickle.load(open(exp.WORK / "res" / f"decoy_{n}.pkl", "rb"))
        except FileNotFoundError:
            continue
        rk = D.rank(done); ranks[n] = (done, rk)
        fam = ", ".join(f"{k} {m:.1f} (max {x:.1f})" for k, (m, x) in rk["by_fam"].items())
        out.append(f"| {n} | {rk['real']:.2f} | {rk['best_decoy']:.2f} ({rk['best_decoy_name']}) | {fam} | {rk['rank']} of {rk['n']+1} | {rk['p']:.2f} |")
    return "\n".join(out), ranks


if __name__ == "__main__":
    t, _ = gps_table(); print("## GPS-fed\n", t, "\n")
    t, res = vms_table(); print("## vms\n", t, "\n")
    print("## scan\n", scan_table(res), "\n")
    print("## confidence\n", conf_table(res), "\n")
    t, _ = decoy_table(); print("## decoys\n", t)
