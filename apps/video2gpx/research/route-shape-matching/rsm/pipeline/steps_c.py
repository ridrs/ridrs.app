# SPDX-License-Identifier: AGPL-3.0-or-later
"""Worker of step 6: refinement. Decoded HMM route -> RouteCtx, posterior mean and spread along the path, curve anchors, quality gate, robust RTS fusion (variant (d) of
rsm.fusion), position per video second. Frozen glue: ctx construction (rsm.refine.load.build_ctx), forward-backward with a path callback (rsm.refine.post), fuse and
pipeline_anchors (rsm.fusion.core) are copied here because those modules import research-only code (rsm.hmm.exp creates directories in the repo at import)."""
from __future__ import annotations

import contextlib
import pickle
import resource
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from rsm.fusion import features, gate, rts
from rsm.hmm import grid
from rsm.hmm_cal import dp
from rsm.refine import anchors as A, curves, pathctx, post

from . import align as AL, anchors as AN, config as C, cuts as K, detours as DT, hints as HI, local as L, odofail as OF, tracks as T
from .common import Worker, jdump, jload
from .steps_b import frame_masks, load_map

LOCAL_TOL = 0.35


class PathMoments(post.PathMean):
    """(mean arc, mass on the path, sd of the arc) of the posterior restricted to the path cells (rsm.fusion.posterior.PathMoments)"""

    def __call__(self, j, p):
        w = p[self.cells].astype(np.float64)
        arcs = self.arcs
        if self.multi:
            dd = np.abs(arcs - self.s_ref[j])
            gm = np.minimum.reduceat(dd, self.first)
            grp = np.repeat(np.arange(len(self.first)), np.diff(np.concatenate([self.first, [len(arcs)]])))
            w = w * (dd <= gm[grp] + 1e-9)
        m = w.sum()
        if m <= 1e-12:
            return np.nan, float(m), np.nan
        mu = (w * arcs).sum() / m
        return float(mu), float(m), float(np.sqrt((w * (arcs - mu) ** 2).sum() / m))


