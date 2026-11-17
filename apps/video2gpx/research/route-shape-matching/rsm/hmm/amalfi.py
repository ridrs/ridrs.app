# SPDX-License-Identifier: AGPL-3.0-or-later
"""Amalfi (YouTube, motorcycle, no GPS), post hoc: the same HMM on the rsm.nogps data (graph, vms CSVs) with the same scale scan and decoys.
There is no GPS: no truth scoring. Checks are the independent evidence of work/amalfi/evidence.json (Vietri sign at 30 s, ERCHIE at 790 s, 9 tunnels).
python -m rsm.hmm.amalfi run [base|ho] | decoy [base|ho] | report [base|ho]"""
from __future__ import annotations

import copy
import dataclasses
import json
import pickle
import sys
import time

import numpy as np

from rsm.network.graph import NetGraph
from rsm.nogps import cfg, verify
from rsm.plaus import data

from . import dp, exp, grid, route, seq
from . import decoy as D

F_GRID = tuple(float(x) for x in 180.0 * (600.0 / 180.0) ** (np.arange(10) / 9.0))  # wider than the GPS videos: the COLMAP reference (273) sits near the old lower edge
K_GRID = exp.K_GRID
F_COLMAP = 273.0


def load(variant: str = "base"):
    label = cfg.install(variant)
    g = NetGraph.load(cfg.WORK / "cache" / "graph_amalfi.npz")
    tracks = data.vms_tracks(cfg.VIDEO, label)
    return g, tracks


def evidence_check(rt: route.Route, g: NetGraph) -> dict:
    ev = json.loads((cfg.WORK / "evidence.json").read_text())
    ivs = [x for x in ev["dark_intervals"] if x.get("tunnel_by_eye")]
    rt.gap_edges = []
    rt.inc = np.zeros(len(rt.t))
    tc = verify.tunnel_check(rt, g, ivs, T=7631)
    areabb = json.loads((cfg.WORK / "area_amalfi.json").read_text())["bbox"]
    places = verify.place_nodes(areabb)
    v = verify.place_check(rt, g, places, "Vietri", 30.0)
    e = verify.place_check(rt, g, places, "Erchie", 790.0)
    return dict(tunnels=tc, vietri=v, erchie=e)


def run(variant="base", procs=4, log=print):
    g, tracks = load(variant)
    st = seq.make_steps(tracks, d0=30.0)
    return exp.vms_run("amalfi", g=g, truth=None, st=st, procs=procs, fgrid=F_GRID, kgrid=K_GRID, tag=f" [{variant}]", log=log, posterior=True), g, st


def points(rt: route.Route, g: NetGraph, step: float = 2.0) -> list[dict]:
    """t, lat, lon, compass heading (deg from north, clockwise) every 2 s, for a Street View page"""
    from scipy.ndimage import gaussian_filter1d
    tg = np.arange(np.ceil(rt.t[0]), rt.t[-1], step)
    x = gaussian_filter1d(np.interp(tg, rt.t, rt.xy[:, 0]), 2.0, mode="nearest")
    y = gaussian_filter1d(np.interp(tg, rt.t, rt.xy[:, 1]), 2.0, mode="nearest")
    hd = (np.degrees(np.arctan2(np.gradient(x), np.gradient(y))) + 360.0) % 360.0
    ll = g.to_wgs84(np.column_stack([x, y]))
    return [dict(t=float(a), lat=float(b[1]), lon=float(b[0]), heading_deg=float(h)) for a, b, h in zip(tg, ll, hd)]


def summarise(r: dict, g: NetGraph) -> dict:
    ev = evidence_check(r["route"], g)
    S = r["scan"] / r["km"]
    yk = S[:, int(np.argmax(S.max(0)))]
    from .report import parabola_peak
    out = dict(f_best=r["f_best"], kappa_best=r["kappa_best"], f_parabola=parabola_peak(np.array(r["fgrid"]), yk), per_km=r["score_per_km"], f_colmap=F_COLMAP,
               vietri_m=min([x["dist_m"] for x in ev["vietri"]["named"]] or [np.nan]), vietri_route_xy=ev["vietri"]["route_xy"], vietri_nearest=ev["vietri"]["nearest_places_at_t"][:3],
               erchie_m=min([x["dist_m"] for x in ev["erchie"]["named"]] or [np.nan]), erchie_route_xy=ev["erchie"]["route_xy"], erchie_nearest=ev["erchie"]["nearest_places_at_t"][:3],
               tunnel_hits=ev["tunnels"]["hits"], tunnel_n=ev["tunnels"]["n"], tunnel_shift_mean=ev["tunnels"]["shifted_hits_mean"], tunnel_shift_p95=ev["tunnels"]["shifted_hits_p95"],
               tunnel_p_shift=ev["tunnels"]["p_shift"], tunnel_rows=[dict(t0=x["t0"], hit=x["hit"], nearest_tunnel_s=x["nearest_tunnel_s"]) for x in ev["tunnels"]["rows"]])
    return out


