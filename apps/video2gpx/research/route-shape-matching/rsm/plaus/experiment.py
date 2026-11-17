# SPDX-License-Identifier: AGPL-3.0-or-later
"""Calibration on DEV-A, pass 2 (video-level scale), evaluation tables.

Modes: "p1"  per-window acceptance + margin with the setting's own priors;
       "vc"  + rho and kappa fixed to the video-level medians of the accepted pass-1 candidates (refit of the best candidates);
       "adj" + two overlapping windows whose decisions are not adjacent on the map are both dropped.
"""
from __future__ import annotations

import json
from dataclasses import replace

import numpy as np

from . import decide as D
from . import fit as fitmod
from . import pipeline as P

SETTINGS = ("tight", "measured", "loose")
TOPN_VC = 15
VC_RHO_W, VC_KAPPA_W = 0.03, 0.15
CTLS = ("mirror", "shuffle", "foreign")
VIDEOS = {"DEV-A": ["col-de-grimone-1", "vallee-de-roanne"], "TEST-B": ["col-de-grimone-1", "vallee-de-roanne"], "TEST": ["col-de-rousset"]}


def name(tag, half, v, src, ctl):
    return f"{tag}_{half}_{v}_{src}_{ctl or 'real'}"


def load_set(tag, half, src, ctl=None):
    out = []
    for v in VIDEOS[half]:
        out += P.load(name(tag, half, v, src, ctl))
    return out


# ---------------------------------------------------------------- pass 2
def pass2(tag, half, cal1, variant="wider", sources=("refined", "baseline", "gps"), ctls=(None, "mirror", "shuffle", "foreign"), settings=SETTINGS):
    """cal1[src][setting] = {tau, m}. Estimates rho/kappa per video from the pass-1 data of the same run and refits."""
    for v in VIDEOS[half]:
        for s in sources:
            for ctl in (ctls if s == "refined" else (None,)):
                recs = P.load(name(tag, half, v, s, ctl))
                if not recs:  # e.g. no window of this half
                    P.save([], name(tag + "2", half, v, s, ctl))
                    continue
                est = {st: D.estimate_video_level(recs, st, cal1[s][st]["tau"]) for st in settings}
                mv = None
                if ctl == "foreign":
                    mv = recs[0]["map"]
                src = P.Source(v, s, ctl=ctl, map_video=mv, variant=variant)

                def priors_of(r, est=est):
                    out = {}
                    for st in settings:
                        if est[st] is not None:
                            out[st + "+vc"] = replace(fitmod.PRIORS[st], rho_fixed=(est[st]["rho"], VC_RHO_W), kappa_fixed=(est[st]["kappa"], VC_KAPPA_W))
                    return out

                def ranks_of(r):
                    ks = set()
                    for st in settings:
                        fs = sorted([(f["cost"], c["rank"]) for c, f in D.fits_of(r, st)])
                        ks.update(rk for _, rk in fs[:TOPN_VC])
                    return sorted(ks)

                recs2 = P.refit_source(src, f"{tag}2/{v}/{s}/{ctl}", recs, None, priors_of, ranks_of, shuffle=(ctl == "shuffle"))
                for r in recs2:
                    r["vc_est"] = est
                P.save(recs2, name(tag + "2", half, v, s, ctl))
                print("pass2", half, v, s, ctl, {k: (None if e is None else (round(e["rho"], 3), round(e["kappa"], 3), e["n"])) for k, e in est.items()}, flush=True)


# ---------------------------------------------------------------- calibration
def margin_search(real, ctl_sets, st, tau):
    best = None
    rows = []
    for m in D.MARGIN_GRID:
        w_real = [D.outcome(D.decide(r, st, tau, m)) for r in real]
        wr = w_real.count("wrong")
        wc = {k: [D.outcome(D.decide(r, st, tau, m)) for r in rs].count("wrong") for k, rs in ctl_sets.items()}
        sc = wr + wc.get("shuffle", 0) + wc.get("foreign", 0)
        rows.append(dict(m=m, wrong_real=wr, correct=w_real.count("correct"), ctl=wc, score=sc))
        if best is None or sc < best[0]:
            best = (sc, m)
    return best[1], rows