def forward_backward_cb(pre, st, cb, progress, start_ok=None, end_ok=None, block: int | None = None):
    """rsm.refine.post.forward_backward_cb with progress (sqrt(T) block-checkpointed, O(N sqrt(T)) memory, bit-identical to full alpha storage)."""
    G = pre.grid
    N, T_ = G.N, st.T
    grid.check_budget(N, T_, bp_bytes=0, alpha_bytes=2, cap_gb=C.HMM_CAP_GB, checkpointed=True)
    NEG = dp.NEG
    if not hasattr(pre, "_border"):
        dp._prep_border(pre)
    a = dp.start_prior(G, np.full(N, -np.log(N), np.float32) if start_ok is None else dp._log_uniform(start_ok))   # + the start frame cost (A30)
    so = dp.STEP_OK_HOOK(G, st, None) if dp.STEP_OK_HOOK else None      # user anchors (anchors.py)
    fb_c = dp._N.FBContext(pre) if dp._N.available() else None
    is_jump = getattr(st, "jump", None)
    B = grid.ckpt_block(T_) if block is None else max(1, int(block))
    use_ckpt = T_ > 1 and B < T_
    if use_ckpt:
        M = (T_ + B - 1) // B
        ckpts = np.empty((M, N), np.float32)
        ckpts[0] = a
        for j in range(1, T_):
            a, _ = dp._fb_fwd_step(pre, fb_c, G, st, a, j, is_jump, so)
            if j % B == 0:
                ckpts[j // B] = a
            if j % 20 == 0:
                progress(35.0 * j / T_)
        al = None
    else:
        al = np.empty((T_, N), np.float16)
        al[0] = a
        for j in range(1, T_):
            a, _ = dp._fb_fwd_step(pre, fb_c, G, st, a, j, is_jump, so)
            al[j] = np.maximum(a, -60000).astype(np.float16)
            if j % 20 == 0:
                progress(50.0 * j / T_)
    out = [None] * T_
    beta = np.zeros(N, np.float32) if end_ok is None else np.where(end_ok, np.float32(0), NEG).astype(np.float32)
    e_lp = dp.end_prior(G)                       # the end frame cost (A30)
    if e_lp is not None:
        beta = (beta + e_lp).astype(np.float32)
    if use_ckpt:
        block_al = np.empty((B, N), np.float16)
        for b in range(M - 1, -1, -1):
            t0 = b * B
            t1 = min(t0 + B, T_)
            a_blk = ckpts[b]
            block_al[0] = a_blk if t0 == 0 else np.maximum(a_blk, -60000).astype(np.float16)
            for j in range(t0 + 1, t1):
                a_blk, _ = dp._fb_fwd_step(pre, fb_c, G, st, a_blk, j, is_jump, so)
                block_al[j - t0] = np.maximum(a_blk, -60000).astype(np.float16)
            for j in range(t1 - 1, t0 - 1, -1):
                if so and j in so:
                    beta = np.where(so[j], beta, NEG).astype(np.float32)
                g_ = block_al[j - t0].astype(np.float32) + beta
                p = np.exp(g_ - g_.max())
                p /= p.sum()
                out[j] = cb(j, p)
                if j == 0:
                    break
                beta = dp._fb_bwd_step(pre, fb_c, G, st, beta, j, is_jump)
                if j % 20 == 0:
                    progress(35.0 + 65.0 * (T_ - j) / T_)
    else:
        for j in range(T_ - 1, -1, -1):
            if so and j in so:
                beta = np.where(so[j], beta, NEG).astype(np.float32)
            g_ = al[j].astype(np.float32) + beta
            p = np.exp(g_ - g_.max())
            p /= p.sum()
            out[j] = cb(j, p)
            if j == 0:
                break
            beta = dp._fb_bwd_step(pre, fb_c, G, st, beta, j, is_jump)
            if j % 20 == 0:
                progress(50.0 + 50.0 * (T_ - j) / T_)
    return out


@dataclass
class Video:
    ctx: object
    pm: np.ndarray
    pm_sd: np.ndarray
    src: object
    cand: list
    feat: features.Featurizer


@dataclass
class PostParams:
    infl: float = 3.0
    floor: float = 6.0


def map_speed(ctx, t):
    return float(ctx.kappa * (ctx.D(t + 1.0) - ctx.D(t - 1.0)) / 2.0)


def anchor_sigma(a, ctx):
    ss = 10.0 if not np.isfinite(a.sig_s) else max(a.sig_s, 2.0)
    st = 0.0 if not np.isfinite(a.sig_t) else a.sig_t * map_speed(ctx, a.t)
    return float(np.sqrt(ss ** 2 + st ** 2) / np.sqrt(max(a.quality, 0.05)))


def hold_still(nodes, dm, dg, meas, still):
    """sure standstill (standstill.py): no map or gap distance on the steps into nodes inside a span (no process noise: the position is held) and no measurement
    strictly inside one (the cell posterior and the alignment walk the 4-m / 30-m grid through it). In place on dm / dg -> meas kept"""
    if not still:
        return meas
    nodes = np.asarray(nodes, float)
    inside = np.zeros(len(nodes), bool)
    for a, b in still:
        inside |= (nodes > a + 1e-9) & (nodes <= b + 1e-9)
    dm[inside] = 0.0
    dg[inside] = 0.0
    return [m for m in meas if not any(a + 1e-9 < m.t < b - 1e-9 for a, b in still)]


def fine_profile(csv: str):
    """cumulative vms distance per pair (usable pairs only, rejected ones filled from their neighbours, never negative) -> (t, F); relative units, only its
    shape inside one step is used. Finer than the 4-m track samples, which put a whole stop into one sample and so still gave a flat speed over it."""
    from rsm.odometry import gating
    from rsm.odometry.vms_csv import load_pairs
    from rsm.farrot import series as fser
    p = load_pairs(csv)
    ok = gating.pair_flags(p) == 0
    if ok.sum() < 2:
        return None
    sp = np.maximum(np.nan_to_num(fser._fill(np.where(ok, p.rel_speed, np.nan))), 0.0)
    t = np.concatenate([p.time - p.dt / 2, [p.time[-1] + p.dt / 2]])
    return t, np.concatenate([[0.0], np.cumsum(sp)])


def shaped_D(ctx, t) -> np.ndarray:
    """ctx.D with the time profile of the odometry INSIDE every step (per-pair profile ctx.extra["fine"] if set, else the 4-m track samples): ctx.D is linear in time between two step times (30 / 15 m nominal), so a stop or a
    slow-down inside one step is spread evenly over it (Madone 23:45 and 42:22: 2.2-2.4 m/s flat for 16 s while the video says 0.4 m/s). Here a step whose
    two ends lie in the same vms track gets its distance mu distributed like the track's own distance over time (4 m samples). With the per-pair profile
    every step is shaped, gap steps too (Madone 43:50: the stop reads -0.04 m/s, those pairs are rejected and split the track, so the stop lies in a gap
    step); rejected pairs carry the speed filled from their neighbours, the same assumption the gap distance makes. The value at every step time, and so
    every step total, is unchanged; scene cuts are handled after this by cut_process."""
    t = np.asarray(t, float)
    base = ctx.D(t)
    if not C.FUSE_SHAPE_STEPS:
        return base
    st_t, mu, gap = np.asarray(ctx.st.t, float), np.asarray(ctx.st.mu, float), np.asarray(ctx.st.gap, bool)
    out = base.copy()
    fine = (getattr(ctx, "extra", None) or {}).get("fine")
    i = np.clip(np.searchsorted(st_t, t, side="right") - 1, 0, len(st_t) - 2)
    ta, tb = st_t[i], st_t[i + 1]
    if fine is not None:
        Te, Se = fine
        m = (ta >= Te[0]) & (tb <= Te[-1]) & (tb > ta) & (mu[i + 1] > 0)
        fa, fb, fn = np.interp(ta[m], Te, Se), np.interp(tb[m], Te, Se), np.interp(t[m], Te, Se)
        ok = fb - fa > 1e-9
        k = np.flatnonzero(m)[ok]
        out[k] = ctx.D(ta[k]) + mu[i[k] + 1] * np.clip((fn[ok] - fa[ok]) / (fb[ok] - fa[ok]), 0.0, 1.0)
        return out
    for tr in ctx.tracks or []:
        T, S = np.asarray(tr["t"], float), np.asarray(tr["s"], float)
        if len(T) < 2:
            continue
        m = (t >= T[0]) & (t <= T[-1]) & (ta >= T[0] - 1e-6) & (tb <= T[-1] + 1e-6) & (tb > ta) & ~gap[i + 1] & (mu[i + 1] > 0)
        if not m.any():
            continue
        Te, Se = T + 1e-9 * np.arange(len(T)), S
        fa, fb, fn = np.interp(ta[m], Te, Se), np.interp(tb[m], Te, Se), np.interp(t[m], Te, Se)
        ok = fb - fa > 1e-6
        k = np.flatnonzero(m)[ok]
        frac = np.clip((fn[ok] - fa[ok]) / (fb[ok] - fa[ok]), 0.0, 1.0)
        out[k] = ctx.D(ta[m][ok]) + mu[i[k] + 1] * frac
    return out


def _span_mask(t: np.ndarray, spans) -> np.ndarray:
    m = np.zeros(len(t), bool)
    for x in spans:
        m |= (t >= x["t0"]) & (t <= x["t1"])
    return m


def grid_flags(t, lo, hi, post_, prior_dec, kept, gap_spans, cut_spans, still):
    """the per-time flags of a result grid (the 1 s grid and the GPX raster use the same rules) -> (conf, extrap, in_gap, in_still, in_prior).
    lo, hi: decoded span; post_: route posterior (t, p_vit); prior_dec / kept: stretches of the local pass ({t0, t1}); gap_spans: (t_prev, t) of every vms gap step;
    cut_spans: scene cuts (ta, tb, ...); still: sure standstills (t0, t1)."""
    t = np.asarray(t, float)
    okp = np.isfinite(post_["p_vit"])
    extrap = (t < lo) | (t > hi)
    conf = np.where(extrap, 0.0, np.interp(t, post_["t"][okp], post_["p_vit"][okp]))
    # A3: where only the road-class prior of the local pass decided between two parallel streets, the position is not known from the video: confidence <= 0.5
    in_prior = _span_mask(t, prior_dec) & ~extrap
    conf = np.where(in_prior, np.minimum(conf, C.PRIOR_DECIDED_CONF), conf)
    in_kept = _span_mask(t, kept)                     # acceptance test of the local pass: the search route was kept against another road
    conf = np.where(in_kept & ~extrap, np.minimum(conf, C.LOCAL_KEPT_CONF), conf)
    in_gap = np.zeros(len(t), bool)
    for a, b in gap_spans:
        in_gap |= (t > a) & (t <= b)
    for ta, tb, *_ in cut_spans:                      # a cut: up to the first whole second after the jump is marked too (the position is not continuous there)
        in_gap |= (t > ta) & (t <= np.ceil(tb))
    in_still = np.zeros(len(t), bool)                 # sure standstill: the position is held (measured, not a gap)
    for a, b in still:
        in_still |= (t >= a) & (t <= b)
    in_gap &= ~in_still
    return conf, extrap, in_gap, in_still, in_prior


def fuse(v: Video, anchors, t_out, fp=None, pp=None, extra=None, cut_spans=None, still=None):
    """rsm.fusion.core.fuse. extra (optional): list of (t, s, sd) position measurements of the dense heading alignment, added to the posterior and anchors.
    cut_spans (optional, rsm.pipeline.cuts.spans): (ta, tb[, tc, v]) of every scene cut. From ta to the cut tc the riding goes on at the speed v of the last
    step, then the position is held (no distance, no measurements inside (ta, tb)) and at tb
    it jumps with sd CUT_FUSE_SD_M: no smoothing and no distance prior across a cut. None / []: unchanged.
    still (optional): sure standstill spans [(t0, t1)]; their ends are nodes and the position is held between them (hold_still)."""
    ctx, fp, pp = v.ctx, fp or rts.FuseParams(), pp or PostParams()
    meas = []
    ok = np.isfinite(v.pm_sd)
    # on straights the cell posterior is only dead reckoning at the global kappa and pins rho back to 1 between curve anchors (town lateness, FINDINGS
    # "Timing in town"): there it is thinned to one measurement per POST_STRAIGHT_EVERY_M and inflated by POST_STRAIGHT_INFL; in turns it is kept as it was
    straight = np.zeros(int(ok.sum()), bool)
    if C.POST_STRAIGHT_EVERY_M > 0:
        from . import align as AL
        phs = AL.path_heading(ctx.path.xy, C.ALIGN_SMOOTH_M)
        hw = int(C.ALIGN_TURN_HALF_M)
        si = np.clip(np.rint(v.pm[ok]).astype(int), 0, len(phs) - 1)
        straight = np.degrees(np.abs(phs[np.minimum(si + hw, len(phs) - 1)] - phs[np.maximum(si - hw, 0)])) < C.ALIGN_TURN_DEG
    last = -1e18
    for t, z, sd, stg in zip(ctx.t_step[ok], v.pm[ok], v.pm_sd[ok], straight):
        R = float((pp.infl ** 2) * (sd ** 2 + pp.floor ** 2))
        if stg:
            if z - last < C.POST_STRAIGHT_EVERY_M:
                continue
            R *= C.POST_STRAIGHT_INFL ** 2
        last = z
        meas.append(rts.Meas(float(t), float(z), R, "posterior"))
    if extra is not None:
        meas += [rts.Meas(float(t), float(z), float(sd) ** 2, "align") for t, z, sd in extra]
    n_post = len(meas)
    for a in anchors:
        meas.append(rts.Meas(float(a.t), float(a.s), anchor_sigma(a, ctx) ** 2, a.kind))
    t_out = np.asarray(t_out, float)
    nodes = np.unique(np.concatenate([t_out, ctx.t_step, [m.t for m in meas], np.ravel(still) if still else []]))
    nodes = nodes[(nodes >= ctx.t_step[0] - 1e-9) & (nodes <= ctx.t_step[-1] + 1e-9)]
    meas = [m for m in meas if ctx.t_step[0] - 1e-9 <= m.t <= ctx.t_step[-1] + 1e-9]
    D = shaped_D(ctx, nodes)
    G = np.interp(nodes, ctx.tt, ctx._gapcum)
    dm = np.concatenate([[0.0], np.diff(D) * ctx.kappa])
    dg = np.concatenate([[0.0], np.diff(G) * ctx.kappa])
    meas = cut_process(nodes, dm, dg, meas, cut_spans, fp.gap_rel, ctx.kappa)
    meas = hold_still(nodes, dm, dg, meas, still)
    s0 = float(np.interp(nodes[0], ctx.t_step, v.pm))
    res = rts.fuse(nodes, dm, dg, meas, s0, fp)
    xs, Ps = res["xs"], res["Ps"]
    j = np.clip(np.searchsorted(nodes, t_out), 0, len(nodes) - 1)
    s_out = np.clip(xs[j, 0], 0, ctx.path.sg[-1])
    # Clamp each cut piece to its own connected arc interval so RTS never bleeds across a disconnected free-jump seam
    breaks = tuple(getattr(ctx.path, "breaks", ()))
    if breaks and cut_spans:
        arc_edges = [0.0, *breaks, float(ctx.path.sg[-1])]
        t_cuts = sorted(float(sp[1]) for sp in cut_spans)
        t_out_a = np.asarray(t_out, float)
        t_bounds = [-np.inf, *t_cuts, np.inf]
        for ta_p, tb_p in zip(t_bounds[:-1], t_bounds[1:]):
            m = (t_out_a >= ta_p) & (t_out_a < tb_p)
            if not m.any():
                continue
            s_ref = float(np.median(np.interp(t_out_a[m], ctx.t_step, ctx.s_vit)))
            pi = min(max(int(np.searchsorted(arc_edges, s_ref, side="right")) - 1, 0), len(arc_edges) - 2)
            lo_s = arc_edges[pi] + (1e-3 if pi > 0 else 0.0)
            hi_s = arc_edges[pi + 1] - (1e-3 if pi + 1 < len(arc_edges) - 1 else 0.0)
            if lo_s < hi_s:
                s_out[m] = np.clip(s_out[m], lo_s, hi_s)
    return dict(s=s_out, s_sd=np.sqrt(Ps[j, 0, 0]), n_post=n_post)


def cut_process(nodes, dm, dg, meas, cut_spans, gap_rel: float, kappa: float = 1.0):
    """smoother inputs at scene cuts, in place on dm / dg: inside (ta, tb] riding at kappa x v up to the cut tc (spans with 4 entries), then no distance, and a
    free jump (sd CUT_FUSE_SD_M) at the last node; measurements strictly inside (ta, tb) are dropped (they lie on the decoder's walk through the jump).
    Returns the measurements kept."""
    for sp in cut_spans or []:
        ta, tb = sp[0], sp[1]
        meas = [m for m in meas if not (ta + 1e-9 < m.t < tb - 1e-9)]
        inside = (nodes > ta + 1e-9) & (nodes <= tb + 1e-9)
        dm[inside] = 0.0
        dg[inside] = 0.0
        if len(sp) >= 4 and sp[3] > 0:
            tc = sp[2]
            ride = np.flatnonzero(inside & (nodes <= tc + 1e-9))
            prev = np.maximum(ride - 1, 0)
            dm[ride] = kappa * sp[3] * (nodes[ride] - nodes[prev])
        jn = np.flatnonzero(inside)
        if len(jn):
            dg[jn[-1]] = C.CUT_FUSE_SD_M / gap_rel                      # process noise (gap_rel x dg)^2 = CUT_FUSE_SD_M^2 at the jump node
    return meas


def gated_anchors(v: Video):
    base, rej_g, feats = gate.gate(v.cand, v.feat)
    acc, rej_m = A.merge(base, v.ctx.D, v.ctx.gapfrac, v.ctx.kappa, local_tol=LOCAL_TOL)
    return acc, rej_g, rej_m


def build_ctx(g, E, st, tracks, route: dict):
    k = route["kappa"]
    h = route.get("h", C.H * k)
    idx = pathctx.step_index(st.t, route["step_t"])
    ok = np.zeros(st.T, bool)
    ok[idx] = True
    cell_edge, cell_off = pathctx.cell_layout(g, E, h)
    c = route["step_cell"]
    path, s = pathctx.build_path(g, cell_edge[c], cell_off[c])
    ctx = pathctx.RouteCtx("video", path, st, ok, st.t[idx], s, None, cell_edge[c], float(k), float(route["a_ang"]), tracks)
    ctx.extra.update(idx=idx, g=g, mass=None)
    return ctx, cell_edge, cell_off


def align_pieces(sg, xy, tracks, kappa, a_ang, t_prior, s_prior, gap_nom=None):
    """align.align, run separately on every piece between scene cuts (tracks with `cut_before` start a piece): the alignment never advances through a cut
    as if riding. When `xy` has disconnected cut seams (> 5 m jump between adjacent 1 m samples), each piece is restricted to its own connected arc slice.
    Without cuts: exactly align.align."""
    starts = [0] + [i for i, tr in enumerate(tracks) if i > 0 and tr.get("cut_before") is not None] + [len(tracks)]
    if len(starts) == 2:
        return AL.align(sg, xy, tracks, kappa, a_ang, t_prior, s_prior, gap_nom)
    br = np.flatnonzero(np.hypot(*np.diff(np.asarray(xy, float), axis=0).T) > 5.0) + 1
    seg_bounds = [0] + [int(x) for x in br] + [len(sg)]
    parts = []
    for a, b in zip(starts[:-1], starts[1:]):
        sub_tr = tracks[a:b]
        sub_gn = None if gap_nom is None else gap_nom[a:b]
        if len(br) > 0 and sub_tr:
            s_ref = float(np.interp(float(sub_tr[0]["t"][0]), t_prior, s_prior))
            pi = 0
            for idx_p, (ia, ib) in enumerate(zip(seg_bounds[:-1], seg_bounds[1:])):
                if sg[ia] <= s_ref <= sg[ib - 1] + 1.0:
                    pi = idx_p
                    break
            ia, ib = seg_bounds[pi], seg_bounds[pi + 1]
            off = float(sg[ia])
            p = AL.align(sg[ia:ib] - off, xy[ia:ib], sub_tr, kappa, a_ang, t_prior, s_prior - off, sub_gn)
            if p is not None:
                p["s"] = p["s"] + off
                if "s_mean" in p:
                    p["s_mean"] = p["s_mean"] + off
        else:
            p = AL.align(sg, xy, sub_tr, kappa, a_ang, t_prior, s_prior, sub_gn)
        if p is not None:
            parts.append(p)
    if not parts:
        return None
    post = {k: np.concatenate([p[k] for p in parts]) for k in ("s_mean", "s_sd") if all(k in p for p in parts)}
    return dict(**post, t=np.concatenate([p["t"] for p in parts]), s=np.concatenate([p["s"] for p in parts]), n_obs=sum(p["n_obs"] for p in parts),
                n_gaps=sum(p["n_gaps"] for p in parts), n_gaps_measured=sum(p["n_gaps_measured"] for p in parts), n_pieces=len(parts))


def _paths_searched(d: Path) -> bool:
    """the search map itself held the bike paths (explicit bike profile, steps_b.bike_paths_mode)"""
    return (jload(d / "map" / "map.json").get("bike_paths") or {}).get("mode") == "search"


@contextlib.contextmanager
def _bike_classes(paths: bool):
    """the local pass (local.py) reads C.CLASSES_BIKE for its corridor classes and its road-class prior: when the route was found with bike paths, the local pass
    uses them too (else it would pull the route back onto roads). Process-local: every step runs in its own worker process."""
    old = C.CLASSES_BIKE
    if paths:
        C.CLASSES_BIKE = C.CLASSES_BIKE_PATHS
    try:
        yield
    finally:
        C.CLASSES_BIKE = old


def _refine_vehicle(d: Path) -> str:
    """the vehicle decided by route_search (calibration-corrected in vehicle_final.json), falling back to rotation/vehicle.json"""
    vf = d / "route_search" / "vehicle_final.json"
    if vf.exists():
        v = jload(vf).get("vehicle")
        if v:
            return str(v)
    return str(jload(d / "rotation" / "vehicle.json")["effective"])


def inserted_spans(d: Path) -> list[tuple[float, float]]:
    """inserted shots between scene cuts (rotation/cuts.json `inserted`, after a skipped intro): (t0, t1) of each, held at 0 km/h"""
    f = d / "rotation" / "cuts.json"
    if not f.exists():
        return []
    c = jload(f)
    return [(float(x["t0"]), float(x["t1"])) for x in c.get("inserted") or [] if float(x["t1"]) > float(x["t0"])]


def refine(d: Path, P: dict, W: Worker):
    out = d / "refine"
    out.mkdir(exist_ok=True)
    t0 = time.time()
    tracks = pickle.load(open(d / "rotation" / "tracks.pkl", "rb"))
    csv = str(d / "motion" / "motion.csv")
    tracks, _, still = OF.apply_still(tracks, csv)    # sure standstills: tracks split there (no phantom distance / heading), same as every route-side step
    st = OF.route_steps(d, tracks)
    g, E = load_map(d, "real")
    route = pickle.load(open(d / "route_search" / "route.pkl", "rb"))
    AN.activate((route.get("anchors") or {}).get("used"))     # the user anchors kept by route_search: masks of every decode below (anchors.py)
    if P.get("hint"):                            # A28: the distance to the route hint costs in every decode below (local pass, islands, posterior)
        HI.start_cost(P, g.crs)
    else:
        HI.activate_cost(None)
    HI.activate_frame_cost(route.get("cons"), getattr(g, "crs", None))  # A30: the start / end frame cost of the route search in every decode below
    if route.get("edge_set") == "full":          # the hint fallback decoded on the full search frame
        E = np.load(d / "map" / "edges_full.npy")
    elif route.get("edge_set") == "paths":       # the bike-path fallback decoded on the map with paths (steps_b.route_search)
        g, E = load_map(d, "paths")
    veh = _refine_vehicle(d)
    # local pass: corridor with all road classes and finer steps (local.py); progress 0-30 %
    local_info, P0, gap_nom = None, 30.0 if C.LOCAL_ON else 0.0, None
    if C.LOCAL_ON:
        gap_nom = T.gap_nominal(csv, tracks)
        gap_nom = [x if x is not None else g for x, g in zip(OF.still_gap_nominal(csv, tracks, still), gap_nom)]
        with _bike_classes(route.get("edge_set") == "paths" or _paths_searched(d)):
            res_l, local_info = L.local_pass(d, P, W, g, E, tracks, route, veh, lambda f, lab: W.progress(P0 * f, "local " + lab), gap_nom=gap_nom)
        local_info["gaps_measured"] = int(sum(x is not None for x in gap_nom[1:]))
        if res_l is not None:
            route, g, E, st = res_l
            ch = local_info["changed_share"]
            W.log("info", f"local pass: {local_info['corridor_edges']} corridor edges ({local_info['corridor_km']:.0f} road km, all classes), {local_info['steps']} steps of "
                          f"{C.LOCAL_D0:.0f} m nominal; {100 * ch:.0f} % of the route moved by more than {C.LOCAL_SAME_M:.0f} m (at most {local_info['changed_max_m']:.0f} m), "
                          f"{local_info['seconds']:.0f} s")
            W.status("local_pass", "good", ch, f"route checked again in a {C.LOCAL_BUF_M:.0f} m corridor with all streets and {C.LOCAL_D0:.0f} m steps: "
                     + (f"{100 * ch:.0f} % of the route corrected (up to {local_info['changed_max_m']:.0f} m)" if ch >= 0.005 else "no change"))
            for x in local_info.get("accept_tested") or []:
                W.log("info", f"local pass acceptance {x['t0']:.0f}-{x['t1']:.0f} s: margin {x['margin_nats']:.1f} nats, {x['landmarks']} strong turns, unexplained local "
                              f"{x['unexplained_local']} / search {x['unexplained_search']}: {'local route accepted' if x['accepted'] else 'search route kept'}")
            if local_info.get("kept_search"):
                mmss = lambda t: f"{int(t) // 60}:{int(t) % 60:02d}"
                ks = local_info["kept_search"]
                W.status("route_disputed", "difficult", float(sum(x["t1"] - x["t0"] for x in ks)),
                         "two roads fit the video here; the route of the search was kept because the other one leaves strong turns unexplained or is not clearly better: "
                         + "; ".join(f"{mmss(x['t0'])}-{mmss(x['t1'])} (alternative: {x['name_local'] or 'unnamed road'})" for x in ks[:5]))
        else:
            W.status("local_pass", "difficult", None, "the route could not be checked again with all streets; the result of the route search is used")
    prog = lambda p_, lab, force=True: W.progress(P0 + (100.0 - P0) * p_ / 100.0, lab, force=force)
    spans = K.spans(st, tracks)                  # scene cuts (rsm.pipeline.cuts): no smoothing and no alignment across them; [] without cuts
    ctx, cell_edge, cell_off = build_ctx(g, E, st, tracks, route)
    ctx.extra["fine"] = fine_profile(csv)        # per-pair odometry distance over time: shapes the distance inside a step in the fusion (shaped_D)
    k = route["kappa"]
    G = grid.build(g, E, h=route.get("h", C.H * k), sm=10.0 * k,
                   edge_cost=L.minor_cost(g, E, veh) if route.get("local") else None, **C.UTURN)
    assert G.N == len(cell_edge)
    par = dp.Par(a_ang=route["a_ang"], kappa=k, **C.UTURN_PAR)
    pre = dp.prepare(G, par)
    s_full = np.interp(st.t, ctx.t_step, ctx.s_vit)
    cb = PathMoments(ctx.path, cell_edge, cell_off, s_full)
    W.log("info", f"posterior along the path: {G.N} cells x {st.T} steps, path cells {len(cb.cells)}")
    sm, em = frame_masks(g, G, route.get("cons"))
    res = forward_backward_cb(pre, st, cb, lambda p_: prog(0.8 * p_, "posterior", False), sm, em)
    mean = np.array([x[0] for x in res]); mass = np.array([x[1] for x in res]); sd = np.array([x[2] for x in res])
    bad = ~np.isfinite(mean) | (mass < 0.2)
    mean[bad] = s_full[bad]; sd[bad] = np.nan
    idx = ctx.extra["idx"]
    ctx.s_pm = mean[idx]
    prog(82.0, "anchors")
    src = curves.CurveAnchors()
    cand = src.anchors(ctx)
    vid = Video(ctx, mean[idx].astype(float), sd[idx].astype(float), src, cand, features.Featurizer(ctx, src))
    ad, rej_g, rej_m = gated_anchors(vid)
    prog(88.0, "alignment")
    dur = jload(d / "motion" / "summary.json")["duration_s"]
    t_all = np.arange(0.0, np.floor(dur) + 1.0)
    align_info, extra = None, None
    if C.ALIGN_ON:
        t1 = time.time()
        al = align_pieces(ctx.path.sg, ctx.path.xy, tracks, float(k), float(route["a_ang"]), ctx.t_step, ctx.s_vit, gap_nom)
        if al is not None:
            dev = np.abs(al["s"] - np.interp(al["t"], ctx.t_step, ctx.s_vit))
            align_info = dict(n_obs=al["n_obs"], n_gaps=al["n_gaps"], n_gaps_measured=al["n_gaps_measured"], dev_vs_hmm_p50=float(np.median(dev)), dev_vs_hmm_max=float(dev.max()),
                              seconds=time.time() - t1)
            if dev.max() <= C.ALIGN_MAX_DEV_M:
                # only where the path turns (heading change over +-ALIGN_TURN_HALF_M): there the alignment pins the time; on straights it carries no heading
                # information and the cell posterior + curve anchors stay in charge
                phs = AL.path_heading(ctx.path.xy, C.ALIGN_SMOOTH_M)
                hw = int(C.ALIGN_TURN_HALF_M)
                sgi = np.clip(np.rint(al["s"]).astype(int), 0, len(phs) - 1)
                turn = np.degrees(np.abs(phs[np.minimum(sgi + hw, len(phs) - 1)] - phs[np.maximum(sgi - hw, 0)]))
                keep, last = [], -1e9
                if AL.meas_mode(P) == "posterior" and "s_sd" in al:
                    # every sample, weighted by how sure the heading alignment is there (align.band_posterior): curves of any size pin the time, straights drop out
                    # position = the Viterbi path (the posterior mean trails it by ~10 m on long climbs), weight = the posterior spread; samples far from the
                    # HMM route are dropped (a wrong alignment start is confidently wrong, e.g. Grimone 0-70 s)
                    sdm = np.sqrt(al["s_sd"] ** 2 + C.ALIGN_POST_FLOOR_M ** 2) * C.ALIGN_POST_INFL
                    far = np.abs(al["s"] - np.interp(al["t"], ctx.t_step, ctx.s_vit)) > C.ALIGN_POST_GATE_M
                    for t_, s_, sd_, raw, f_ in zip(al["t"], al["s"], sdm, al["s_sd"], far):
                        if not f_ and raw <= C.ALIGN_POST_MAX_SD_M and s_ - last >= C.ALIGN_MEAS_EVERY_M:
                            keep.append((t_, s_, float(sd_))); last = s_
                else:
                    for t_, s_, tu in zip(al["t"], al["s"], turn):
                        if tu >= C.ALIGN_TURN_DEG and s_ - last >= C.ALIGN_MEAS_EVERY_M:
                            keep.append((t_, s_, C.ALIGN_MEAS_SD_M)); last = s_
                extra = keep
                align_info["used"] = True
                W.log("info", f"dense heading alignment: {al['n_obs']} samples on the path, {len(keep)} position measurements; differs from the HMM route by "
                              f"{align_info['dev_vs_hmm_p50']:.0f} m (median), {align_info['dev_vs_hmm_max']:.0f} m (max); {align_info['seconds']:.1f} s")
            else:
                align_info["used"] = False
                W.log("warn", f"dense heading alignment rejected: {dev.max():.0f} m away from the HMM route (limit {C.ALIGN_MAX_DEV_M:.0f} m)")
    prog(92.0, "fusion")
    # inserted shots between cuts (detours.py): held at 0 km/h like a sure standstill; the spans of the fusion, the flags and the output from here on
    ins = inserted_spans(d) if C.SKIP_ON else []
    still, still_kind = DT.merge_spans(list(still) + ins, [DT.KIND["standstill"]] * len(still) + [DT.KIND["insert"]] * len(ins))
    edges = np.array(sorted({float(x) for sp in still for x in sp}), float)
    edges = edges[(edges >= t_all[0]) & (edges <= t_all[-1])] if len(edges) else edges
    t_fuse = np.unique(np.concatenate([t_all, edges]))
    fd = fuse(vid, ad, t_fuse, extra=extra, cut_spans=spans, still=still)
    fd_e = {k: (np.interp(edges, t_fuse, fd[k]) if len(edges) else np.zeros(0)) for k in ("s", "s_sd")}   # t_fuse contains the edges: exact values
    ix = np.searchsorted(t_fuse, t_all)
    fd = dict(fd, s=fd["s"][ix], s_sd=fd["s_sd"][ix])
    lo, hi = float(ctx.t_step[0]), float(ctx.t_step[-1])
    post_ = route["post"]
    okp = np.isfinite(post_["p_vit"])
    prior_dec = (local_info or {}).get("prior_decided") or []
    gap_spans = [(float(st.t[j - 1]), float(st.t[j])) for j in np.flatnonzero(st.gap) if j > 0]
    flags = lambda t: grid_flags(t, lo, hi, post_, prior_dec, (local_info or {}).get("kept_search") or [], gap_spans, spans, still)
    # the GPX raster (C.GPX_HZ points per video second): the smoother is run a second time with these times as nodes, so the points between two seconds
    # follow the measured motion; the 1 s arrays above stay as they were (validation, benchmarks and the analysis stage read them per second)
    t_gx = np.arange(int(np.floor(dur)) * C.GPX_HZ + 1) / C.GPX_HZ
    if C.GPX_HZ > 1:
        fx = fuse(vid, ad, t_gx, extra=extra, cut_spans=spans, still=still)
        s_gx, sd_gx = fx["s"], fx["s_sd"]
    else:
        s_gx, sd_gx = fd["s"], fd["s_sd"]
    lo_s, hi_s = (np.array([a for a, _ in still], float), np.array([b for _, b in still], float)) if still else (np.zeros(0), np.zeros(0))
    e_s = dict(zip(edges.tolist(), fd_e["s"].tolist()))
    e_sd = dict(zip(edges.tolist(), fd_e["s_sd"].tolist()))
    sv = ctx.s_baseline(t_all[~((t_all < lo) | (t_all > hi))])
    sh = np.abs(fd["s"][~((t_all < lo) | (t_all > hi))] - sv)
    path = ctx.path
    oi = np.clip(np.searchsorted(path.start, path.sg, side="right") - 1, 0, len(path.occ) - 1)
    eo = np.asarray(path.occ)[oi]                                       # edge per path metre: cross-section tags for the lane model (gpx step, rsm.pipeline.lane)
    per_m = dict(xy=path.xy, oneway=np.asarray(g.edge_oneway)[path.occ][oi], tunnel=path.tunnel, bridge=np.asarray(g.edge_bridge, bool)[path.occ][oi],
                 highway=np.asarray(g.edge_highway).astype(str)[eo])
    for k_, fill, dt in (("width", np.nan, np.float32), ("lanes", 0, np.int8), ("lanes_fwd", 0, np.int8), ("roundabout", False, bool), ("marked", -1, np.int8), ("cycle", 0, np.int8)):
        a_ = getattr(g, "edge_" + k_, None)
        per_m[k_] = np.asarray(a_, dt)[eo] if a_ is not None else np.full(len(eo), fill, dt)
    sg_out = path.sg
    # detours (detours.py): the path leaves a junction and comes back to it, the video turns round: cut out of the path, the position held at the junction
    det = DT.find(g.edge_u, g.edge_v, path.occ, path.start, t_gx, s_gx, ctx.st.t, ctx.st.dth) if C.SKIP_ON else []
    det = [x for x in det if not any(x["t0"] < b and x["t1"] > a for a, b in still)]     # never across a standstill or an insert
    if det:
        arcs = [(x["s0"], x["s1"]) for x in det]
        sg_out, per_m, shifts = DT.excise(path.sg, per_m, arcs)
        for x, sh_ in zip(det, shifts):
            x["s0_out"] = float(DT.remap(np.array([x["s0"]]), arcs, shifts)[0])
            x["shift_m"] = sh_
        def hold(t_, s_):
            s_ = DT.remap(s_, arcs, shifts)
            for x in det:
                s_ = np.where((t_ >= x["t0"]) & (t_ <= x["t1"]), x["s0_out"], s_)
            return s_
        fd = dict(fd, s=hold(t_all, fd["s"]))
        s_gx = hold(t_gx, s_gx)
        e_s = {k_: float(DT.remap(np.array([v_]), arcs, shifts)[0]) for k_, v_ in e_s.items()}
        for x in det:
            for te in (x["t0"], x["t1"]):
                e_s[te] = x["s0_out"]
                e_sd[te] = float(np.interp(te, t_gx, sd_gx))
        still, still_kind = DT.merge_spans(list(still) + [(x["t0"], x["t1"]) for x in det], list(still_kind) + [DT.KIND["detour"]] * len(det))
        edges = np.array(sorted(e_s), float)
        lo_s, hi_s = np.array([a for a, _ in still], float), np.array([b for _, b in still], float)
        W.log("info", "detours: " + "; ".join(f"{K.mmss(x['t0'])}-{K.mmss(x['t1'])} {x['length_m']:.0f} m out and back to the same junction, the video turns "
                                               f"{x['odo_turn_deg']:.0f} deg" for x in det) + "; cut out of the route and held at 0 km/h")
    skipped = [dict(kind=DT.KIND_NAME[k_], t0=float(a), t1=float(b)) for (a, b), k_ in zip(still, still_kind) if k_ != DT.KIND["standstill"]]
    for x in skipped:
        dx = next((y for y in det if abs(y["t0"] - x["t0"]) < 1e-6), None)
        if dx is not None:
            x.update(length_m=round(dx["length_m"], 1), odo_turn_deg=round(dx["odo_turn_deg"], 1))
    if skipped:
        W.status("skipped", "good", float(sum(x["t1"] - x["t0"] for x in skipped)), "parts of the video that are not part of the route are held at 0 km/h so that "
                 "playback passes over them: " + ", ".join(f"{x['kind']} {K.mmss(x['t0'])}-{K.mmss(x['t1'])}" + (f" ({x['length_m']:.0f} m)" if "length_m" in x else "")
                                                         for x in skipped[:8]) + (f" and {len(skipped) - 8} more" if len(skipped) > 8 else ""))
    conf, extrap, in_gap, in_still, in_prior = flags(t_all)
    conf_gx, extrap_gx, in_gap_gx, in_still_gx, _ = flags(t_gx)
    prior_share = float(in_prior.sum() / max(int((~extrap).sum()), 1))
    if prior_dec:
        mmss = lambda t: f"{int(t) // 60}:{int(t) % 60:02d}"
        W.status("parallel_street", "difficult", prior_share, "the video cannot tell two parallel streets apart; the main road was assumed: "
                 + "; ".join(f"{mmss(x['t0'])}-{mmss(x['t1'])} {x['name_with'] or 'unnamed road'} (alternative: {x['name_without'] or 'unnamed road'})" for x in prior_dec[:5])
                 + (f" and {len(prior_dec) - 5} more" if len(prior_dec) > 5 else ""))
    e_conf = np.where(np.isfinite(edges), np.interp(edges, post_["t"][okp], post_["p_vit"][okp]), 0.0) if len(edges) else np.zeros(0)
    e_c = dict(zip(edges.tolist(), e_conf.tolist()))
    lane = {k_: per_m[k_] for k_ in ("highway", "width", "lanes", "lanes_fwd", "roundabout", "marked", "cycle")}
    still_out = dict(still_t0=lo_s, still_t1=hi_s, still_s0=np.array([e_s.get(a, np.nan) for a in lo_s]), still_s1=np.array([e_s.get(b, np.nan) for b in hi_s]),
                     still_sd=np.array([e_sd.get(a, np.nan) for a in lo_s]), still_conf=np.array([e_c.get(a, 0.0) for a in lo_s]), in_still=in_still,
                     still_kind=np.array(still_kind, np.int8))
    np.savez_compressed(out / "result.npz", t=t_all, s=fd["s"], s_sd=fd["s_sd"], conf=conf, extrap=extrap, in_gap=in_gap, **still_out, sg=sg_out, xy=per_m["xy"], oneway=per_m["oneway"], tunnel=per_m["tunnel"],
                        bridge=per_m["bridge"], crs=np.array(g.crs), **lane,
                        gx_hz=np.array(C.GPX_HZ), gx_t=t_gx, gx_s=s_gx, gx_s_sd=sd_gx, gx_conf=conf_gx, gx_extrap=extrap_gx, gx_in_gap=in_gap_gx, gx_in_still=in_still_gx)
    summ = dict(anchors_candidates=len(cand), anchors_gate_rejected=len(rej_g), anchors_merge_rejected=len(rej_m), anchors_used=len(ad), span_s=[lo, hi], path_km=float((sg_out[-1] - sg_out[0]) / 1000) if det else float(path.length / 1000),
                n_points=int(len(t_all)), n_extrapolated=int(extrap.sum()), n_in_gap=int(in_gap.sum()), conf_mean=float(conf[~extrap].mean()) if (~extrap).any() else 0.0,
                sd_m_quantiles=[float(x) for x in np.percentile(fd["s_sd"][~extrap], [10, 50, 90, 99])] if (~extrap).any() else None,
                fused_vs_viterbi_abs_mean_m=float(sh.mean()), fused_vs_viterbi_p90_m=float(np.percentile(sh, 90)), seconds=time.time() - t0,
                peak_rss_gb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2 ** 30, local=local_info, local_used=bool(route.get("local")), align=align_info,
                prior_decided=prior_dec, prior_decided_share=prior_share,
                still=[[float(a), float(b)] for a, b in still], n_in_still=int(in_still.sum()), skipped=skipped,
                detours=[{k_: (round(v_, 2) if isinstance(v_, float) else v_) for k_, v_ in x.items()} for x in det], gpx_hz=int(C.GPX_HZ), n_gpx_points=int(len(t_gx)))
    if spans:
        summ["cut_spans"] = [[float(x) for x in sp] for sp in spans]
    jdump(out / "summary.json", summ)
    W.progress(100.0, "done", force=True)
    return dict(anchors_used=len(ad), conf_mean=summ["conf_mean"], path_km=summ["path_km"], local_used=summ["local_used"],
                local_changed_share=(local_info or {}).get("changed_share"), prior_decided_share=prior_share)
