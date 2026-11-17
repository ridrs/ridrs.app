# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tables and figures of the angle-scale study from the pickles / json in work/angle/. Run with the rsm venv (numpy, matplotlib).

python -m rsm.angle.report -> work/angle/tables.json, figs/f_per_video.png, figs/window_length.png
"""
from __future__ import annotations

import json
import pickle

import numpy as np

from . import analyse, farfeat, videos

NAMES = ["grimone", "roanne", "rousset", "gotthard", "cayolle", "amalfi"]
W = videos.WORK


def load_a(name, tag):
    p = W / f"a_{name}_{tag}.pkl"
    return pickle.load(open(p, "rb")) if p.exists() else None


def summaries():
    ref = json.loads((W / "refs.json").read_text())
    out = {}
    for n in NAMES:
        r = {"ref": ref[n]}
        res = load_a(n, "final")
        if res:
            s = analyse.summarize(res)
            s["peak_rss_gb_parent"] = res.get("peak_rss_gb_parent")
            s["seconds_tracking"] = res["seconds"]
            s["horizon"] = res["horizon"]
            r["A"] = s
        cm = load_a(n, "cmwin")
        if cm:
            r["A_window"] = analyse.summarize(cm)
        out[n] = r
    return out


def err(est, ref):
    return 100.0 * (est / ref - 1.0)


def main():
    S = summaries()
    (W / "tables.json").write_text(json.dumps(S, indent=1, default=float))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    figs = W / "figs"
    figs.mkdir(exist_ok=True)
    extra = {}
    for key, fn in (("B_fresh", "colmap_b.json"), ("C", "scan_summary.json")):
        if (W / fn).exists():
            extra[key] = json.loads((W / fn).read_text())
    fig, ax = plt.subplots(1, 2, figsize=(12, 4.6), gridspec_kw=dict(width_ratios=[1.5, 1]))
    x = np.arange(len(NAMES))
    for i, n in enumerate(NAMES):
        r = S[n]
        ref = r["ref"]
        ax[0].errorbar(i - 0.27, ref["primary"], yerr=[[ref["primary"] - ref["lo"]], [ref["hi"] - ref["primary"]]], fmt="s", c="k", capsize=3, label="reference f_eff (GPS / COLMAP)" if i == 0 else None)
        if "A" in r:
            a = r["A"]
            ax[0].errorbar(i - 0.09, a["f_eff_A"], yerr=[[a["f_eff_A"] - a["f_eff_A_ci"][0]], [a["f_eff_A_ci"][1] - a["f_eff_A"]]], fmt="o", c="#1f77b4", capsize=3, label="A: far features, whole video" if i == 0 else None)
        if "A_window" in r:
            a = r["A_window"]
            ax[0].errorbar(i + 0.09, a["f_eff_A"], yerr=[[a["f_eff_A"] - a["f_eff_A_ci"][0]], [a["f_eff_A_ci"][1] - a["f_eff_A"]]], fmt="D", c="#17becf", capsize=3, label="A: same COLMAP windows only" if i == 0 else None)
        b = extra.get("B_fresh", {}).get(n)
        if b:
            ax[0].errorbar(i + 0.27, b["f_eff"], yerr=[[b["f_eff"] - b["lo"]], [b["hi"] - b["f_eff"]]], fmt="^", c="#2ca02c", capsize=3, label="B: new COLMAP window (60 s)" if i == 0 else None)
        c = extra.get("C", {}).get(n)
        if c:
            ax[0].plot(i + 0.36, c["f"], "v", c="#ff7f0e", label="C: scan in the matcher" if i == 0 else None)
    ax[0].axhline(449, c="#999", ls=":", lw=1)
    ax[0].text(len(NAMES) - 0.45, 452, "fixed prior 449", color="#777", fontsize=8, ha="right")
    ax[0].set_xticks(x); ax[0].set_xticklabels([f"{n}\n({videos.VIDEOS[n]['role'].split(' ')[0]})" for n in NAMES], fontsize=9)
    ax[0].set_ylabel("f_eff (px at 360 rows)"); ax[0].set_title("angle scale per video: estimates against the reference")
    ax[0].legend(fontsize=8, loc="lower left")
    for i, n in enumerate(NAMES):
        r = S[n]; ref = r["ref"]["primary"]
        ax[1].barh(i + 0.18, err(449, ref), height=0.2, color="#bbb", label="fixed 449" if i == 0 else None)
        if "A" in r:
            ax[1].barh(i, err(r["A"]["f_eff_A"], ref), height=0.2, color="#1f77b4", label="A whole video" if i == 0 else None)
        if "A_window" in r:
            ax[1].barh(i - 0.18, err(r["A_window"]["f_eff_A"], ref), height=0.2, color="#17becf", label="A same windows" if i == 0 else None)
    ax[1].axvspan(-10, 10, color="#2ca02c", alpha=0.12)
    ax[1].set_yticks(range(len(NAMES))); ax[1].set_yticklabels(NAMES); ax[1].invert_yaxis()
    ax[1].set_xlabel("error of f against the reference (%)"); ax[1].set_title("green: goal ±10 %"); ax[1].legend(fontsize=8)
    fig.tight_layout(); fig.savefig(figs / "f_per_video.png", dpi=130); plt.close(fig)
    # window length
    wl = W / "colmap_window_length.json"
    if wl.exists():
        d = json.loads(wl.read_text())
        fig, ax = plt.subplots(1, 3, figsize=(11, 3.6), sharey=True)
        ref = json.loads((W / "refs.json").read_text())
        for a, n in zip(ax, ("gotthard", "cayolle", "amalfi")):
            for row in d[n]:
                f = np.array([e["f"] for e in row["ests"]])
                a.scatter(np.full(len(f), row["L"]) + np.random.default_rng(0).uniform(-2, 2, len(f)), f / ref[n]["primary"] * 100 - 100, s=14, alpha=0.7)
            a.axhspan(-10, 10, color="#2ca02c", alpha=0.12); a.axhline(0, c="k", lw=0.8)
            a.set_title(n); a.set_xlabel("COLMAP window length (s)"); a.set_xticks([15, 30, 60, 90])
        ax[0].set_ylabel("f_eff of the sub-window vs full-window reference (%)")
        fig.tight_layout(); fig.savefig(figs / "window_length.png", dpi=130); plt.close(fig)
    print(json.dumps({n: {k: (v if not isinstance(v, dict) else {a: b for a, b in v.items() if a in ('f_A', 'f_eff_A', 'g', 'n_stretch', 'n_pairs')}) for k, v in S[n].items() if k != 'ref'} for n in NAMES}, indent=1, default=float))


if __name__ == "__main__":
    main()
