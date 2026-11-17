# SPDX-License-Identifier: AGPL-3.0-or-later
"""Consistency check (not a decoy): the time-reversed video with flipped yaw is the same road driven backwards. Do the cheapest routes of the real run and of
the reversed run lie on the same roads?  Share of the length of each route within 30 m of the other route's polyline (positions, direction-free).
python -m rsm.decoy.consist <video>...  -> work/fable1/consistency.json"""
from __future__ import annotations

import json
import sys

import numpy as np
from scipy.spatial import cKDTree

from . import pipe, run
from .signals import Decoy


def dense(xy, step=10.0):
    d = np.hypot(*np.diff(xy, axis=0).T)
    s = np.concatenate([[0], np.cumsum(d)])
    g = np.arange(0, s[-1], step)
    return np.column_stack([np.interp(g, s, xy[:, 0]), np.interp(g, s, xy[:, 1])])


def share_near(a, b, tol=30.0):
    return float((cKDTree(dense(b)).query(dense(a))[0] <= tol).mean())


def main():
    res = {}
    for v in sys.argv[1:]:
        env = run.load_env(v)
        outs = {}
        for fam in ("real", "reverse"):
            dec = None if fam == "real" else Decoy(fam, 0)
            outs[fam] = pipe.run_pipeline(v, env["label"], env["sctx"], env["ix"], env["gi"], env["base"], env["prm"], env["cal_fallback"], dec, procs=4, key=f"c/{v}/{fam}", keep_recs=True)
        xy = {}
        for fam, o in outs.items():
            bi = o["best_i"]
            keep = [r for r in o["_routes"] if r is not None]
            xy[fam] = keep[bi].xy
        res[v] = dict(best_cpk_real=outs["real"]["best_cpk"], best_cpk_reverse=outs["reverse"]["best_cpk"], reverse_in_real=share_near(xy["reverse"], xy["real"]),
                      real_in_reverse=share_near(xy["real"], xy["reverse"]), km_real=float(outs["real"]["rows"][outs["real"]["best_i"]]["km"]), km_reverse=float(outs["reverse"]["rows"][outs["reverse"]["best_i"]]["km"]))
        print(v, res[v], flush=True)
    (run.ROOT / "work" / "fable1" / "consistency.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
