# SPDX-License-Identifier: AGPL-3.0-or-later
"""Amalfi calibration study (POST HOC: Amalfi was seen in work/amalfi and work/fable3). The frozen dense HMM of rsm.hmm, unchanged, on the a-priori corridor of
rsm.hmm_cal.area with a WIDE 2-D scale scan: f_eff 250-400 (6 log steps) x kappa 0.8-3.5 (8 log steps). A fixed 30 m lattice aliases at kappa > 1.13, so the
grid scales with kappa (cell 30 kappa m, K = 3 as frozen: one nominal step = one cell); only dp.py is a copy (16-bit backpointers).
python -m rsm.hmm_cal.run scan | decoy | report"""
from __future__ import annotations

import dataclasses
import json
import pickle
import sys
import time

import numpy as np

from rsm.network.graph import NetGraph
from rsm.nogps import cfg
from rsm.plaus import data
from rsm.hmm import exp, grid, route, seq

from . import dp

from . import area

F_GRID = tuple(float(x) for x in 250.0 * (400.0 / 250.0) ** (np.arange(6) / 5.0))
K_GRID = tuple(float(x) for x in 0.8 * (3.5 / 0.8) ** (np.arange(8) / 7.0))
H = 30.0
RES = area.WORK / "res"


def load_steps(variant="base", d0=H):
    label = cfg.install(variant)
    return seq.make_steps(data.vms_tracks(cfg.VIDEO, label), d0=d0)


def check(g, E, st, label):
    """memory plan BEFORE the grid is built; abort above 4 GB"""
    p = area.plan(g, E, lambda h: st.T if h == st.d0 else int(round(st.km * 1000 / h)) + 1)
    print(f"memory plan {label}: states {p['N']} x steps {p['T']} at h {p['h']:.0f} m -> {p['gb']:.2f} GB (cap {area.GB_CAP}); tried {p['tried']}", flush=True)
    return p


def load_amalfi():
    g = NetGraph.load(area.CACHE / "graph_amalfi_cal.npz")
    return g, area.edges_in_bbox(g, area.AMALFI_BBOX)


def load_foreign(name):
    bb = area.foreign_bbox(*area.FOREIGN[name])
    g = NetGraph.load(area.CACHE / f"graph_foreign_{name}.npz")
    return g, area.edges_in_bbox(g, bb)


def scan_run(procs=4, log=print):
    g, E = load_amalfi()
    st = load_steps()
    check(g, E, st, "Amalfi corridor")
    r = _vms_run(g, E, st, procs, log)
    r["edges"] = len(E); r["directed_km"] = float(np.asarray(g.edge_len)[E].sum() / 1000)
    pickle.dump(r, open(RES / "scan_base.pkl", "wb"))
    return r, g, st


def _vms_run(g, E, st, procs, log):
    t0 = time.time()
    pres = prepare_all(g, E)
    log(f"grids: cells per kappa {[p.grid.N for p in pres]}", flush=True)
    for p in pres:
        grid.check_budget(p.grid.N, st.T)
    S = scan(pres, st, procs)
    fi, ki = np.unravel_index(np.nanargmax(S), S.shape)
    G = pres[ki].grid
    par = dataclasses.replace(dp.Par(), a_ang=exp.F_REF / F_GRID[fi], kappa=K_GRID[ki])
    p2 = dp.prepare(G, par)
    est = grid.check_budget(G.N, st.T)
    r = dp.viterbi(p2, st, backptr=True)
    rt = route.decode(G, st, r["cell_path"])
    out = dict(cells=G.N, steps=st.T, km=st.km, mem=est, scan=S, fgrid=F_GRID, kgrid=K_GRID, f_best=F_GRID[fi], kappa_best=K_GRID[ki], score=S[fi, ki], score_per_km=S[fi, ki] / st.km)
    fb = dp.forward_backward(p2, st, r["cell_path"])
    fb["t"] = st.t
    out["post"] = fb
    pv = np.interp(rt.t, st.t, np.nan_to_num(fb["p_vit"], nan=0.0))
    out["conf"] = dict(t=rt.t, p=pv)
    out["route"] = rt; out["par"] = par; out["seconds"] = time.time() - t0
    log(f"best f_eff {F_GRID[fi]:.0f} kappa {K_GRID[ki]:.2f} score/km {out['score_per_km']:.2f} | {out['seconds']:.0f}s", flush=True)
    return out


_G: dict = {}


