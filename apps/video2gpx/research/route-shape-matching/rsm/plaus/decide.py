# SPDX-License-Identifier: AGPL-3.0-or-later
"""Acceptance, decision and consistency rules on the stage B records. GPS only enters through the `correct` labels of the records."""
from __future__ import annotations

import numpy as np

MARGIN_GRID = (0.02, 0.04, 0.06, 0.1, 0.15, 0.25, 0.4)  # normalised cost units; the floor 0.02 is a prior choice (DEV-A decisions all have margin inf)
TAIL = 2.5
ADJ_M = 100.0  # median distance of the fitted map positions of two overlapping windows
ADJ_MIN_OVERLAP_S = 10.0


KMAX = 50  # candidates of stage A considered by stage B (rank < KMAX); the records hold more (K = 200 was fitted)


def fits_of(rec, setting, kmax=None):
    kmax = KMAX if kmax is None else kmax
    for c in rec["cands"]:
        if c["rank"] >= kmax:
            break
        f = c["fits"].get(setting)
        if f and f["ok"]:
            yield c, f


def overlap(a, b) -> float:
    return len(a & b) / max(min(len(a), len(b)), 1)


def calibrate_tau(recs, setting, q=95.0) -> dict:
    """Acceptance threshold on the normalised cost: q-th percentile of the best true candidate per DEV-A window."""
    best = []
    for r in recs:
        v = [f["snorm"] for c, f in fits_of(r, setting) if c["correct"]]
        if v:
            best.append(min(v))
    if not best:
        return dict(tau=np.nan, n=0)
    # robust tail: q-th percentile, capped at TAIL x median (a few badly fitting true windows, e.g. the erratic GPS of the Grimone gorge, would otherwise open the gate)
    tau = min(float(np.percentile(best, q)), TAIL * float(np.median(best)))
    return dict(tau=tau, n=len(best), q=q, median=float(np.median(best)), max=float(np.max(best)), q_raw=float(np.percentile(best, q)))


def accepted(rec, setting, tau):
    return [(c, f) for c, f in fits_of(rec, setting) if f["snorm"] <= tau]


def decide(rec, setting, tau, m):
    """-> (candidate, fit, margin) of the decision or None."""
    acc = accepted(rec, setting, tau)
    if not acc:
        return None
    acc.sort(key=lambda cf: cf[1]["cost"])
    c1, f1 = acc[0]
    rest = [cf for cf in acc[1:] if overlap(cf[0]["edges"], c1["edges"]) < 0.5]
    margin = (rest[0][1]["cost"] - f1["cost"]) / max(f1["n"], 1) if rest else np.inf
    if margin >= m:
        return c1, f1, margin
    return None


def outcome(d):
    if d is None:
        return "none"
    return "correct" if d[0]["correct"] else "wrong"


def adjacent(fa, fb) -> bool | None:
    """True/False if the two fits share >= ADJ_MIN_OVERLAP_S of video time, else None."""
    ta, xa = fa["trace"]
    tb, xb = fb["trace"]
    lo, hi = max(ta[0], tb[0]), min(ta[-1], tb[-1])
    if hi - lo < ADJ_MIN_OVERLAP_S:
        return None
    t = np.linspace(lo, hi, 20)
    pa = np.column_stack([np.interp(t, ta, xa[:, 0]), np.interp(t, ta, xa[:, 1])])
    pb = np.column_stack([np.interp(t, tb, xb[:, 0]), np.interp(t, tb, xb[:, 1])])
    return bool(np.median(np.hypot(*(pa - pb).T)) <= ADJ_M)


def apply_adjacency(recs, decisions):
    """decisions: list parallel to recs of decide() results. Two decisions of overlapping windows (same L) that are not adjacent on the map are both dropped."""
    out = list(decisions)
    idx = sorted(range(len(recs)), key=lambda i: (recs[i]["L"], recs[i]["lo"]))
    n_pairs = n_bad = 0
    for a in range(len(idx)):
        i = idx[a]
        if decisions[i] is None:
            continue
        for b in range(a + 1, len(idx)):
            j = idx[b]
            if recs[j]["L"] != recs[i]["L"] or recs[j]["lo"] >= recs[i]["hi"]:
                break
            if decisions[j] is None:
                continue
            ok = adjacent(decisions[i][1], decisions[j][1])
            if ok is None:
                continue
            n_pairs += 1
            if not ok:
                n_bad += 1
                out[i] = out[j] = None
    return out, n_pairs, n_bad


def estimate_video_level(recs, setting, tau, min_windows=3):
    """median rho and kappa of the best accepted candidate per window (no margin needed)."""
    rh, kp = [], []
    for r in recs:
        acc = accepted(r, setting, tau)
        if acc:
            f = min(acc, key=lambda cf: cf[1]["cost"])[1]
            rh.append(f["rho"]); kp.append(f["kappa"])
    if len(rh) < min_windows:
        return None
    return dict(rho=float(np.median(rh)), kappa=float(np.median(kp)), n=len(rh), rho_iqr=[float(np.percentile(rh, 25)), float(np.percentile(rh, 75))],
                kappa_iqr=[float(np.percentile(kp, 25)), float(np.percentile(kp, 75))])
