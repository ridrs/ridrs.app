# SPDX-License-Identifier: AGPL-3.0-or-later
"""Decoy decision for the HMM (Fable step 3). The statistic is the best-path log-likelihood per km, maximised over the SAME (f_eff x kappa) grid as the real run.
Decoys destroy the true signal at the scale the statistic integrates over (lesson of Fable step 2):
  foreign   the real vms series on a far, non-overlapping map of the same extract (3 maps, same size as the largest area)
  shuffle   blocks of 200-500 m of the heading increments permuted (the long-range structure and the road are gone; local statistics stay)
  mirror    heading increments negated, on the real map
  foreign+shuffle   a shuffled series on a foreign map
19 decoys per video = 3 foreign + 12 shuffle + 1 mirror + 3 foreign+shuffle. Rank 1 = the real run scores above all decoys; p = rank / (n + 1).
"""
from __future__ import annotations

import json
import pickle
import time

import numpy as np

from rsm.track2 import graphs

from . import dp, exp, grid, maps, seq

N_SHUF = 12


def families(st_real: seq.Steps, seed0: int = 100):
    out = []
    for m in maps.FOREIGN:
        out.append(dict(name=f"foreign:{m}", fam="foreign", map=m, st=st_real))
    for i in range(N_SHUF):
        out.append(dict(name=f"shuffle:{i}", fam="shuffle", map=None, st=seq.block_shuffle(st_real, np.random.default_rng(seed0 + i))))
    out.append(dict(name="mirror", fam="mirror", map=None, st=seq.mirror(st_real)))
    for k, m in enumerate(maps.FOREIGN):
        out.append(dict(name=f"foreign+shuffle:{m}", fam="foreign+shuffle", map=m, st=seq.block_shuffle(st_real, np.random.default_rng(seed0 + 50 + k))))
    return out


ROADCLASS = ("trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified")


def run_generic(name: str, g, st: seq.Steps, real_scan: np.ndarray, half_width: float, pkl, fgrid=None, kgrid=None, procs: int = 4, b_speed: float = 0.0,
                classes=None, log=print) -> dict:
    """decoys of one video. classes: restrict the FOREIGN maps to these highway classes (Amalfi was built without residential roads)."""
    done = pickle.load(open(pkl, "rb")) if pkl.exists() else {}
    fgrid = exp.F_GRID if fgrid is None else fgrid
    kgrid = exp.K_GRID if kgrid is None else kgrid
    pre_real = None
    pre_for = {}
    done["real"] = dict(per_km=float(np.nanmax(real_scan) / st.km), scan=real_scan)
    for fam in families(st):
        if fam["name"] in done:
            continue
        t0 = time.time()
        if fam["map"] is None:
            if pre_real is None:
                pre_real = dp.prepare(grid.build(g, None, h=30.0), dp.Par())
            pre = pre_real
        else:
            if fam["map"] not in pre_for:
                pre_for.clear()
                gf = maps.load_foreign(fam["map"])
                E = maps.edges_in_box(gf, fam["map"], half_width)
                if classes is not None:
                    E = E[np.isin(np.asarray(gf.edge_highway)[E], classes)]
                pre_for[fam["map"]] = dp.prepare(grid.build(gf, E, h=30.0), dp.Par())
            pre = pre_for[fam["map"]]
        S = exp.scan(pre, fam["st"], procs, b_speed, fgrid, kgrid)
        done[fam["name"]] = dict(per_km=float(np.nanmax(S) / st.km), scan=S, fam=fam["fam"])
        pickle.dump(done, open(pkl, "wb"))
        log(f"{name} decoy {fam['name']:24s} best {done[fam['name']]['per_km']:.2f} per km  (real {done['real']['per_km']:.2f})  {time.time()-t0:.0f}s  cells {pre.grid.N}")
    return done


def run(video: str, procs: int = 4, b_speed: float = 0.0, log=print) -> dict:
    g, truth = exp.load(video)
    st = exp.vms_steps(video)
    real = pickle.load(open(exp.WORK / "res" / f"vms_{exp.SHORT[video]}_b{b_speed}.pkl", "rb"))
    half_width = max(graphs.R_MIN, float(json.loads((graphs.WORK / f"area_{video}.json").read_text())["radius_m"]))  # the video's own area rule
    return run_generic(exp.SHORT[video], g, st, real["scan"], half_width, exp.WORK / "res" / f"decoy_{exp.SHORT[video]}.pkl", procs=procs, b_speed=b_speed, log=log)


def rank(done: dict) -> dict:
    dec = {k: v["per_km"] for k, v in done.items() if k != "real"}
    real = done["real"]["per_km"]
    n_ge = sum(v >= real for v in dec.values())
    by_fam = {}
    for k, v in done.items():
        if k == "real":
            continue
        by_fam.setdefault(v["fam"], []).append(v["per_km"])
    worst = max(dec.values())
    return dict(n=len(dec), rank=1 + n_ge, p=(1 + n_ge) / (1 + len(dec)), real=real, best_decoy=worst, best_decoy_name=max(dec, key=dec.get),
                margin=real - worst, by_fam={k: (float(np.mean(v)), float(np.max(v))) for k, v in by_fam.items()})


if __name__ == "__main__":
    import sys
    vids = exp.VIDEOS if sys.argv[1] == "all" else [sys.argv[1]]
    for v in vids:
        r = rank(run(v))
        print(exp.SHORT[v], r, flush=True)
