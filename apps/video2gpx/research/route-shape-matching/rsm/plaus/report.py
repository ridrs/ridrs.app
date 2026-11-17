# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tables (markdown) from the stage A/B records."""
from __future__ import annotations

import numpy as np

from . import decide as D
from . import experiment as X
from . import pipeline as P

SRC = ("refined", "baseline", "gps")
LS = P.LENGTHS


def load_all(tag, half):
    d = {}
    for s in SRC:
        r1 = X.load_set(tag, half, s)
        r2 = X.load_set(tag + "2", half, s)
        d[s] = (r1, r2)
    for c in X.CTLS:
        d[c] = (X.load_set(tag, half, "refined", c), X.load_set(tag + "2", half, "refined", c))
    return d


def md(rows, head):
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(str(x) for x in r) + " |" for r in rows]
    return "\n".join(out)


def recall_table(data, half):
    rows = []
    for s in SRC:
        r1 = data[s][0]
        for L in LS:
            c = X.recall_row(r1, L)
            if c["n"]:
                rows.append([s, L, c["n"], c["K1"], c["K20"], c["K50"], c["K200"]])
    return md(rows, ["input", "L", "windows", "top-1", "true in K=20", "K=50", "K=200"])


def decision_table(data, half, cal):
    rows = []
    for s in SRC:
        r1, r2 = data[s]
        for L in LS:
            n = sum(1 for r in r1 if r["L"] == L)
            if not n:
                continue
            row = [s, L, n, X.recall_row(r1, L)["K50"], X.cell(r1, r2, cal[s], "measured", "p1", L)["win_with_true"]]
            for st in X.SETTINGS:
                c = X.cell(r1, r2, cal[s], st, "p1", L)
                row.append(f"{c['correct']}/{c['wrong']}/{c['none']}")
            for mode in ("vc", "adj"):
                c = X.cell(r1, r2, cal[s], "measured", mode, L)
                row.append(f"{c['correct']}/{c['wrong']}/{c['none']}")
            rows.append(row)
    return md(rows, ["input", "L", "windows", "true chain in K=50", "of which fitted (>= 3 matched quanta, span >= 40 %)", "tight c/w/n", "measured c/w/n", "loose c/w/n", "measured + video-level scale", "... + adjacency"])


def accept_table(data, half, cal):
    rows = []
    for s in SRC:
        r1, r2 = data[s]
        for st in X.SETTINGS:
            for mode in ("p1", "vc"):
                tot = dict(true_cands=0, true_acc=0, wrong_cands=0, wrong_acc=0, win_with_true=0, win_true_acc=0, win_wrong_acc=0, n=0)
                for L in LS:
                    c = X.cell(r1, r2, cal[s], st, mode, L)
                    for k in tot:
                        tot[k] += c[k]
                if tot["n"] == 0:
                    continue
                pct = lambda a, b: f"{a}/{b} ({100*a/b:.0f}%)" if b else "-"
                rows.append([s, st, mode, pct(tot["true_acc"], tot["true_cands"]), pct(tot["win_true_acc"], tot["win_with_true"]), pct(tot["wrong_acc"], tot["wrong_cands"]),
                             pct(tot["win_wrong_acc"], tot["n"])])
    return md(rows, ["input", "priors", "mode", "true candidates accepted", "windows with a true candidate: a true one accepted", "wrong candidates accepted", "windows with >= 1 wrong accepted"])


def control_table(data, half, cal):
    rows = []
    for st in X.SETTINGS:
        for mode in ("p1", "vc", "adj"):
            for c in X.CTLS:
                r1, r2 = data[c]
                if not r1:
                    continue
                dec_n = nwin = cacc = ctot = wacc = 0
                for L in LS:
                    ce = X.cell(r1, r2, cal["refined"], st, mode, L)
                    nwin += ce["n"]; dec_n += ce["correct"] + ce["wrong"]; cacc += ce["wrong_acc"] + ce["true_acc"]; ctot += ce["wrong_cands"] + ce["true_cands"]
                    wacc += ce["win_wrong_acc"]
                rows.append([st, mode, c, nwin, f"{cacc}/{ctot} ({100*cacc/max(ctot,1):.1f}%)", wacc, dec_n])
    return md(rows, ["priors", "mode", "control", "windows", "candidates accepted", "windows with an accepted candidate", "decisions (all are failures)"])


def corr_table(data, half, cal, st="measured"):
    rows = []
    for s in ("refined", "baseline", "gps"):
        r1 = data[s][0]
        best_t, best_w, all_w = [], [], []
        for r in r1:
            ft = [(f["snorm"], f) for c, f in D.fits_of(r, st) if c["correct"]]
            fw = [(f["snorm"], f) for c, f in D.fits_of(r, st) if not c["correct"]]
            if ft:
                best_t.append(min(ft, key=lambda x: x[0])[1])
            if fw:
                best_w.append(min(fw, key=lambda x: x[0])[1])
            all_w += [f for _, f in fw]

        def q(fs, key, absv=False):
            if not fs:
                return "-"
            v = np.array([np.max(np.abs(f[key])) if key == "rate" else f[key] for f in fs], float)
            if key == "lam":
                v = np.abs(v)
            p = np.percentile(v, [10, 50, 90])
            return f"{p[0]:.2f} / {p[1]:.2f} / {p[2]:.2f}"

        for name, fs in (("best true", best_t), ("best wrong (lowest cost per window)", best_w), ("all wrong", all_w)):
            if fs:
                bound = np.mean([f["atbound"] for f in fs])
                rows.append([s, name, len(fs), q(fs, "rho"), q(fs, "kappa"), q(fs, "rate"), q(fs, "lam"), f"{100*bound:.0f}%", q(fs, "rms")])
    return md(rows, ["input", "candidates", "n", "rho p10/50/90", "kappa p10/50/90", "max drift rate (deg/s)", "abs lambda", "at a prior bound", "rms position residual (m)"])


