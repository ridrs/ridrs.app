# SPDX-License-Identifier: AGPL-3.0-or-later
"""Experiment 1a: re-fit the stored stage-B candidates of work/plaus (tag f1, refined input, real, rank < 50, those that had a fit) without bounds.
python -m rsm.vote.stored  -> work/fable2/res/stored_<video>.pkl  (heavy: run under memguard, 4 workers)"""
from __future__ import annotations

import multiprocessing as mp_
import pickle
import sys

import numpy as np

from rsm.plaus import experiment as X, pipeline as P

from . import cfg, fit as VF

TAG = "f1"
HALVES = {"col-de-grimone-1": ("DEV-A", "TEST-B"), "vallee-de-roanne": ("DEV-A", "TEST-B"), "col-de-rousset": ("TEST",)}
G: dict = {}


def load_recs(video):
    out = []
    for h in HALVES[video]:
        try:
            out += P.load(X.name(TAG, h, video, "refined", None))
        except FileNotFoundError:
            pass
    return out


def _work(rec):
    src = G["src"]
    wspan = rec["t1"] - rec["t0"]
    rows = []
    for c in rec["cands"]:
        if c["rank"] >= 50 or "measured" not in c["fits"]:
            continue
        st, vw, mp, anc = P.prep(src, c, rec["lo"], wspan)
        if st != "ok":
            continue
        f = VF.fit_free(vw, mp, anc)
        if f.ok:
            old = c["fits"]["measured"]
            rows.append([449.0, c["rank"], f.rho, f.kappa, f.snorm, float(f.atbound), c["nm"], float(c["correct"]), old["rho"], old["kappa"], old["snorm"], rec["L"], rec["lo"], rec["t0"]])
    return np.array(rows, float).reshape(-1, 14)


def main():
    for video in cfg.VIDEOS[:3]:
        recs = load_recs(video)
        G["src"] = P.Source(video, "refined", variant="wider")
        with mp_.get_context("fork").Pool(4) as pool:
            out = pool.map(_work, recs, chunksize=2)
        A = np.vstack(out)
        cfg.RES.mkdir(parents=True, exist_ok=True)
        pickle.dump(dict(video=video, rows=A), open(cfg.RES / f"stored_{video}.pkl", "wb"))
        print(video, "windows", len(recs), "fits", len(A), "true", int(A[:, 7].sum()), flush=True)


if __name__ == "__main__":
    main()
