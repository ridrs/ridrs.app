# SPDX-License-Identifier: AGPL-3.0-or-later
"""Posterior mean AND spread along the fixed path (forward-backward of the dense HMM, as rsm.refine.post but with the second moment).
python -m rsm.fusion.posterior <Grimone|Roanne|Rousset|Amalfi>"""
from __future__ import annotations

import pickle
import sys
from pathlib import Path

import numpy as np

from rsm.hmm import grid
from rsm.refine import load, pathctx, post

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "fusion"
RES = WORK / "res"


class PathMoments(post.PathMean):
    """(mean arc, mass on the path, sd of the arc) of the posterior restricted to the path cells (renormalised)"""

    def __call__(self, j, p):
        w = p[self.cells].astype(np.float64)
        arcs = self.arcs
        if self.multi:
            d = np.abs(arcs - self.s_ref[j])
            gm = np.minimum.reduceat(d, self.first)
            grp = np.repeat(np.arange(len(self.first)), np.diff(np.concatenate([self.first, [len(arcs)]])))
            w = w * (d <= gm[grp] + 1e-9)
        m = w.sum()
        if m <= 1e-12:
            return np.nan, float(m), np.nan
        mu = (w * arcs).sum() / m
        return float(mu), float(m), float(np.sqrt((w * (arcs - mu) ** 2).sum() / m))


def stage(name: str, log=print):
    g, E, h, sm, st, tracks, r, dpm = load._setup(name)
    ctx = load.build_ctx(name, with_post=False)
    G = grid.build(g, E, h=h, sm=sm)
    cell_edge, cell_off = pathctx.cell_layout(g, E, h)
    assert G.N == len(cell_edge)
    pre = dpm.prepare(G, r["par"])
    s_full = np.interp(st.t, ctx.t_step, ctx.s_vit)
    cb = PathMoments(ctx.path, cell_edge, cell_off, s_full)
    log(f"{name}: cells {G.N} steps {st.T} path cells {len(cb.cells)} multi-visit {cb.multi}", flush=True)
    res = post.forward_backward_cb(dpm, pre, st, cb)
    mean = np.array([x[0] for x in res]); mass = np.array([x[1] for x in res]); sd = np.array([x[2] for x in res])
    bad = ~np.isfinite(mean) | (mass < 0.2)
    mean[bad] = s_full[bad]; sd[bad] = np.nan
    RES.mkdir(parents=True, exist_ok=True)
    pickle.dump(dict(s_pm=mean, mass=mass, sd=sd, t=st.t, bad=bad), open(RES / f"post_{name}.pkl", "wb"))
    old = RES.parent.parent / "refine" / "res" / f"post_{name}.pkl"
    if old.exists():
        o = pickle.load(open(old, "rb"))["s_pm"]
        log(f"{name}: max |mean - stored refine posterior mean| = {np.nanmax(np.abs(o - mean)):.3f} m", flush=True)
    log(f"{name}: steps with <20 % mass on the path {int(bad.sum())} of {st.T}; sd quantiles 10/50/90/99 % = {np.nanpercentile(sd, [10, 50, 90, 99]).round(1)}", flush=True)


if __name__ == "__main__":
    stage(sys.argv[1])
