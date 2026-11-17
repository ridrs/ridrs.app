# SPDX-License-Identifier: AGPL-3.0-or-later
"""Figures of v3. Map data (c) OpenStreetMap contributors, ODbL. python -m rsm.track2.figs <video> [v3]"""
from __future__ import annotations

import pickle
import sys

import numpy as np
from scipy.ndimage import uniform_filter1d

from . import anchors as A
from . import consensus as C
from . import exp, fig, run, score, tracker

PAL = {"heading": "#4c78a8", "drift": "#f58518", "angle_scale": "#54a24b", "straight_stretch": "#b279a2", "gap_snap": "#e45756", "jump": "#222222", "innovation": "#c9c9c9", "other_events": "#9d755d"}


def load(cfg, video):
    return pickle.load(open(exp.RES / f"{cfg}_{video}.pkl", "rb"))


def stack_cost(ax, r, title, win=31, ymax=3.0):
    ix = {n: i for i, n in enumerate(tracker.COMP)}
    ys, labs = [], []
    for g, names in exp.GROUPS.items():
        v = sum(r.comp[:, ix[n]] for n in names)
        ys.append(uniform_filter1d(v, win, mode="nearest")); labs.append(g.replace("_", " "))
    ax.stackplot(r.t, ys, labels=labs, colors=[PAL[g] for g in exp.GROUPS], alpha=0.95, lw=0)
    ax.set_ylim(0, ymax); ax.set_ylabel("step cost, 60 s mean"); ax.set_title(title, fontsize=9)


def cost_fig(video, d, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    routes = d["routes"]; lab = d["anchors_label"]
    tr = [r for (a, r), ok in zip(routes["dec"], lab["dec"]) if ok]
    wr = [r for g in ("rank25", "random") for _, r in routes.get(g, [])]
    lead = min(tr, key=lambda r: r.cost_per_km)
    wmed = sorted(wr, key=lambda r: r.cost_per_km)[len(wr) // 2]
    fig_, axs = plt.subplots(2, 1, figsize=(11, 6), sharex=True)
    stack_cost(axs[0], lead, f"{video}: lowest-cost true-anchor route ({lead.cost_per_km:.0f} per km), correction components stacked")
    stack_cost(axs[1], wmed, f"median wrong-anchor route ({wmed.cost_per_km:.0f} per km)")
    axs[1].set_xlabel("video time (s)")
    axs[0].legend(fontsize=7, ncol=4, loc="upper right")
    fig_.text(0.01, 0.005, "development data (all three videos were seen)", fontsize=7)
    fig_.savefig(out, dpi=130, bbox_inches="tight"); plt.close(fig_)


def stretch_fig(video, d, out):
    """the straight with the largest stretch (|factor-1| 2..12 %, >= 150 m) of the lowest-cost true route: along-track position before (snap at the end) and after the even spreading"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    routes = d["routes"]; lab = d["anchors_label"]
    tr = [r for (a, r), ok in zip(routes["dec"], lab["dec"]) if ok]
    best = None
    for r in tr:
        for (t0, t1, sg, c) in r.stretch:
            if not (0.02 <= abs(sg - 1) <= 0.12):
                continue
            m = (r.t >= min(t0, t1)) & (r.t <= max(t0, t1))
            if m.sum() < 10:
                continue
            la = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(r.xy_live[m], axis=0).T))])
            na = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(r.xy[m], axis=0).T))])
            if la[-1] < 150:
                continue
            sc = float(np.abs(la - na).max())  # the straight where spreading changes the positions most
            if best is None or sc > best[0]:
                best = (sc, r, m, sg, c, t0, t1)
    if best is None:
        return False
    _, r, m, sg, c, t0, t1 = best
    t = r.t[m]
    live = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(r.xy_live[m], axis=0).T))])
    new = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(r.xy[m], axis=0).T))])
    gx = None
    fig_, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    ax[0].plot(t - t[0], live, color="#e45756", label="tracker as it ran (snap at the end of the straight)")
    ax[0].plot(t - t[0], new, color="#4c78a8", label=f"after even spreading (constant factor {sg:.3f})")
    ax[0].plot(t - t[0], live[-1] * (t - t[0]) / (t[-1] - t[0]), color="#999", ls=":", lw=0.8, label="linear reference")
    ax[0].set_xlabel("time in the straight (s)"); ax[0].set_ylabel("map distance from the start of the straight (m)"); ax[0].legend(fontsize=7)
    ax[0].set_title(f"{video}: straight at video t = {t[0]:.0f}..{t[-1]:.0f} s, stretch cost {c:.2f}", fontsize=9)
    ax[1].plot(r.xy_live[m, 0], r.xy_live[m, 1], "o-", ms=2.5, color="#e45756", lw=0.8, label="before")
    ax[1].plot(r.xy[m, 0], r.xy[m, 1], "o-", ms=2.5, color="#4c78a8", lw=0.8, label="after")
    ax[1].set_aspect("equal"); ax[1].legend(fontsize=7); ax[1].set_title("step positions along the road (positions per 8 m video step)", fontsize=9)
    ax[1].text(0.995, 0.005, fig.ATTR, transform=ax[1].transAxes, ha="right", va="bottom", fontsize=6, bbox=dict(fc="white", alpha=0.8, lw=0))
    fig_.savefig(out, dpi=130, bbox_inches="tight"); plt.close(fig_)
    return True


def map_fig(video, d, S, T, out, title):
    routes = d["routes"]; lab = d["anchors_label"]
    allr = [r for g in routes for _, r in routes[g]]
    P2 = d["out"]["P1"]
    t, src_raw, src_f = P2["chain_src"]
    pseudo = exp.compose(src_f, t, [r for _, r in routes["dec"]])
    o = np.argsort(pseudo.t, kind="stable")
    from types import SimpleNamespace
    lead = SimpleNamespace(t=pseudo.t[o], xy=pseudo.xy[o], inc=pseudo.inc[o])
    at = [a for a, _ in routes["dec"]]
    aw = [a for g in ("rank25", "random") for a, _ in routes.get(g, [])]
    return fig.map_fig(video, S["g"], T, lead, at, aw, None, out, title)


def make(video, cfg="v3"):
    d = load(cfg, video)
    S = run.setup(video, prm=d["prm"]); T = score.Truth(video, S["g"], S["fw"], log=lambda *a: None)
    exp.WORK.joinpath("figs").mkdir(exist_ok=True)
    cnt = map_fig(video, d, S, T, exp.WORK / "figs" / f"map_{video}_{cfg}.png", f"{video}: decided whole route of {cfg} (development data, GPS only as grey line)")
    cost_fig(video, d, exp.WORK / "figs" / f"cost_{video}_{cfg}.png")
    ok = stretch_fig(video, d, exp.WORK / "figs" / f"stretch_{video}_{cfg}.png")
    return cnt, ok


if __name__ == "__main__":
    for v in sys.argv[1:]:
        print(v, make(v))