def main():
    cmd, variant = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "base")
    if cmd == "run":
        r, g, st = run(variant)
        pickle.dump(r, open(exp.WORK / "res" / f"amalfi_{variant}.pkl", "wb"))
        print(np.array2string(r["scan"] / r["km"], precision=1))
        s = summarise(r, g)
        json.dump(s, open(exp.WORK / "res" / f"amalfi_{variant}_summary.json", "w"), indent=1, default=float)
        print(json.dumps(s, indent=1, default=float))
    elif cmd == "decoy":
        g, tracks = load(variant)
        st = seq.make_steps(tracks, d0=30.0)
        r = pickle.load(open(exp.WORK / "res" / f"amalfi_{variant}.pkl", "rb"))
        done = D.run_generic("Amalfi", g, st, r["scan"], 20_000.0, exp.WORK / "res" / f"decoy_Amalfi_{variant}.pkl", fgrid=F_GRID, kgrid=K_GRID, classes=D.ROADCLASS)
        print(D.rank(done))
    elif cmd == "lowf":  # diagnostic: is there an interior peak below the grid (f_eff 90-180)?
        g, tracks = load(variant)
        st = seq.make_steps(tracks, d0=30.0)
        pre = dp.prepare(grid.build(g, None, h=30.0), dp.Par())
        fl = (90.0, 110.0, 130.0, 150.0, 180.0)
        S = exp.scan(pre, st, 4, 0.0, fl, K_GRID)
        print(np.array2string(S / st.km, precision=1))
        pickle.dump(dict(f=fl, S=S, km=st.km), open(exp.WORK / "res" / f"amalfi_{variant}_lowf.pkl", "wb"))
    elif cmd == "lowf_decoy":  # the best decoys of the main run (Loire, Savoie) and 2 shuffles on the same low-f grid
        from . import maps
        g, tracks = load(variant)
        st = seq.make_steps(tracks, d0=30.0)
        fl = (90.0, 110.0, 130.0, 150.0, 180.0)
        out = {}
        for name, mp, stx in (("foreign:loire", "loire", st), ("foreign:savoie", "savoie", st), ("shuffle:0", None, seq.block_shuffle(st, np.random.default_rng(100))), ("shuffle:1", None, seq.block_shuffle(st, np.random.default_rng(101)))):
            if mp:
                gf = maps.load_foreign(mp)
                E = maps.edges_in_box(gf, mp, 20_000.0)
                E = E[np.isin(np.asarray(gf.edge_highway)[E], D.ROADCLASS)]
                pre = dp.prepare(grid.build(gf, E, h=30.0), dp.Par())
            else:
                pre = dp.prepare(grid.build(g, None, h=30.0), dp.Par())
            S = exp.scan(pre, stx, 4, 0.0, fl, K_GRID)
            out[name] = S / st.km
            print(name, "best", float(np.nanmax(S) / st.km), "at f", fl[int(np.unravel_index(np.nanargmax(S), S.shape)[0])], flush=True)
        pickle.dump(out, open(exp.WORK / "res" / f"amalfi_{variant}_lowf_decoy.pkl", "wb"))
    elif cmd == "points":
        g, tracks = load(variant)
        r = pickle.load(open(exp.WORK / "res" / f"amalfi_{variant}.pkl", "rb"))
        pts = points(r["route"], g)
        json.dump(dict(meta="dense HMM, vms input base, Amalfi (motorcycle), decoy p <= 0.05; t = video seconds, heading = compass degrees clockwise from north", points=pts),
                  open(exp.WORK / "amalfi_route_points.json", "w"))
        print(len(pts))


if __name__ == "__main__":
    main()
