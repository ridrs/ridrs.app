# SPDX-License-Identifier: AGPL-3.0-or-later
"""Diagnostics against the GPS truth: does the map contain the true legs, and does the index retrieve them? (scoring side only)"""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from . import chain
from .chain import MapIndex


def true_legs(ix: MapIndex, ctx_events: dict, tree: cKDTree, q: dict, i: int, p1, p2, tol: float = 50.0) -> np.ndarray:
    """Map legs whose turns are within tol of the GPS positions of quantum i's turns and have the quantum's signs."""
    E = ctx_events
    ea = [e for e in tree.query_ball_point(p1[i], tol) if E["sign"][e] == q["sign1"][i]]
    eb = {e for e in tree.query_ball_point(p2[i], tol) if E["sign"][e] == q["sign2"][i]}
    out = []
    for e in ea:
        lo, hi = ix.out_ptr[e], ix.out_ptr[e + 1]
        for l in ix.out_legs[lo:hi]:
            if int(ix.B[l]) in eb:
                out.append(int(l))
    return np.array(out, dtype=np.int64)


def recall(ix: MapIndex, ctx, q: dict, mask: np.ndarray, p1, p2) -> dict:
    tree = cKDTree(ix.ev_mid)
    E = ctx.m["events"]
    n_true = n_cand = 0
    ncands, ranks = [], []
    for i in np.flatnonzero(mask):
        tl = true_legs(ix, E, tree, q, i, p1, p2)
        if len(tl) == 0:
            continue
        n_true += 1
        ids, em, x, ng = chain.candidates(ix, q, i)
        ncands.append(len(ids))
        hit = np.isin(ids, tl)
        if hit.any():
            n_cand += 1
            ranks.append(int(np.flatnonzero(hit)[0]) + 1)
    return dict(in_area=int(mask.sum()), with_true_leg=n_true, retrieved=n_cand, median_candidates=float(np.median(ncands)) if ncands else None,
                median_rank_of_true=float(np.median(ranks)) if ranks else None)
