# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.decoy.run real <video>
   python -m rsm.decoy.run decoy <video> <family> <seed0> <seed1>     (seeds seed0 .. seed1-1; skips finished ones)
videos: vallee-de-roanne col-de-grimone-1 col-de-rousset amalfi        output: work/fable1/res/<video>__<family>__<seed>.pkl
Heavy: run under tools/memguard.py, 4 workers.
"""
from __future__ import annotations

import json
import pickle
import sys
import time
from pathlib import Path
from types import SimpleNamespace

from rsm.network.graph import NetGraph
from rsm.plaus import freeze as PF, pipeline as P
from rsm.quanta import area as qarea, legs
from rsm.quanta.chain import MapIndex

from . import pipe
from .signals import Decoy

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "work" / "fable1" / "res"
GPS_VIDEOS = ("vallee-de-roanne", "col-de-grimone-1", "col-de-rousset")
PROCS = 4


def load_env(video: str):
    """-> dict(sctx, ix, gi, base, prm, cal_fallback, label, TR)"""
    from rsm.plaus import path as pathmod
    PF.check()
    if video in GPS_VIDEOS:
        g = NetGraph.load(qarea.WORK / "cache" / f"graph_{video}.npz")
        m = legs.load(qarea.WORK / f"map_{video}_45.npz")
        sctx = SimpleNamespace(g=g, m=m, video=video, thr=45.0)
        TR = pipe.modules("v3")
        tg, _ = TR["graphs"].load_graph(video)
        d = pickle.load(open(ROOT / "work" / "track2" / "res" / f"v3_{video}.pkl", "rb"))
        prm = d["prm"]
        cal = TR["A"].video_cal(video)
        label = "refined"
        cal_fb = dict(rho0=cal["rho0"], kappa0=cal["kappa0"])
    else:
        from rsm.nogps import cfg, mapbuild
        label = cfg.install("base")
        sctx = mapbuild.load_ctx(log=lambda *a: None)
        TR = pipe.modules("v2")
        tg = sctx.g
        prm = TR["tracker"].Params()
        cal_fb = dict(rho0=1.0, kappa0=1.0)
    ix = MapIndex(sctx.m, P.qparams("wider"))
    gi = pathmod.GraphIdx(sctx.g)
    base = pipe.TrackBase(TR, tg)
    return dict(sctx=sctx, ix=ix, gi=gi, base=base, prm=prm, cal_fallback=cal_fb, label=label, TR=TR)


def run_one(env, video, family, seed, force=False):
    OUT.mkdir(parents=True, exist_ok=True)
    f = OUT / f"{video}__{family}__{seed}.pkl"
    if f.exists() and not force:
        return None
    dec = None if family == "real" else Decoy(family, seed)
    t0 = time.time()
    out = pipe.run_pipeline(video, env["label"], env["sctx"], env["ix"], env["gi"], env["base"], env["prm"], env["cal_fallback"], dec, procs=PROCS,
                            key=f"{video}/{family}/{seed}")
    with open(f, "wb") as fh:
        pickle.dump(out, fh)
    r = out.get("best_cpk", float("nan"))
    print(f"{video} {family} {seed}: {time.time()-t0:.0f}s (A+B {out['sec_ab']:.0f}s, track {out['sec_track']:.0f}s) windows {out['stage_b']['n_windows']} acc {out['stage_b']['n_accepted']} "
          f"dec {out['stage_b']['n_decisions']} anchors {out['n_anchors']} best cpk {r:.1f} top cluster {out.get('top_cluster')} good_max {out.get('good_max', 0):.0f}", flush=True)
    return out


def main():
    cmd, video = sys.argv[1], sys.argv[2]
    env = load_env(video)
    if cmd == "real":
        run_one(env, video, "real", 0, force="--force" in sys.argv)
    elif cmd == "decoy":
        fam, s0, s1 = sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
        for s in range(s0, s1):
            run_one(env, video, fam, s)


if __name__ == "__main__":
    main()