def calibrate(tag, q=95.0):
    """-> cal dict with pass-1 tau/m and (after pass 2) tau2/m2, from DEV-A."""
    cal = {}
    for s in ("refined", "baseline", "gps"):
        real = load_set(tag, "DEV-A", s)
        ctls = {c: load_set(tag, "DEV-A", "refined", c) for c in CTLS} if s == "refined" else {}
        cal[s] = {}
        for st in SETTINGS:
            ct = D.calibrate_tau(real, st, q)
            m, rows = margin_search(real, ctls, st, ct["tau"])
            cal[s][st] = dict(tau=ct["tau"], tau_info=ct, m=m, margin_rows=rows)
    return cal


def calibrate2(tag, cal, q=95.0):
    for s in ("refined", "baseline", "gps"):
        real = load_set(tag + "2", "DEV-A", s)
        ctls = {c: load_set(tag + "2", "DEV-A", "refined", c) for c in CTLS} if s == "refined" else {}
        for st in SETTINGS:
            k = st + "+vc"
            real_ok = [r for r in real]
            ct = D.calibrate_tau(real_ok, k, q)
            m, rows = margin_search(real_ok, ctls, k, ct["tau"])
            cal[s][st].update(tau2=ct["tau"], tau2_info=ct, m2=m, margin2_rows=rows)
    return cal


# ---------------------------------------------------------------- evaluation
def decisions_for(recs1, recs2, cal_s, st, mode):
    """list of decide() results per window (same order as recs1)."""
    c = cal_s[st]
    out = []
    for i, r in enumerate(recs1):
        if mode == "p1":
            out.append(D.decide(r, st, c["tau"], c["m"]))
        else:
            r2 = recs2[i]
            if r2["vc_est"][st] is None:
                out.append(D.decide(r, st, c["tau"], c["m"]))
            else:
                out.append(D.decide(r2, st + "+vc", c["tau2"], c["m2"]))
    return out


def fit_key(mode, st):
    return st if mode == "p1" else st + "+vc"


def cell(recs1, recs2, cal_s, st, mode, L):
    sel = [i for i, r in enumerate(recs1) if r["L"] == L]
    r1 = [recs1[i] for i in sel]
    r2 = [recs2[i] for i in sel] if recs2 is not None else None
    dec = decisions_for(r1, r2, cal_s, st, "p1" if mode == "p1" else "vc")
    adj = (0, 0)
    if mode == "adj":
        dec, npair, nbad = D.apply_adjacency(r1, dec)
        adj = (npair, nbad)
    oc = [D.outcome(d) for d in dec]
    ct = dict(n=len(r1), correct=oc.count("correct"), wrong=oc.count("wrong"), none=oc.count("none"), adj_pairs=adj[0], adj_bad=adj[1])
    # candidate level
    tau = cal_s[st]["tau"] if mode == "p1" else cal_s[st]["tau2"]
    nt = nta = nw = nwa = 0
    win_true = win_true_acc = win_wrong_acc = 0
    for i, r in enumerate(r1):
        rr = r if mode == "p1" or r2[i]["vc_est"][st] is None else r2[i]
        key = st if (mode == "p1" or r2[i]["vc_est"][st] is None) else st + "+vc"
        t_ = tau if key == fit_key(mode, st) else cal_s[st]["tau"]
        has_t = acc_t = acc_w = False
        for c, f in D.fits_of(rr, key):
            if c["correct"]:
                nt += 1; has_t = True
                if f["snorm"] <= t_:
                    nta += 1; acc_t = True
            else:
                nw += 1
                if f["snorm"] <= t_:
                    nwa += 1; acc_w = True
        win_true += has_t; win_true_acc += acc_t; win_wrong_acc += acc_w
    ct.update(true_cands=nt, true_acc=nta, wrong_cands=nw, wrong_acc=nwa, win_with_true=win_true, win_true_acc=win_true_acc, win_wrong_acc=win_wrong_acc)
    return ct


def recall_row(recs, L):
    r = [x for x in recs if x["L"] == L]
    ft = [x["first_true"] for x in r]
    return dict(n=len(r), **{f"K{K}": sum(1 for v in ft if v is not None and v < K) for K in (1, 20, 50, 200)})
