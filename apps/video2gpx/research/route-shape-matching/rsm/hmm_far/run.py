# SPDX-License-Identifier: AGPL-3.0-or-later
"""Amalfi dense-HMM route decode with the far-feature yaw series (rsm.farrot, fused far + vms heading) in place of the vms yaw. POST HOC (Amalfi was seen).
Same corridor graph, frozen HMM, scale-equivariant lattice (cell 30 kappa m + ln kappa per step), kappa grid and decoy families as rsm.hmm_cal; only the heading
increments of the Steps differ (the distance track, segments and step times are the vms ones, asserted) and the f axis is re-based to the far series' own scale.
f axis: the far series is in rad at f_A (404.9 px); the HMM sees rad_eff = rad_far * f_A / f_eff, so f_eff is a focal length in the same sense as in the vms run.
python -m rsm.hmm_far.run scan | decoy"""
from __future__ import annotations

import contextlib
import pickle
import sys
import time
from pathlib import Path

import numpy as np

from rsm.farrot import anchors as fan, series as fser
from rsm.hmm import exp, seq
from rsm.hmm_cal import area, run as crun

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "amalfi_far"
RES = WORK / "res"
# 8 log steps 250-440 (the vms run: 6 steps 250-400). The far series is at 0.90 of COLMAP's f-scale, i.e. COLMAP-scale angles need f_eff = f_A/1.11 = 365; the upper edge is
# moved from 400 to 440 so that this value and a peak beyond it are interior.
F_GRID = tuple(float(x) for x in 250.0 * (440.0 / 250.0) ** (np.arange(8) / 7.0))


@contextlib.contextmanager
def use_grid(fgrid=F_GRID):
    """rsm.hmm_cal.run.scan / _vms_run read the module-level F_GRID: swap it for the far axis inside the block (restored after)"""
    old = crun.F_GRID
    crun.F_GRID = tuple(fgrid)
    try:
        yield
    finally:
        crun.F_GRID = old


def far_series() -> fser.Series:
    return fser.build("amalfi", fan.vms_config("Amalfi")["csv"])


def far_tracks(S: fser.Series | None = None) -> list[dict]:
    """tracks {t, s, th} in the convention of the stored vms tracks: th = pixel yaw / F_REF, so that a_ang = F_REF / f_eff gives rad_eff = rad_far * f_A / f_eff"""
    S = S or far_series()
    return fan.tracks_from_series("Amalfi", S, exp.F_REF / S.f)


def far_steps(S: fser.Series | None = None) -> seq.Steps:
    st = seq.make_steps(far_tracks(S), d0=crun.H)
    sv = crun.load_steps("base")
    assert st.T == sv.T and np.allclose(st.t, sv.t) and np.allclose(st.mu, sv.mu) and (np.isnan(st.dth) == np.isnan(sv.dth)).all(), "far steps must share the vms distance track"
    return st


def scan_run(procs=4, log=print):
    g, E = crun.load_amalfi()
    st = far_steps()
    crun.check(g, E, st, "Amalfi corridor, far yaw")
    with use_grid():
        r = crun._vms_run(g, E, st, procs, log)
    r["edges"] = len(E); r["directed_km"] = float(np.asarray(g.edge_len)[E].sum() / 1000)
    RES.mkdir(parents=True, exist_ok=True)
    pickle.dump(r, open(RES / "scan_far.pkl", "wb"))
    return r, g, st


def decoy_run(procs=4, log=print):
    """same 19 decoys as hmm_cal.decoy_run (3 foreign maps, 12 block shuffles of the far series, mirror, 3 foreign + shuffle), same seeds, same far F_GRID x kappa scan"""
    g, E = crun.load_amalfi()
    st = far_steps()
    real = pickle.load(open(RES / "scan_far.pkl", "rb"))
    pkl = RES / "decoy_far.pkl"
    done = pickle.load(open(pkl, "rb")) if pkl.exists() else {}
    done["real"] = dict(per_km=float(np.nanmax(real["scan"]) / st.km), scan=real["scan"])
    pre_real, pre_for = None, {}
    with use_grid():
        for fam in crun.families(st):
            if fam["name"] in done:
                continue
            t0 = time.time()
            if fam["map"] is None:
                if pre_real is None:
                    pre_real = crun.prepare_all(g, E)
                pre = pre_real
            else:
                if fam["map"] not in pre_for:
                    pre_for.clear()
                    gf, Ef = crun.load_foreign(fam["map"])
                    crun.check(gf, Ef, st, "decoy " + fam["map"])
                    pre_for[fam["map"]] = crun.prepare_all(gf, Ef)
                pre = pre_for[fam["map"]]
            S = crun.scan(pre, fam["st"], procs)
            done[fam["name"]] = dict(per_km=float(np.nanmax(S) / st.km), scan=S, fam=fam["fam"])
            pickle.dump(done, open(pkl, "wb"))
            log(f"decoy {fam['name']:26s} best {done[fam['name']]['per_km']:.2f}/km (real {done['real']['per_km']:.2f}) cells {pre[0].grid.N}-{pre[-1].grid.N} {time.time()-t0:.0f}s", flush=True)
    return done


FINE_K = (1.4, 1.5, 1.6, 1.7, 1.8, 1.86, 1.95, 2.05, 2.15, 2.3, 2.5)
FINE_F = (310.0, 345.0, 380.0)


def fine_run(procs=3, log=print):
    """finer kappa scan around the peak (as work/amalfi_cal/diag.py): same grids, same + ln kappa per step"""
    import dataclasses
    import multiprocessing as mp
    from rsm.hmm import grid
    from rsm.hmm_cal import dp
    g, E = crun.load_amalfi()
    st = far_steps()
    out = np.zeros((len(FINE_F), len(FINE_K)))
    for j, k in enumerate(FINE_K):
        pre = dp.prepare(grid.build(g, E, h=crun.H * k, sm=10.0 * k), dp.Par(kappa=k))
        crun._G["pre"], crun._G["st"] = pre, st
        with mp.get_context("fork").Pool(min(procs, 4)) as pool:
            for fi, sc in pool.imap_unordered(crun._job, list(enumerate(FINE_F))):
                out[fi, j] = (sc + (st.T - 1) * np.log(k)) / st.km
        log(f"kappa {k}: {np.round(out[:, j], 1)}", flush=True)
    pickle.dump(dict(f=FINE_F, k=FINE_K, S=out), open(RES / "fine_far.pkl", "wb"))
    return out


def main():
    cmd = sys.argv[1]
    if cmd == "fine":
        fine_run()
    elif cmd == "scan":
        r, g, st = scan_run()
        print(np.array2string(r["scan"] / r["km"], precision=1, max_line_width=200))
    elif cmd == "decoy":
        from rsm.hmm import decoy as D
        print(D.rank(decoy_run()))


if __name__ == "__main__":
    main()