def runtime(data):
    fs, ws, sa = [], [], []
    for k, (r1, _) in data.items():
        if k in X.CTLS:
            continue
        for r in r1:
            ws.append(r["sec"]); sa.append(r["sec_a"])
            for c in r["cands"]:
                for st, f in c["fits"].items():
                    if f["ok"]:
                        fs.append(f["sec"])
    return dict(fit_mean=float(np.mean(fs)) if fs else float("nan"), fit_median=float(np.median(fs)) if fs else float("nan"), n_fits=len(fs),
                window_mean=float(np.mean(ws)), window_stageA_mean=float(np.mean(sa)), n_windows=len(ws))


def kdep_table(data, cal, st="measured"):
    rows = []
    old = D.KMAX
    try:
        for s in SRC:
            r1, r2 = data[s]
            for K in (20, 50, 200):
                D.KMAX = K
                tot = dict(correct=0, wrong=0, none=0, wrong_cands=0, wrong_acc=0, true_cands=0, true_acc=0)
                for L in LS:
                    c = X.cell(r1, r2, cal[s], st, "p1", L)
                    for k in tot:
                        tot[k] += c[k]
                rows.append([s, K, f"{tot['correct']}/{tot['wrong']}/{tot['none']}", f"{tot['true_acc']}/{tot['true_cands']}", f"{tot['wrong_acc']}/{tot['wrong_cands']}"])
    finally:
        D.KMAX = old
    return md(rows, ["input", "K in stage B", "c/w/n (measured priors, summed over L)", "true candidates accepted", "wrong candidates accepted"])


def vc_table(data, cal):
    """effect of the cross-window consistency: refined input, per priors; decisions over all L; controls' decisions; adjacency pairs."""
    rows = []
    for st in ("measured", "loose"):
        for mode in ("p1", "vc", "adj"):
            r1, r2 = data["refined"]
            tot = dict(correct=0, wrong=0, none=0, wrong_cands=0, wrong_acc=0, true_cands=0, true_acc=0, adj_pairs=0, adj_bad=0)
            for L in LS:
                c = X.cell(r1, r2, cal["refined"], st, mode, L)
                for k in tot:
                    tot[k] += c[k]
            ctl = ctl_c = 0
            for c in X.CTLS:
                a, b = data[c]
                for L in LS:
                    ce = X.cell(a, b, cal["refined"], st, mode, L)
                    ctl += ce["correct"] + ce["wrong"]
                    ctl_c += ce["wrong_acc"] + ce["true_acc"]
            rows.append([st, mode, f"{tot['correct']}/{tot['wrong']}/{tot['none']}", f"{tot['true_acc']}/{tot['true_cands']}", f"{tot['wrong_acc']}/{tot['wrong_cands']}", ctl_c, ctl,
                         f"{tot['adj_pairs']} / {tot['adj_bad']}"])
    return md(rows, ["priors", "mode", "decisions c/w/n", "true cands accepted", "wrong cands accepted", "control candidates accepted", "control decisions", "overlapping decided pairs checked / not adjacent"])


def vc_estimates(data):
    rows = []
    for s in ("refined", "baseline", "gps"):
        seen = {}
        for r in data[s][1]:
            seen.setdefault(r["video"], r["vc_est"])
        for v, est in seen.items():
            e = est["measured"]
            f = lambda k, n: "-" if e is None else f"{e[k]:.3f} (IQR {e[n][0]:.3f}-{e[n][1]:.3f})"
            rows.append([s, v, f("rho", "rho_iqr"), f("kappa", "kappa_iqr"), "-" if e is None else e["n"]])
    return md(rows, ["input", "video", "video-level rho (measured priors)", "video-level kappa", "windows used"])


def posthoc_baseline(data, cal):
    """POST HOC: the baseline input judged with the acceptance threshold of the refined input (DEV-A held only 5 true baseline windows)."""
    rows = []
    r1, _ = data["baseline"]
    for st in X.SETTINGS:
        tau = cal["refined"][st]["tau"]
        for L in LS:
            sel = [r for r in r1 if r["L"] == L]
            oc = [D.outcome(D.decide(r, st, tau, cal["refined"][st]["m"])) for r in sel]
            rows.append([st, L, len(sel), f"{oc.count('correct')}/{oc.count('wrong')}/{oc.count('none')}"])
    return md(rows, ["priors", "L", "windows", "baseline decisions c/w/n with the refined threshold (post hoc)"])


def variant_table(names=("base", "wide", "skip4", "wide_skip4", "wider", "wide_b600")):
    """stage A variants on DEV-A (the data that chose the variant)."""
    rows = []
    for var in names:
        for sname in SRC:
            row = [var, sname]
            for L in LS:
                rs = []
                for v in X.VIDEOS["DEV-A"]:
                    rs += [r for r in P.load(f"recall_{var}_DEV-A_{v}_{sname}") if r["L"] == L]
                ft = [r["first_true"] for r in rs]
                row.append(f"{len(rs)}: " + " / ".join(str(sum(1 for x in ft if x is not None and x < K)) for K in (1, 20, 50, 200)))
            rows.append(row)
    return md(rows, ["stage A variant", "input"] + [f"L={L}: windows: true in top-1 / K=20 / 50 / 200" for L in LS])
