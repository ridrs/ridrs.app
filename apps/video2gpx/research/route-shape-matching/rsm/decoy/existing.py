# SPDX-License-Identifier: AGPL-3.0-or-later
"""Experiment 1, part 1: rank of the real result among the decoy runs that ALREADY exist in the stored outputs.

work/track2/res/v3_<video>.pkl (also v2_), work/amalfi/res/track_base.pkl. The stored pickles keep the routes of the real anchors ('dec'), the random-anchor
control, the rank 2-5 wrong anchors and the accepted shuffled / mirrored stage-B candidates; the mirrored-video and the foreign-map controls were stored as
medians only, so they are re-run here with the stored parameters and the same anchors / seeds (same code as rsm.track2.exp.run_config; GPS only for nothing).
python -m rsm.decoy.existing   ->  work/fable1/existing.json
"""
from __future__ import annotations

import json
import pickle
from pathlib import Path

import numpy as np

from . import pipe

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "work" / "fable1"
GPS_VIDEOS = ("vallee-de-roanne", "col-de-grimone-1", "col-de-rousset")
FOREIGN = {"col-de-rousset": "col-de-grimone-1", "col-de-grimone-1": "vallee-de-roanne", "vallee-de-roanne": "col-de-grimone-1"}


def run_stats(routes, TR) -> dict:
    """best cost per km, longest good run, size of the largest cluster, number of routes, number of clusters"""
    routes = [r for r in routes if r is not None]
    if not routes:
        return dict(n=0, cpk=np.inf, good=0.0, cluster=0, n_clusters=0)
    C = TR["C"]
    cl = C.cluster(routes, C.CParams()) if len(routes) > 1 else None
    return dict(n=len(routes), cpk=float(min(r.cost_per_km for r in routes)), cpk_median=float(np.median([r.cost_per_km for r in routes])),
                good=float(max(TR["good_run"](r) for r in routes)), cluster=len(cl["clusters"][0]) if cl else 1, n_clusters=len(cl["clusters"]) if cl else 1)


def v3_video(video: str, version: str, procs=4) -> dict:
    from rsm.track2 import anchors as A, run
    TR = pipe.modules("v3")
    d = pickle.load(open(ROOT / "work" / "track2" / "res" / f"{version}_{video}.pkl", "rb"))
    R = d["routes"]
    out = {"real": run_stats([r for _, r in R["dec"]], TR)}
    dec = {"random_anchors_own_map": R.get("random", []), "rank2to5_wrong_anchors": R.get("rank25", []), "shuffled_stageB_candidates": R.get("ctl_shuffle", []),
           "mirrored_stageB_candidates": R.get("ctl_mirror", [])}
    for k, v in dec.items():
        out[k] = run_stats([r for _, r in v], TR)
    prm = d["prm"]
    grp = run.groups_for(run.setup(video, prm=prm), video)
    # mirrored video, true anchors (as run_config)
    Sm = run.setup(video, prm=prm, mirror=True)
    rs, _ = run.track_all(Sm, grp["dec"], procs=procs, log=lambda *a: None)
    out["mirrored_video_true_anchors"] = run_stats(rs, TR)
    Sf = run.setup(video, map_video=FOREIGN[video], prm=prm, cal_video=video)
    anf = A.random_anchors(Sf["fw"], Sf["t0"], Sf["t1"], max(len(grp["dec"]), 20), seed=11, kind="foreign_random")
    rs, _ = run.track_all(Sf, anf, procs=procs, log=lambda *a: None)
    out["foreign_map_random_anchors"] = run_stats(rs, TR)
    return out


def amalfi() -> dict:
    TR = pipe.modules("v2")
    d = pickle.load(open(ROOT / "work" / "amalfi" / "res" / "track_base.pkl", "rb"))
    out = {"real": run_stats(d["routes"], TR), "random_anchors_own_map": run_stats(d["random_routes"], TR), "mirrored_video_true_anchors": run_stats(d["mirror_routes"], TR)}
    return out


def ranks(sets: dict) -> dict:
    """rank of 'real' among the others per statistic (ties against real)"""
    real = sets["real"]
    dec = {k: v for k, v in sets.items() if k != "real" and v["n"] > 0}
    out = {}
    for stat, hb in (("cpk", False), ("good", True), ("cluster", True)):
        dv = np.array([v[stat] for v in dec.values()], float)
        rk = 1 + int((dv >= real[stat]).sum() if hb else (dv <= real[stat]).sum())
        out[stat] = dict(real=real[stat], rank=rk, of=len(dv) + 1, decoys={k: v[stat] for k, v in dec.items()})
    return out


def main():
    res = {}
    for v in GPS_VIDEOS:
        for ver in ("v3", "v2"):
            sets = v3_video(v, ver)
            res[f"{v}__{ver}"] = dict(sets=sets, ranks=ranks(sets))
            print(v, ver, {k: (s["n"], round(s["cpk"], 1), round(s["good"]), s["cluster"]) for k, s in sets.items()}, flush=True)
    sets = amalfi()
    res["amalfi__v2"] = dict(sets=sets, ranks=ranks(sets))
    print("amalfi", {k: (s["n"], round(s["cpk"], 1), round(s["good"]), s["cluster"]) for k, s in sets.items()})
    (OUT / "existing.json").write_text(json.dumps(res, indent=1, default=float))


if __name__ == "__main__":
    main()
