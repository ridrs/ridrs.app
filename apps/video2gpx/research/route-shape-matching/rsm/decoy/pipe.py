# SPDX-License-Identifier: AGPL-3.0-or-later
"""The identical pipeline for a real video and for its decoys: vms signal -> quanta -> stage A (chains) -> stage B (plausibility fit, frozen
rule) -> anchors -> tracker (v3 for the GPS videos, v2 as in rsm.nogps for Amalfi) -> one summary per run.

No GPS is read anywhere in a run: all windows of all quanta are used (no in-area mask), the angle / distance start values come from the run's own
accepted fits (fallback: the real run's values, flagged), the speed slope b of the v3 tracker is the real video's fitted value for real and decoys
alike (deviation: a decoy does not refit it). Every run tracks at most `n_anchors` anchors: the frozen decisions first (lowest normalised cost
first), then, if fewer than n_anchors, the lowest-cost fitted candidates ("forced" anchors; they make the test independent of the accept threshold).
Summaries hold only small arrays; the routes themselves are dropped.
"""
from __future__ import annotations

import dataclasses
import time
from types import SimpleNamespace

import numpy as np

from rsm.plaus import data, decide as D, fit as fitmod
from rsm.quanta import evalrun as ev, video
from rsm.quanta.chain import MapIndex
from rsm.nogps import stages

from .signals import Decoy

SETTING = stages.SETTING
N_ANCHORS = 12
BIN_S = 300.0


