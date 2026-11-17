# SPDX-License-Identifier: AGPL-3.0-or-later
"""Whole-video tracking (rsm.track v2, defaults = work/track/frozen_v2.json) from the anchors of the plausibility stage, without GPS.

Anchors: accepted decisions (frozen tau / margin), merged as in rsm.track.anchors.dedupe. Calibration (angle scale rho0, distance scale kappa0) = robust
medians of the accepted fits of this video (rsm.plaus.decide.estimate_video_level), exactly what rsm.track.anchors.video_cal does for the GPS videos.
Controls: random anchors on the true video; the mirrored video from the true anchors.
"""
from __future__ import annotations

import time

import numpy as np
from scipy.ndimage import uniform_filter1d

from rsm.plaus import data
from rsm.track import anchors as A, consensus as C, graphs, run, tracker, vtrack
from rsm.track.report import good_run

from . import cfg, stages


def anchors_from(decs) -> list:
    out = []
    for r, c, f, _m in decs:
        a = A._anchor_from_trace(f, c, r, "dec")
        if a:
            out.append(a)
    return A.dedupe(out)


def setup(ctx, cal, prm=None, mirror=False, label="refined"):
    """what rsm.track.run.setup does, for a graph that is already loaded (no GPS, no quanta-area json)."""
    fw, rv = graphs.Net.build(ctx.g)
    sn = graphs.Snap(fw)
    tracks = data.vms_tracks(cfg.VIDEO, label)
    sf = vtrack.make_seq(tracks, mirror=mirror)
    sb = vtrack.make_seq(tracks, reverse=True, mirror=mirror)
    tc = tracker.make_ctx(fw, rv, sn, cal["kappa0"], cal["rho0"], prm or tracker.Params())
    return dict(video=cfg.VIDEO, map_video=cfg.VIDEO, g=ctx.g, fw=fw, rv=rv, sn=sn, sf=sf, sb=sb, ctx=tc, cal=cal, tracks=tracks,
                t0=float(tracks[0]["t"][0]), t1=float(tracks[-1]["t"][-1]))


def cluster_table(routes, anchors, cp=C.CParams()):
    cl = C.cluster(routes, cp)
    rows = []
    for mem in cl["clusters"]:
        best = int(min(mem, key=lambda i: cl["cpk"][i]))
        rows.append(dict(members=[int(i) for i in mem], n=len(mem), cpk_mean=float(np.mean(cl["cpk"][mem])), cpk_best=float(cl["cpk"][best]), best=best,
                         good_run_best=good_run(routes[best], cp), anchor_t=[float(anchors[i]["t"]) for i in mem]))
    return cl, rows


def decide(routes, anchors, cp=C.CParams()):
    cl, rows = cluster_table(routes, anchors, cp)
    d = dict(n_routes=len(routes), n_clusters=len(rows), clusters=rows[:8])
    d["support_ratio"] = rows[0]["n"] / rows[1]["n"] if len(rows) > 1 else float("inf")
    d["cost_gap"] = rows[1]["cpk_mean"] - rows[0]["cpk_mean"] if len(rows) > 1 else float("nan")
    lead = routes[rows[0]["best"]]
    tt, x, y, src = C.stitched(routes, rows[0]["members"], cl["grid"])
    d["lead"] = rows[0]["best"]
    d["stitched"] = dict(t=tt, x=x, y=y, src=src)
    return d, cl


def run_all(ctx, recs_true, cal, prm=None, n_random=None, log=print):
    out = {}
    tau, m = stages.frozen()
    decs = stages.decisions(recs_true, tau, m)
    an = anchors_from(decs)
    out["n_decisions"] = len(decs)
    out["anchors"] = an
    log(f"  decisions {len(decs)} -> anchors {len(an)}; cal {cal}")
    S = setup(ctx, cal, prm)
    out["t_range"] = (S["t0"], S["t1"])
    out["vms_s"] = float(sum(s.t[-1] - s.t[0] for s in S["sf"].segs))
    routes, sec = run.track_all(S, an, procs=4, log=log)
    keep = [(a, r) for a, r in zip(an, routes) if r is not None]
    an, routes = [k[0] for k in keep], [k[1] for k in keep]
    out["routes"], out["anchors_tracked"], out["sec_dec"] = routes, an, sec
    if len(routes) >= 1:
        out["decision"], _ = decide(routes, an)
    # random anchors on the true video (control)
    n = n_random or max(len(an), 20)
    ra = A.random_anchors(S["fw"], S["t0"], S["t1"], n, seed=7)
    rr, sec = run.track_all(S, ra, procs=4, log=log)
    keep = [(a, r) for a, r in zip(ra, rr) if r is not None]
    out["random_anchors"], out["random_routes"] = [k[0] for k in keep], [k[1] for k in keep]
    # mirrored video from the true anchors
    Sm = setup(ctx, cal, prm, mirror=True)
    mr, sec = run.track_all(Sm, an, procs=4, log=log)
    keep = [(a, r) for a, r in zip(an, mr) if r is not None]
    out["mirror_anchors"], out["mirror_routes"] = [k[0] for k in keep], [k[1] for k in keep]
    # pooled: true + random (does the true cluster survive 20+ random anchors?)
    if routes:
        pool_r, pool_a = routes + out["random_routes"], an + out["random_anchors"]
        out["pool_dec_random"], _ = decide(pool_r, pool_a)
        out["pool_n_dec"] = len(routes)
    if out["mirror_routes"]:
        out["mirror_decision"], _ = decide(out["mirror_routes"], out["mirror_anchors"])
    if out["random_routes"]:
        out["random_decision"], _ = decide(out["random_routes"], out["random_anchors"])
    return out


def cpk(routes):
    return np.array([r.cost_per_km for r in routes])
