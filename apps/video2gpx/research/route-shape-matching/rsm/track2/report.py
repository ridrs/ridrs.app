# SPDX-License-Identifier: AGPL-3.0-or-later
"""Markdown tables from work/track2/res/*.pkl.  python -m rsm.track2.report > work/track2/tables.md"""
from __future__ import annotations

import pickle

import numpy as np

from . import exp

NAME = {"vallee-de-roanne": "Roanne", "col-de-grimone-1": "Grimone", "col-de-rousset": "Rousset"}


def get(cfg, v):
    try:
        return pickle.load(open(exp.RES / f"{cfg}_{v}.pkl", "rb"))["out"]
    except FileNotFoundError:
        return None


def p(x, d=0):
    return "n/a" if x is None or not np.isfinite(x) else f"{100 * x:.{d}f} %"


def j(s):
    return f"{s['junc_correct']} / {s['junc_wrong']} / {s['junc_off']}"


def main_table(cfgs=("v2", "v3")):
    L = ["| video (all DEVELOPMENT data) | code | decided route (best cluster, cheapest member): within 30 m / on correct edges | junctions c / w / off | combined route, pool of decisions: within 30 m (all time) / of decided time / coverage | on correct edges | junctions c / w / off | combined route, polluted pool: within 30 m | whole route right? |",
         "|---|---|---|---|---|---|---|---|---|"]
    for v in exp.VIDEOS:
        for c in cfgs:
            d = get(c, v)
            if d is None:
                continue
            P1, P2 = d["P1"], d["P2"]
            f1 = P1["final"]; f1d = P1["final_decided"]; f2 = P2["final"]
            lead = P1["lead"]
            right = "yes" if f1["on30"] >= 0.9 else ("partly" if f1["on30"] >= 0.5 else "no")
            L.append(f"| {NAME[v]} | {c} | {p(lead['on30'])} / {p(lead['on_road'])} | {j(lead)} | {p(f1['on30'])} / {p(f1d.get('on30_of_decided', 0))} / {p(f1d['covered'])} | {p(f1['on_road'])} | {j(f1)} | {p(f2['on30'])} | {right} |")
    return "\n".join(L)


def sep_table(cfgs=("v2", "v3")):
    L = ["| video | code | n true / wrong | cost per km true / wrong | AUC cost | good run true / wrong (s) | AUC good run | wrong cheaper than true median |", "|---|---|---|---|---|---|---|---|"]
    for v in exp.VIDEOS:
        for c in cfgs:
            d = get(c, v)
            if d is None:
                continue
            s = d["sep"]
            L.append(f"| {NAME[v]} | {c} | {s['n_true']} / {s['n_wrong']} | {s['cpk_true']:.0f} / {s['cpk_wrong']:.0f} | {s['auc_cost']:.2f} | {s['good_true']:.0f} / {s['good_wrong']:.0f} | {s['auc_good']:.2f} | {p(s['wrong_cheaper'])} |")
    return "\n".join(L)


def comp_table(cfgs=("v2", "v3")):
    keys = list(exp.GROUPS) + ["total"]
    L = ["| video | code | routes | " + " | ".join(k.replace("_", " ") for k in keys) + " |", "|---|---|---|" + "---|" * len(keys)]
    for v in exp.VIDEOS:
        for c in cfgs:
            d = get(c, v)
            if d is None:
                continue
            for lab, key in (("true", "comp_true"), ("wrong", "comp_wrong")):
                cs = d[key]
                L.append(f"| {NAME[v]} | {c} | {lab} | " + " | ".join(f"{cs.get(k, np.nan):.1f}" for k in keys) + " |")
    return "\n".join(L)


def control_table(cfgs=("v2", "v3")):
    L = ["| video | code | true cost per km | mirrored video, true anchors: cost / within 30 m / largest cluster | foreign map, random anchors: cost / largest cluster / cheaper than true median | random anchors, own map: cost / cheaper than true median |", "|---|---|---|---|---|---|"]
    for v in exp.VIDEOS:
        for c in cfgs:
            d = get(c, v)
            if d is None or "ctl_mirror" not in d:
                continue
            m, f, r = d["ctl_mirror"], d["ctl_foreign"], d["ctl_random"]
            L.append(f"| {NAME[v]} | {c} | {d['sep']['cpk_true']:.0f} | {m['cpk']:.0f} / {p(m['on30'])} / {m['largest_cluster']} of {m['n']} | {f['cpk']:.0f} / {f['largest_cluster']} of {f['n']} / {p(f['cheaper_than_true'])} | {r['cpk']:.0f} / {p(r['cheaper_than_true'])} |")
    return "\n".join(L)


def ablation_table(cfgs):
    L = ["| video | config | decided route within 30 m | combined route (pool of decisions) within 30 m / junctions c / w / off | polluted pool | AUC cost | AUC good run | seconds |", "|---|---|---|---|---|---|---|---|"]
    for v in exp.VIDEOS:
        for c in cfgs:
            d = get(c, v)
            if d is None:
                continue
            P1, P2 = d["P1"], d["P2"]
            L.append(f"| {NAME[v]} | {c} | {p(P1['lead']['on30'])} | {p(P1['final']['on30'])} / {j(P1['final'])} | {p(P2['final']['on30'])} | {d['sep']['auc_cost']:.2f} | {d['sep']['auc_good']:.2f} | {d['seconds']:.0f} |")
    return "\n".join(L)


def speed_table():
    L = ["| video | intercept a (reported) | slope b per (m/s above 3) | windows | effect at 6 m/s (+3 m/s above the knee) |", "|---|---|---|---|---|"]
    for v in exp.VIDEOS:
        d = get("v3", v)
        if d is None or "speed_fit" not in d:
            continue
        s = d["speed_fit"]
        L.append(f"| {NAME[v]} | {s['a']:+.3f} | {s['b']:+.4f} | {s['n_windows']} | {100 * 3 * s['b']:+.1f} % |")
    return "\n".join(L)


def gps_table():
    try:
        G = pickle.load(open(exp.RES / "gpsfed.pkl", "rb"))
    except FileNotFoundError:
        return ""
    L = ["| video | source | code | within 30 m (mean / min of 5 anchors) | within 100 m | on correct edges | junctions c / w / off |", "|---|---|---|---|---|---|---|"]
    for v in exp.VIDEOS:
        for (src, c), r in G.get(v, {}).items():
            L.append(f"| {NAME[v]} | {src} | {c} | {p(np.mean(r['on30']))} / {p(np.min(r['on30']))} | {p(np.mean(r['on100']))} | {p(np.mean(r['on_road']))} | {r['jc']} / {r['jw']} / {r['jo']} |")
    return "\n".join(L)


if __name__ == "__main__":
    print("## main\n" + main_table() + "\n\n## separation\n" + sep_table() + "\n\n## components\n" + comp_table() + "\n\n## controls\n" + control_table() + "\n\n## speed\n" + speed_table() + "\n\n## gps\n" + gps_table())