class Source:
    """duck type of rsm.plaus.pipeline.Source without GPS (see rsm.nogps.stages.Source): all quanta are windowed"""

    def __init__(self, ctx, vid: str, label: str, ix: MapIndex, gi, decoy: Decoy | None = None):
        self.video, self.src, self.ctl, self.map_video = vid, label, (decoy.family if decoy else None), vid
        self.mctx = self.ctx = ctx
        self.ix, self.gi = ix, gi
        if decoy is None:
            self.q = ev.video_q(vid, label, 45.0)
            self.tracks = data.vms_tracks(vid, label)
        else:
            with decoy.active():
                self.q = ev.video_q(vid, label, 45.0)
                self.tracks = data.vms_tracks(vid, label)
        self.tmax = max(float(x["t"][-1]) for x in self.tracks)

    def windows(self, L):
        n = len(self.q["t0"])
        return ev.windows(np.ones(n, bool), L, max(1, L // 4))


def stage_ab(src: Source, key: str, procs: int, log=lambda *a: None) -> list:
    return stages.run_windows(src, key, procs=procs, log=log)


def stageb_summary(recs, tau, m) -> dict:
    best, nacc = [], 0
    for r in recs:
        fs = [f["snorm"] for _, f in D.fits_of(r, SETTING)]
        if fs:
            best.append(min(fs))
        nacc += bool(D.accepted(r, SETTING, tau))
    dec = stages.decisions(recs, tau, m)
    return dict(n_windows=len(recs), n_fitted=len(best), n_accepted=nacc, n_decisions=len(dec), min_snorm=float(min(best)) if best else np.nan,
                median_best_snorm=float(np.median(best)) if best else np.nan, p10_best_snorm=float(np.percentile(best, 10)) if best else np.nan)


def pick_anchors(recs, A, tau, m, n_max=N_ANCHORS):
    """decisions (lowest snorm first, deduped) capped at n_max, topped up with forced anchors (lowest snorm fits)"""
    dec = []
    for r, c, f, _ in stages.decisions(recs, tau, m):
        a = A._anchor_from_trace(f, c, r, "dec")
        if a:
            dec.append(a)
    dec = A.dedupe(dec)
    dec.sort(key=lambda a: a["snorm"])
    out = dec[:n_max]
    n_dec_all = len(dec)
    if len(out) < n_max:
        cand = []
        for r in recs:
            for c, f in D.fits_of(r, SETTING):
                a = A._anchor_from_trace(f, c, r, "forced")
                if a:
                    cand.append(a)
        cand.sort(key=lambda a: a["snorm"])
        for a in cand:
            if len(out) >= n_max:
                break
            if any(abs(a["t"] - b["t"]) < 20.0 and np.hypot(*(a["xy"] - b["xy"])) < 60.0 for b in out):
                continue
            out.append(a)
    return out, n_dec_all


def binned_inc(r, t_max: float) -> np.ndarray:
    nb = int(np.ceil(t_max / BIN_S))
    out = np.full(nb, np.nan)
    b = np.clip((r.t // BIN_S).astype(int), 0, nb - 1)
    for k in np.unique(b):
        out[k] = float(r.inc[b == k].mean())
    return out


def summarize_routes(anchors, routes, TR, t_max) -> dict:
    """per-route rows and the run statistics. TR: module set (track2 or track)."""
    C, good_run = TR["C"], TR["good_run"]
    keep = [(a, r) for a, r in zip(anchors, routes) if r is not None]
    if not keep:
        return dict(n_routes=0, rows=[]), []
    an, rs = [k[0] for k in keep], [k[1] for k in keep]
    rows = [dict(kind=a["kind"], t=float(a["t"]), snorm=float(a["snorm"]), cpk=float(r.cost_per_km), km=float(r.km), good=float(good_run(r)),
                 t0=float(r.t[0]), t1=float(r.t[-1]), bins=binned_inc(r, t_max), n_jumps=int(r.n_jumps), n_off=int(r.n_off)) for a, r in zip(an, rs)]
    cl = C.cluster(rs, C.CParams()) if len(rs) > 1 else None
    top = cl["clusters"][0] if cl else [0]
    dec_idx = [i for i, a in enumerate(an) if a["kind"] == "dec"]
    out = dict(n_routes=len(rs), rows=rows, top_cluster=len(top), top_cluster_members=[int(i) for i in top],
               n_clusters=len(cl["clusters"]) if cl else 1, best_cpk=float(min(x["cpk"] for x in rows)),
               good_max=float(max(x["good"] for x in rows)), best_i=int(np.argmin([x["cpk"] for x in rows])))
    if dec_idx:
        sub = [rs[i] for i in dec_idx]
        cl2 = C.cluster(sub, C.CParams()) if len(sub) > 1 else None
        out.update(n_dec_routes=len(sub), best_cpk_dec=float(min(rows[i]["cpk"] for i in dec_idx)), good_max_dec=float(max(rows[i]["good"] for i in dec_idx)),
                   top_cluster_dec=len(cl2["clusters"][0]) if cl2 else 1)
    else:
        out.update(n_dec_routes=0, best_cpk_dec=np.inf, good_max_dec=0.0, top_cluster_dec=0)
    return out, rs


# ------------------------------------------------------------------ trackers
def modules(kind: str) -> dict:
    if kind == "v3":
        from rsm.track2 import consensus as C, exp, graphs, run, tracker, vtrack
        from rsm.track2 import anchors as A
        return dict(kind=kind, C=C, graphs=graphs, run=run, tracker=tracker, vtrack=vtrack, A=A, good_run=exp.good_run)
    from rsm.track import anchors as A, consensus as C, graphs, run, tracker, vtrack
    from rsm.track.report import good_run
    return dict(kind=kind, C=C, graphs=graphs, run=run, tracker=tracker, vtrack=vtrack, A=A, good_run=good_run)


class TrackBase:
    """graph + nets + snapper of the tracking area, built once per video"""

    def __init__(self, TR, g):
        self.TR, self.g = TR, g
        self.fw, self.rv = TR["graphs"].Net.build(g)
        self.sn = TR["graphs"].Snap(self.fw)

    def setup(self, vid, label, cal, prm, decoy: Decoy | None = None, tracks=None):
        TR = self.TR
        if tracks is None:
            if decoy is None:
                tracks = data.vms_tracks(vid, label)
            else:
                with decoy.active():
                    tracks = data.vms_tracks(vid, label)
        kw = dict(flank=prm.ut_design) if TR["kind"] == "v3" else {}
        sf = TR["vtrack"].make_seq(tracks, **kw)
        sb = TR["vtrack"].make_seq(tracks, reverse=True, **kw)
        ctx = TR["tracker"].make_ctx(self.fw, self.rv, self.sn, cal["kappa0"], cal["rho0"], prm)
        return dict(video=vid, map_video=vid, g=self.g, fw=self.fw, rv=self.rv, sn=self.sn, sf=sf, sb=sb, ctx=ctx, cal=cal, tracks=tracks,
                    t0=float(tracks[0]["t"][0]), t1=float(tracks[-1]["t"][-1]))


def run_pipeline(vid, label, sctx, ix, gi, base: TrackBase, prm, cal_fallback: dict, decoy: Decoy | None, procs=4, key="run", log=lambda *a: None,
                 keep_recs=False) -> dict:
    """one complete run (real: decoy=None). -> summary dict"""
    TR = base.TR
    t00 = time.time()
    src = Source(sctx, vid, label, ix, gi, decoy)
    tau, m = stages.frozen()
    t0 = time.time()
    recs = stage_ab(src, key, procs, log)
    sec_ab = time.time() - t0
    sb = stageb_summary(recs, tau, m)
    est = D.estimate_video_level(recs, SETTING, tau)
    cal = dict(rho0=est["rho"], kappa0=est["kappa"]) if est else dict(cal_fallback)
    cal_own = est is not None
    anchors, n_dec_all = pick_anchors(recs, TR["A"], tau, m)
    S = base.setup(vid, label, cal, prm, decoy, tracks=src.tracks)
    t0 = time.time()
    routes, _ = TR["run"].track_all(S, anchors, procs=procs, log=lambda *a: None) if anchors else ([], 0)
    sec_tr = time.time() - t0
    out = dict(video=vid, family=decoy.family if decoy else "real", seed=decoy.seed if decoy else None, signal=decoy.info if decoy else {},
               stage_b=sb, cal=cal, cal_own=cal_own, n_anchors=len(anchors), n_dec_all=n_dec_all, n_forced=sum(a["kind"] == "forced" for a in anchors),
               sec_ab=sec_ab, sec_track=sec_tr, n_quanta=int(len(src.q["t0"])), t_max=S["t1"])
    summ, rs = summarize_routes(anchors, routes, TR, S["t1"])
    out.update(summ)
    out["sec"] = time.time() - t00
    if keep_recs:
        out["_recs"], out["_anchors"], out["_routes"] = recs, anchors, routes
    return out
