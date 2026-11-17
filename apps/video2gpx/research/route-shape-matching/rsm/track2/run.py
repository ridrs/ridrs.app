# SPDX-License-Identifier: AGPL-3.0-or-later
"""Run the tracker for the anchors of one video (and its controls) in worker processes; scoring against the GPS afterwards.

python -m rsm.track2.run track <video> --tag T [--params file.json]   -> work/track2/res/<tag>_<video>.pkl
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import pickle
import time
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np

from rsm.plaus import data
from rsm.quanta.area import WORK as QWORK

from . import anchors as A
from . import consensus as C
from . import graphs, route, score, tracker, vtrack

WORK = graphs.WORK
G: dict = {}
LABEL = "refined"


def load_params(path=None) -> tracker.Params:
    prm = tracker.Params()
    if path:
        d = json.loads(Path(path).read_text())
        d = {k: (tuple(v) if isinstance(v, list) else v) for k, v in d.items()}
        prm = replace(prm, **d)
    return prm


def setup(video: str, map_video: str | None = None, prm=None, mirror=False, cal_video: str | None = None):
    """graph + nets + sequences. map_video: track on another video's map (foreign-map control). mirror: mirrored vms."""
    mv = map_video or video
    g, area = graphs.load_graph(mv)
    fw, rv = graphs.Net.build(g)
    sn = graphs.Snap(fw)
    cal = A.video_cal(cal_video or video)
    tracks = data.vms_tracks(video, LABEL)
    fl = (prm or tracker.Params()).ut_design  # v3: gap distance from the flanking local speeds; v2: segment means
    sf = vtrack.make_seq(tracks, mirror=mirror, flank=fl); sb = vtrack.make_seq(tracks, reverse=True, mirror=mirror, flank=fl)
    ctx = tracker.make_ctx(fw, rv, sn, cal["kappa0"], cal["rho0"], prm or tracker.Params())
    return dict(video=video, map_video=mv, g=g, fw=fw, rv=rv, sn=sn, sf=sf, sb=sb, ctx=ctx, cal=cal, tracks=tracks,
                t0=float(tracks[0]["t"][0]), t1=float(tracks[-1]["t"][-1]))


def snap_anchor(S, a):
    """-> (edge, offset) in the forward net or None."""
    if "edge" in a:
        return a["edge"], a["u"]
    c = S["sn"].near(a["xy"], 40.0, heading=a["hd"], max_deg=50.0, k=1)
    return (c[0][0], c[0][1]) if c else None


def _work(i):
    S = G["S"]; a = G["anchors"][i]
    sn = snap_anchor(S, a)
    if sn is None:
        return i, None
    r = route.track_anchor(S["ctx"], S["sf"], S["sb"], a["t"], sn[0], sn[1])
    return i, r


def track_all(S, anchors, procs=11, log=print):
    G["S"], G["anchors"] = S, anchors
    t0 = time.time()
    with mp.get_context("fork").Pool(procs) as pool:
        out = pool.map(_work, range(len(anchors)), chunksize=1)
    log(f"  tracked {len(anchors)} anchors in {time.time()-t0:.0f}s")
    return [r for _, r in out], time.time() - t0


def groups_for(S, video, ctl_mirror_anchors=None, n_random=None, seed=7):
    """anchor groups of a video: dict name -> list"""
    g = {}
    dec = A.dedupe(A.decisions(video))
    g["dec"] = dec
    g["rank25"] = A.dedupe(A.rank25(video), dt=10.0, dist=40.0)
    g["ctl_mirror"] = A.dedupe(A.accepted_candidates(video, "mirror"))
    g["ctl_shuffle"] = A.dedupe(A.accepted_candidates(video, "shuffle"))
    n = n_random or max(len(dec), 20)
    g["random"] = A.random_anchors(S["fw"], S["t0"], S["t1"], n, seed=seed)
    return g
