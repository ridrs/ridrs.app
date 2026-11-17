# SPDX-License-Identifier: AGPL-3.0-or-later
"""Probe: the local pass with its acceptance test (rsm.pipeline.local) on the route of the search, against the stored refine result of the tag."""
from __future__ import annotations

import pickle
from pathlib import Path

import numpy as np

NEEDS = ("rotation", "map", "route_search", "refine")


class _W:
    def log(self, *a):
        pass

    def status(self, *a):
        pass


def run(d: Path, case: dict) -> dict:
    from scipy.spatial import cKDTree
    from rsm.hmm import grid
    from rsm.pipeline import local as L, steps_b as B, tracks as T
    from rsm.pipeline.common import jload
    P = jload(d / "project.params.json")
    tracks = pickle.load(open(d / "rotation" / "tracks.pkl", "rb"))
    route = pickle.load(open(d / "route_search" / "route.pkl", "rb"))
    g, E = B.load_map(d, "paths" if route.get("edge_set") == "paths" else "real")
    if route.get("edge_set") == "full":
        E = np.load(d / "map" / "edges_full.npy")
    gap_nom = T.gap_nominal(str(d / "motion" / "motion.csv"), tracks)
    res, info = L.local_pass(d, P, _W(), g, E, tracks, route, jload(d / "rotation" / "vehicle.json")["effective"], gap_nom=gap_nom)
    out = dict(tested=len(info.get("accept_tested") or []), kept=len(info.get("kept_search") or []),
               margins=" ".join(f"{x['margin_nats']:.0f}" for x in info.get("accept_tested") or []),
               turns=" ".join(f"{x['unexplained_local']}/{x['unexplained_search']}" for x in info.get("accept_tested") or []),
               changed=info.get("changed_share"), conf=info.get("conf_mean"))
    if res is not None:
        loc, gl, Ec, _ = res
        G = grid.build(gl, Ec, h=loc["h"], sm=10.0 * loc["kappa"])
        xy_new = G.xy[loc["step_cell"]]
        z = np.load(d / "refine" / "result.npz")
        ll_old = gl.to_wgs84(z["xy"]) if str(z["crs"]) == gl.crs else None
        if ll_old is not None:
            dist = cKDTree(z["xy"]).query(xy_new)[0]
            out.update(vs_stored_med_m=float(np.median(dist)), vs_stored_p95_m=float(np.percentile(dist, 95)))
    return out
