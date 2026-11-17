# SPDX-License-Identifier: AGPL-3.0-or-later
"""One anchor -> whole-video route: forward and backward run combined into a Route (arrays over video time) with cost profile and summaries."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .tracker import Ctx, F_GAP, F_JUMP, F_OFF, run_direction
from .vtrack import Seq

COMP = ("c_innov", "c_corr", "c_event", "d_b", "d_r", "d_rho", "d_u", "d_eps")


@dataclass
class Route:
    t: np.ndarray
    E: np.ndarray  # forward edge ids
    U: np.ndarray  # forward offsets
    xy: np.ndarray
    inc: np.ndarray  # cost increment of the step (outward from the anchor)
    comp: np.ndarray  # (n, 8)
    flag: np.ndarray
    seg: np.ndarray
    dirn: np.ndarray  # +1 forward of the anchor, -1 backward, 0 anchor
    km: float  # tracked map km (steps)
    anchor_t: float
    gap_edges: list = field(default_factory=list)  # [(t, [edges])] walked through vms gaps
    cost_f: float = 0.0
    cost_b: float = 0.0
    seconds: float = 0.0
    ok: bool = True

    @property
    def cost(self) -> float:
        return self.cost_f + self.cost_b

    @property
    def cost_per_km(self) -> float:
        return self.cost / max(self.km, 1e-6)

    @property
    def n_jumps(self) -> int:
        return int(((self.flag & F_JUMP) > 0).sum())

    @property
    def n_off(self) -> int:
        return int(((self.flag & F_OFF) > 0).sum())

    def edges(self) -> list:
        """edge ids in video order (consecutive duplicates removed), including edges walked through gaps"""
        out = []
        gi = {round(t, 3): w for t, w in self.gap_edges}
        for t, e in zip(self.t, self.E):
            for x in gi.get(round(float(t), 3), []):
                if not out or out[-1] != x:
                    out.append(int(x))
            if not out or out[-1] != int(e):
                out.append(int(e))
        return out


def _extract(run, net, fwd_net, reverse):
    rec = run.path()
    t = np.array([h["t"] for h, i in rec]); E = np.array([h["E"][i] for h, i in rec], np.int64); U = np.array([h["U"][i] for h, i in rec], float)
    C = np.array([h["C"][i] for h, i in rec]); comp = np.array([h["comp"][i] for h, i in rec]); flag = np.array([h["flag"][i] for h, i in rec])
    seg = np.array([h["seg"] for h, i in rec]); kap = np.array([h["kap"][i] for h, i in rec])
    gaps = [(h["t"], h["gapw"][i]) for h, i in rec if h["gapw"] is not None]
    if reverse:
        U = fwd_net.L[E] - U
        gaps = [(tt, list(w)) for tt, w in gaps]
    inc = np.diff(np.concatenate([[0.0], C]))
    return t, E, U, inc, comp, flag, seg, kap, gaps, float(C[-1])


def track_anchor(ctx: Ctx, sf: Seq, sb: Seq, t_a: float, e0: int, u0: float, prm=None) -> Route:
    import time
    t0 = time.time()
    fw, rv = ctx.fwd, ctx.rev
    i0, k0, _ = sf.locate(t_a)
    run_f = run_direction(ctx, False, sf, i0, k0, e0, u0, prm)
    j0, m0, _ = sb.locate(t_a)
    run_b = run_direction(ctx, True, sb, j0, m0, e0, float(fw.L[e0] - u0), prm)
    tf, Ef, Uf, incf, cf, flf, sgf, kpf, gf, Cf = _extract(run_f, fw, fw, False)
    tb, Eb, Ub, incb, cb, flb, sgb, kpb, gb, Cb = _extract(run_b, rv, fw, True)
    # video order: backward reversed (excluding the anchor step), then forward
    t = np.concatenate([tb[:0:-1], tf]); E = np.concatenate([Eb[:0:-1], Ef]); U = np.concatenate([Ub[:0:-1], Uf])
    inc = np.concatenate([incb[:0:-1], incf]); comp = np.concatenate([cb[:0:-1], cf]); flag = np.concatenate([flb[:0:-1], flf])
    seg = np.concatenate([sgb[:0:-1] * 0 - 1, sgf]); dirn = np.concatenate([-np.ones(len(tb) - 1, int), [0], np.ones(len(tf) - 1, int)])
    xy = np.vstack([fw.xy(E, U)]) if len(E) else np.zeros((0, 2))
    ds_f = np.array([sf.segs[s].ds[k] if s >= 0 else 0 for s, k in zip([h["seg"] for h, i in run_f.path()], [h["k"] for h, i in run_f.path()])])
    ds_b = np.array([sb.segs[s].ds[k] for s, k in zip([h["seg"] for h, i in run_b.path()], [h["k"] for h, i in run_b.path()])])
    km = (ctx.kappa0 * (np.sum(ds_f * kpf) + np.sum(ds_b * kpb))) / 1000.0
    gaps = [(tt, w) for tt, w in gf] + [(tt, w) for tt, w in gb]
    r = Route(t, E, U, xy, inc, comp, flag, seg, dirn, km, t_a, gaps, Cf, Cb, time.time() - t0)
    return r
