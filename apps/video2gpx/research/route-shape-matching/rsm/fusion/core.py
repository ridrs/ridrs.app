# SPDX-License-Identifier: AGPL-3.0-or-later
"""Glue: video inputs (RouteCtx + posterior mean/sd + curve anchors + features) -> measurements -> robust RTS fusion -> position at the requested times."""
from __future__ import annotations

import pickle
from dataclasses import dataclass, field

import numpy as np

from rsm.refine import analyse, load, segment
from rsm.refine import anchors as A

from . import features, gate, posterior, rts


@dataclass
class PostParams:
    infl: float = 3.0       # the posterior means of neighbouring steps share their error: inflate sd to stand for the correlated block
    floor: float = 6.0      # m, the cell grid and model mismatch: added in quadrature to the posterior sd
    bad_sig: float = 80.0   # steps whose path mass < 20 % (fell back to Viterbi) are not used


@dataclass
class Video:
    name: str
    ctx: object
    pm: np.ndarray          # (Tv,) posterior mean at ctx.t_step
    pm_sd: np.ndarray       # (Tv,) posterior sd (NaN: not used)
    src: object
    cand: list
    acc: list               # old merge of cand
    feat: features.Featurizer


def load_video(name: str) -> Video:
    ctx = load.build_ctx(name)
    P = pickle.load(open(posterior.RES / f"post_{name}.pkl", "rb"))
    idx = ctx.extra["idx"]
    pm = P["s_pm"][idx].astype(float); sd = P["sd"][idx].astype(float)
    src, cand, acc, rej = analyse.run_curves(ctx)
    return Video(name, ctx, pm, sd, src, cand, acc, features.Featurizer(ctx, src))


def map_speed(ctx, t: float) -> float:
    return float(ctx.kappa * (ctx.D(t + 1.0) - ctx.D(t - 1.0)) / 2.0)


def anchor_sigma(a: A.Anchor, ctx) -> float:
    """1-sigma (m) of an anchor as a measurement of s: its sig_s and its time uncertainty x map speed, divided by sqrt(quality). Kind-blind."""
    ss = 10.0 if not np.isfinite(a.sig_s) else max(a.sig_s, 2.0)
    st = 0.0 if not np.isfinite(a.sig_t) else a.sig_t * map_speed(ctx, a.t)
    return float(np.sqrt(ss ** 2 + st ** 2) / np.sqrt(max(a.quality, 0.05)))


def gapcum(ctx, t):
    return np.interp(t, ctx.tt, ctx._gapcum)


def fuse(v: Video, anchors: list[A.Anchor], t_out: np.ndarray, fp: rts.FuseParams | None = None, pp: PostParams | None = None, use_post: bool = True) -> dict:
    """-> dict(s, s_sd, k (map m per nominal m), k_sd, nodes..., w_anchor (Huber weights of the anchors), r_anchor)"""
    ctx, fp, pp = v.ctx, fp or rts.FuseParams(), pp or PostParams()
    meas = []
    if use_post:
        ok = np.isfinite(v.pm_sd)
        for t, z, sd in zip(ctx.t_step[ok], v.pm[ok], v.pm_sd[ok]):
            meas.append(rts.Meas(float(t), float(z), float((pp.infl ** 2) * (sd ** 2 + pp.floor ** 2)), "posterior"))
    n_post = len(meas)
    for a in anchors:
        meas.append(rts.Meas(float(a.t), float(a.s), anchor_sigma(a, ctx) ** 2, a.kind))
    t_out = np.asarray(t_out, float)
    nodes = np.unique(np.concatenate([t_out, ctx.t_step, [m.t for m in meas]]))
    nodes = nodes[(nodes >= ctx.t_step[0] - 1e-9) & (nodes <= ctx.t_step[-1] + 1e-9)] if len(nodes) else nodes
    # measurements outside the node range (anchors before the first step) are dropped by the clip above only if not on a node: keep them out
    meas = [m for m in meas if ctx.t_step[0] - 1e-9 <= m.t <= ctx.t_step[-1] + 1e-9]
    D = ctx.D(nodes); G = gapcum(ctx, nodes)
    dm = np.concatenate([[0.0], np.diff(D) * ctx.kappa]); dg = np.concatenate([[0.0], np.diff(G) * ctx.kappa])
    s0 = float(np.interp(nodes[0], ctx.t_step, v.pm))
    res = rts.fuse(nodes, dm, dg, meas, s0, fp)
    xs, Ps = res["xs"], res["Ps"]
    j = np.searchsorted(nodes, t_out)
    j = np.clip(j, 0, len(nodes) - 1)
    out = dict(s=np.clip(xs[j, 0], 0, ctx.path.sg[-1]), s_sd=np.sqrt(Ps[j, 0, 0]), k=xs[j, 1] * ctx.kappa, k_sd=np.sqrt(Ps[j, 1, 1]) * ctx.kappa, nodes=nodes, meas=meas, n_post=n_post, w=res["w"], r=res["r"])
    out["w_anchor"] = out["w"][n_post:]; out["r_anchor"] = out["r"][n_post:]
    return out


def old_method(v: Video, anchors: list[A.Anchor], t) -> np.ndarray:
    ctx = v.ctx
    return segment.position(np.asarray(t, float), anchors, ctx.D, ctx.gapfrac, ctx.kappa, ctx.path.sg[-1])[0]


def pipeline_anchors(v: Video, cand: list[A.Anchor], gated: bool, gp: gate.GateParams | None = None, merged: bool = True):
    """-> (anchors, gate-rejected, merge-rejected, feats)"""
    rej_g, feats = [], []
    base = cand
    if gated:
        base, rej_g, feats = gate.gate(cand, v.feat, gp)
    if merged:
        acc, rej_m = A.merge(base, v.ctx.D, v.ctx.gapfrac, v.ctx.kappa, local_tol=analyse.LOCAL_TOL)
    else:
        acc, rej_m = sorted(base, key=lambda a: a.t), []
    return acc, rej_g, rej_m, feats