def grids_for(g, E):
    """scale-equivariant grid per kappa: cell h = 30 kappa m, map-heading smoothing 10 kappa m, K = 3, dmax 2.4 h (the frozen settings at kappa = 1). One nominal step of 30 m is
    then one cell on the road for every kappa; a fixed 30 m lattice aliases (see RESULTS: advance of 45 m on a 30 m lattice is 1.3 sd from both neighbours)."""
    return [grid.build(g, E, h=H * k, sm=10.0 * k) for k in K_GRID]


def _job(args):
    pre, st = _G["pre"], _G["st"]
    fi, f = args
    par = dataclasses.replace(pre.par, a_ang=exp.F_REF / f)
    p = dp.Prepared(pre.grid, par)  # the emission scale depends on a_ang
    p.par = par
    return fi, dp.viterbi(p, st)["score"]


def scan(pres, st, procs=4):
    """best-path log score on the (f_eff x kappa) grid, in units of the 30 m cell: the Viterbi score uses a distance DENSITY (per metre) and the lattice spacing is 30 kappa m, so
    each of the T-1 transitions gets + ln kappa (probability per cell, comparable across kappa; the ln N prior term, ln kappa in total, is ignored). pres = one dp.Prepared per kappa (fork pool, at most 4 workers)"""
    import multiprocessing as mp
    out = np.full((len(F_GRID), len(K_GRID)), np.nan)
    for ki, pre in enumerate(pres):
        _G["pre"], _G["st"] = pre, st
        with mp.get_context("fork").Pool(min(procs, 4)) as pool:
            for fi, sc in pool.imap_unordered(_job, [(i, F_GRID[i]) for i in range(len(F_GRID))]):
                out[fi, ki] = sc + (st.T - 1) * np.log(K_GRID[ki])
    return out


def prepare_all(g, E):
    return [dp.prepare(G, dp.Par(kappa=k)) for G, k in zip(grids_for(g, E), K_GRID)]


def families(st, seed0=100):
    out = [dict(name=f"foreign:{m}", fam="foreign", map=m, st=st) for m in DECOY_MAPS]
    out += [dict(name=f"shuffle:{i}", fam="shuffle", map=None, st=seq.block_shuffle(st, np.random.default_rng(seed0 + i))) for i in range(12)]
    out.append(dict(name="mirror", fam="mirror", map=None, st=seq.mirror(st)))
    out += [dict(name=f"foreign+shuffle:{m}", fam="foreign+shuffle", map=m, st=seq.block_shuffle(st, np.random.default_rng(seed0 + 50 + k))) for k, m in enumerate(DECOY_MAPS)]
    return out


DECOY_MAPS = ("maratea", "gargano", "cilento")  # directed km in the box of the Amalfi size: 1056, 1014, 2091 (Amalfi 1111)


def decoy_run(procs=4, log=print):
    g, E = load_amalfi()
    st = load_steps()
    real = pickle.load(open(RES / "scan_base.pkl", "rb"))
    pkl = RES / "decoy_base.pkl"
    done = pickle.load(open(pkl, "rb")) if pkl.exists() else {}
    done["real"] = dict(per_km=float(np.nanmax(real["scan"]) / st.km), scan=real["scan"])
    pre_real, pre_for = None, {}
    for fam in families(st):
        if fam["name"] in done:
            continue
        t0 = time.time()
        if fam["map"] is None:
            if pre_real is None:
                pre_real = prepare_all(g, E)
            pre = pre_real
        else:
            if fam["map"] not in pre_for:
                pre_for.clear()
                gf, Ef = load_foreign(fam["map"])
                check(gf, Ef, st, "decoy " + fam["map"])
                pre_for[fam["map"]] = prepare_all(gf, Ef)
            pre = pre_for[fam["map"]]
        S = scan(pre, fam["st"], procs)
        done[fam["name"]] = dict(per_km=float(np.nanmax(S) / st.km), scan=S, fam=fam["fam"])
        pickle.dump(done, open(pkl, "wb"))
        log(f"decoy {fam['name']:26s} best {done[fam['name']]['per_km']:.2f}/km (real {done['real']['per_km']:.2f}) cells {pre[0].grid.N}-{pre[-1].grid.N} {time.time()-t0:.0f}s", flush=True)
    return done


def main():
    cmd = sys.argv[1]
    if cmd == "scan":
        r, g, st = scan_run()
        print(np.array2string(r["scan"] / r["km"], precision=1, max_line_width=200))
    elif cmd == "decoy":
        from rsm.hmm import decoy as D
        print(D.rank(decoy_run()))
    elif cmd == "report":
        from . import report
        report.main()


if __name__ == "__main__":
    main()
