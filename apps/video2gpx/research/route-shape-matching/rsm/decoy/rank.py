# SPDX-License-Identifier: AGPL-3.0-or-later
"""Rank of the real run among its decoys, per statistic and per decoy family.

Statistics of a run (higher = better for 'good' and 'cluster', lower = better for 'cpk'):
  cpk      cost per km of the cheapest route of the run (all tracked anchors / decisions only)
  good     longest continuous locally-fitting stretch (s) of any route of the run (post-hoc statistic, as in rsm.track)
  cluster  size of the largest cluster of mutually agreeing routes
Rank of the real run = 1 + number of decoys that are as good or better (ties count against the real run); p = rank / (n_decoys + 1).
A run without any route has cpk = inf, good = 0, cluster = 0.
"""
from __future__ import annotations

import pickle
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RES = ROOT / "work" / "fable1" / "res"
STATS = {"cpk": (lambda o: o.get("best_cpk", np.inf), False), "cpk_dec": (lambda o: o.get("best_cpk_dec", np.inf), False),
         "good": (lambda o: o.get("good_max", 0.0), True), "good_dec": (lambda o: o.get("good_max_dec", 0.0), True),
         "cluster": (lambda o: float(o.get("top_cluster", 0)), True), "cluster_dec": (lambda o: float(o.get("top_cluster_dec", 0)), True)}


def load(video: str, family: str, seeds=None) -> list:
    out = []
    for f in sorted(RES.glob(f"{video}__{family}__*.pkl")):
        seed = int(f.stem.split("__")[2])
        if seeds is not None and seed not in seeds:
            continue
        out.append(pickle.load(open(f, "rb")))
    return out


def value(o: dict, stat: str) -> float:
    return STATS[stat][0](o)


def rank_of(real: float, decoys: list, higher_better: bool) -> tuple[int, float]:
    d = np.asarray(decoys, float)
    n_ge = int((d >= real).sum()) if higher_better else int((d <= real).sum())
    return 1 + n_ge, (1 + n_ge) / (len(d) + 1)


def table(video: str, families=("shuffle", "flip", "mirror"), seeds=None, stats=tuple(STATS)) -> dict:
    real = load(video, "real")[0]
    out = {}
    for fam in families + ("all",):
        ds = [o for f in (families if fam == "all" else (fam,)) for o in load(video, f, seeds)]
        row = {}
        for s in stats:
            rv = value(real, s)
            dv = [value(o, s) for o in ds]
            rk, p = rank_of(rv, dv, STATS[s][1])
            row[s] = dict(real=rv, rank=rk, p=p, n=len(ds), decoy_min=float(np.min(dv)) if dv else np.nan, decoy_med=float(np.median(dv)) if dv else np.nan,
                          decoy_best=float((np.max(dv) if STATS[s][1] else np.min(dv))) if dv else np.nan)
        out[fam] = row
    return out
