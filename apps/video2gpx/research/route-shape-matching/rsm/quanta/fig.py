# SPDX-License-Identifier: AGPL-3.0-or-later
"""Map figure per video: GPS truth vs the top chains of confident windows. (c) OpenStreetMap contributors, ODbL."""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from . import evalrun as ev
from .area import WORK


def chain_xy(ctx: ev.Ctx, m: dict, legs_: list) -> list[np.ndarray]:
    """Polylines (graph CRS) of the legs of a chain: the edges from the first turn's edge to the second turn's edge."""
    out = []
    for _, lg in legs_:
        a, b = int(m["leg_a"][lg]), int(m["leg_b"][lg])
        lo, hi = m["leg_edges_off"][lg], m["leg_edges_off"][lg + 1]
        edges = m["leg_edges"][lo:hi]
        if len(edges):
            out.append(np.vstack([ctx.g.geom(int(e)) for e in edges]))
        else:
            out.append(np.vstack([m["events"]["mid"][a], m["events"]["mid"][b]]))
    return out


def make(video: str, runs_json: Path, out_png: Path, L: str = "10", source: str = "refined", rule: dict | None = None, title_extra: str = "") -> dict:
    res = json.loads(Path(runs_json).read_text())
    rule = rule or res["rule"]
    ctx = ev.load_ctx(video)
    recs = res["runs"][source][L]
    conf = [r for r in recs if ev.confident(r, rule)]
    fig, ax = plt.subplots(figsize=(10, 10))
    # roads
    for e in range(0, ctx.g.n_edges, 1):
        p = ctx.g.geom(e)
        ax.plot(p[:, 0] / 1000, p[:, 1] / 1000, color="#d0d0d0", lw=0.4, zorder=1)
    ax.plot(ctx.gc["x"] / 1000, ctx.gc["y"] / 1000, color="k", lw=2.0, zorder=2, label="GPS truth")
    n_ok = n_bad = 0
    for r in conf:
        col = "#1a9850" if r["ok1"] else "#d73027"
        n_ok += r["ok1"]
        n_bad += not r["ok1"]
        for pl in chain_xy(ctx, ctx.m, r["legs"]):
            ax.plot(pl[:, 0] / 1000, pl[:, 1] / 1000, color=col, lw=1.6, alpha=0.85, zorder=3)
    ax.plot([], [], color="#1a9850", lw=2, label=f"top chain, confident correct ({n_ok})")
    ax.plot([], [], color="#d73027", lw=2, label=f"top chain, confident wrong ({n_bad})")
    b = ctx.area["bbox"]
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, ctx.g.crs, always_xy=True)
    x0, y0 = tr.transform(b["west"], b["south"])
    x1, y1 = tr.transform(b["east"], b["north"])
    ax.plot([x0 / 1000, x1 / 1000, x1 / 1000, x0 / 1000, x0 / 1000], [y0 / 1000, y0 / 1000, y1 / 1000, y1 / 1000, y0 / 1000], "--", color="#4575b4", lw=1, label="search area")
    ax.set_aspect("equal")
    ax.set_xlabel("UTM 31N east (km)")
    ax.set_ylabel("north (km)")
    ax.set_title(f"{video}: {source}, windows of {L} quanta, {len(conf)} confident of {len(recs)} {title_extra}")
    ax.legend(loc="upper right", fontsize=8)
    ax.text(0.01, 0.01, "© OpenStreetMap contributors, ODbL", transform=ax.transAxes, fontsize=8, color="#444", va="bottom")
    fig.tight_layout()
    Path(out_png).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=130)
    plt.close(fig)
    return dict(confident=len(conf), correct=n_ok, wrong=n_bad, windows=len(recs))
