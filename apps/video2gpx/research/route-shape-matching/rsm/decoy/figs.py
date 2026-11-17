# SPDX-License-Identifier: AGPL-3.0-or-later
"""Decoy rank chart and markdown tables.  python -m rsm.decoy.figs  -> work/fable1/fig_decoy_ranks.png, tables.md"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

OUT = Path(__file__).resolve().parents[2] / "work" / "fable1"
V = ("vallee-de-roanne", "col-de-grimone-1", "col-de-rousset", "amalfi")
COL = {"shuffle": "#1f6fb4", "flip": "#2a9d8f", "mirror": "#c1440e", "reverse": "#999999"}


def main():
    d = json.loads((OUT / "decoy_ranks.json").read_text())
    fig, ax = plt.subplots(1, 4, figsize=(14, 4.2))
    rng = np.random.default_rng(0)
    for k, v in enumerate(V):
        for i, f in enumerate(("shuffle", "flip", "mirror", "reverse")):
            c = [x["best_cpk"] for x in d[v]["_decoys"][f] if x["best_cpk"] is not None]
            ax[k].scatter(i + rng.uniform(-0.12, 0.12, len(c)), c, s=18, color=COL[f], alpha=0.8, lw=0, label=f"{f} (n={len(c)})")
        r = d[v]["_real"]["best_cpk"]
        ax[k].axhline(r, color="black", lw=1.4)
        ax[k].text(3.45, r, " real", va="bottom", ha="right", fontsize=8)
        ax[k].set_xticks(range(4)); ax[k].set_xticklabels(["shuffle", "flip", "mirror", "reverse*"], fontsize=8)
        ax[k].set_title(f"{v}\nrank {d[v]['all']['cpk']['rank']} of {d[v]['all']['cpk']['n'] + 1} (shuffle+flip+mirror)", fontsize=9)
        ax[k].set_ylim(0, None)
    ax[0].set_ylabel("cost per km of the run's cheapest route")
    fig.text(0.5, 0.005, "* reverse = same road driven backwards, a consistency check, not a decoy and not in the rank", ha="center", fontsize=8)
    fig.tight_layout(rect=(0, 0.03, 1, 1)); fig.savefig(OUT / "fig_decoy_ranks.png", dpi=130); plt.close(fig)
    L = ["| video | family | n | cpk real | rank / p | good-run real (s) | rank / p | cluster real | rank / p |", "|---|---|---|---|---|---|---|---|---|"]
    for v in V:
        for f in ("shuffle", "flip", "mirror", "all"):
            r = d[v][f]
            L.append(f"| {v} | {f} | {r['cpk']['n']} | {r['cpk']['real']:.1f} | {r['cpk']['rank']} / {r['cpk']['p']:.3f} | {r['good']['real']:.0f} | {r['good']['rank']} / {r['good']['p']:.3f} | {r['cluster']['real']:.0f} | {r['cluster']['rank']} / {r['cluster']['p']:.3f} |")
    (OUT / "tables.md").write_text("\n".join(L))
    print("\n".join(L))


if __name__ == "__main__":
    main()
