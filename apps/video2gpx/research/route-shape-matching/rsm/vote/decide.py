# SPDX-License-Identifier: AGPL-3.0-or-later
"""After the vote: re-fit the best candidates with rho and kappa fixed (tight) at the vote peak, and decide as rsm.plaus does (acceptance threshold on
the normalised cost + margin to the next accepted candidate on another road). Thresholds are the frozen plaus ones for the vc fits (tau2, m2); the
plaus-rule baseline uses the frozen pass-1 values (tau, m). GPS only through the `correct` labels carried by the records."""
from __future__ import annotations

import json
import multiprocessing as mp_

import numpy as np

from rsm.plaus import decide as D, fit as pfit, pipeline as P

from . import fit as VF, stage

TOPN = 15
W_RHO, W_KAPPA = 0.03, 0.15  # the plaus pass-2 widths (VC_RHO_W, VC_KAPPA_W)
G: dict = {}


def frozen():
    c = json.loads((P.WORK / "frozen.json").read_text())["cal"]["refined"]["measured"]
    return dict(tau=c["tau"], m=c["m"], tau2=c["tau2"], m2=c["m2"])


def _work(rec):
    S = G["S"]
    src, F, f_star, k_star, plaus = S["src"], S["F"], S["f_star"], S["k_star"], S["plaus"]
    wspan = rec["t1"] - rec["t0"]
    cands = rec["cands"]
    ok = sorted([(c["fits"]["free"]["cost"], c["rank"]) for c in cands if "free" in c["fits"] and c["fits"]["free"]["ok"]])[:TOPN]
    for _, rk in ok:
        c = cands[rk]
        st, vw, mp, anc = P.prep(src, c, rec["lo"], wspan)
        if st != "ok":
            continue
        f = VF.fit_free(vw, mp, anc, rho_fixed=(F / f_star, W_RHO), kappa_fixed=(k_star, W_KAPPA))
        c["fits"]["fixed"] = P.lite(f)
    if plaus:  # plaus rule as it was: bounded measured prior, all stage-B candidates (rank < 50)
        for c in cands:
            if c["rank"] >= stage.KF:
                break
            st, vw, mp, anc = P.prep(src, c, rec["lo"], wspan)
            if st != "ok":
                continue
            c["fits"]["measured"] = P.lite(pfit.fit_candidate(vw, mp, pfit.PRIORS["measured"], anc))
    return rec


def refit(env, video, F, recs, f_star, k_star, plaus=False, procs=4):
    src = stage.make_source(env, video, F)
    G["S"] = dict(src=src, F=F, f_star=f_star, k_star=k_star, plaus=plaus)
    with mp_.get_context("fork").Pool(procs) as pool:
        out = pool.map(_work, recs, chunksize=2)
    G.pop("S", None)
    return out


def decisions(recs, setting, tau, m):
    """-> list of (rec, outcome, cand, fit, margin) of the windows that decided; outcome in correct / wrong"""
    out = []
    for r in recs:
        d = D.decide(r, setting, tau, m)
        if d is not None:
            out.append((r, D.outcome(d), d[0], d[1], d[2]))
    return out


def tally(decs, n_windows):
    c = sum(1 for d in decs if d[1] == "correct"); w = sum(1 for d in decs if d[1] == "wrong")
    return dict(correct=c, wrong=w, none=n_windows - c - w, windows=n_windows)


def bins(decs, width=60.0):
    """distinct video-time bins (width s, by window midpoint) with a correct / a wrong decision"""
    cb = {int(0.5 * (d[0]["t0"] + d[0]["t1"]) // width) for d in decs if d[1] == "correct"}
    wb = {int(0.5 * (d[0]["t0"] + d[0]["t1"]) // width) for d in decs if d[1] == "wrong"}
    return len(cb), len(wb)
