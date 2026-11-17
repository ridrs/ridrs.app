# SPDX-License-Identifier: AGPL-3.0-or-later
"""Windows, truth (GPS positions at video times), controls and the decision rule for the quanta matcher.

GPS is used only here: to decide which video quanta are inside the area (scoring), and to judge a chain. The matcher never sees it.
A window of consecutive in-area video quanta is CORRECT when its top chain has >= MIN_MATCHED matched quanta and for >= 70 % of them both
map turn positions lie within 50 m of the GPS position at the video time of the corresponding video turn.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, replace

import numpy as np

from rsm.network.graph import NetGraph

from . import area as areamod
from . import chain, gps, legs, video
from .chain import MapIndex, Params, match_window
from .qdef import mirror, take

TOL_M = 50.0
FRAC_OK = 0.7
MIN_MATCHED = 2
LENGTHS = (3, 5, 10, 20, 40)


@dataclass
class Ctx:
    video: str
    area: dict
    g: NetGraph
    gc: dict
    thr: float
    m: dict


def load_ctx(vid: str, thr: float = 45.0) -> Ctx:
    a = json.loads((areamod.WORK / f"area_{vid}.json").read_text())
    g = NetGraph.load(areamod.WORK / "cache" / f"graph_{vid}.npz")
    gc = gps.gps_curve(vid, g.crs)
    m = legs.load(areamod.WORK / f"map_{vid}_{int(thr)}.npz")
    return Ctx(vid, a, g, gc, thr, m)


def video_q(vid: str, label: str, thr: float) -> dict:
    """label: 'refined' | 'baseline' (vms CSVs, frozen configs) | 'gps' (GPS turns, upper bound; needs the ctx via gps_q)."""
    return video.video_quanta(video.segments(vid, label), thr)


def gps_q(ctx: Ctx, thr: float) -> dict:
    from .qdef import quanta_from_turns
    q = quanta_from_turns(gps.gps_turns(ctx.gc, thr))
    return q


def turn_positions(ctx: Ctx, q: dict) -> tuple[np.ndarray, np.ndarray]:
    """GPS positions at the video times of the two turn midpoints of each quantum."""
    return gps.pos_at(ctx.gc, q["tm1"]), gps.pos_at(ctx.gc, q["tm2"])


def scorable(ctx: Ctx, q: dict) -> np.ndarray:
    """In-area video quanta (both turn positions of the GPS track inside the area bbox and the GPS time covered)."""
    p1, p2 = turn_positions(ctx, q)
    t_ok = (q["tm1"] >= ctx.gc["t"][0]) & (q["tm2"] <= ctx.gc["t"][-1])
    return t_ok & areamod.inside(ctx.area, p1, ctx.g.crs) & areamod.inside(ctx.area, p2, ctx.g.crs)


def windows(mask: np.ndarray, L: int, step: int | None = None) -> list[tuple[int, int]]:
    """Windows of L consecutive quanta that are all in `mask`, start step L//2 (>= 1)."""
    step = step or max(1, L // 2)
    out, n = [], len(mask)
    i = 0
    while i + L <= n:
        if mask[i:i + L].all():
            out.append((i, i + L))
            i += step
        else:
            bad = np.flatnonzero(~mask[i:i + L])
            i += max(1, int(bad[-1]) + 1) if len(bad) else step
    return out


def chain_quality(ix: MapIndex, ch: chain.Chain, q: dict, lo: int, pos1: np.ndarray, pos2: np.ndarray):
    """(frac within TOL of the matched quanta, n matched, per-quantum distances)."""
    if ch.n_matched == 0:
        return 0.0, 0, []
    d = []
    for qi, lg in ch.legs:
        a, b = ix.A[lg], ix.B[lg]
        d1 = float(np.hypot(*(ix.ev_mid[a] - pos1[lo + qi])))
        d2 = float(np.hypot(*(ix.ev_mid[b] - pos2[lo + qi])))
        d.append(max(d1, d2))
    d = np.array(d)
    return float((d <= TOL_M).mean()), len(d), d


def run_windows(ix: MapIndex, q: dict, wins, pos1, pos2, true_ok: np.ndarray | None = None) -> list[dict]:
    recs = []
    for (lo, hi) in wins:
        t0 = time.time()
        chains = match_window(ix, q, lo, hi)
        dt = time.time() - t0
        top = chains[0]
        gap = (top.score - chains[1].score) if len(chains) > 1 else 99.0
        fr, nm, _ = chain_quality(ix, top, q, lo, pos1, pos2)
        ok1 = nm >= MIN_MATCHED and fr >= FRAC_OK
        ok5 = ok1
        for c in chains[:5]:
            f, n, _ = chain_quality(ix, c, q, lo, pos1, pos2)
            if n >= MIN_MATCHED and f >= FRAC_OK:
                ok5 = True
        recs.append(dict(lo=lo, hi=hi, L=hi - lo, score=top.score, gap=gap, n_matched=nm, frac_ok=fr, ok1=bool(ok1), ok5=bool(ok5), sec=dt,
                         legs=[(lo + qi, int(lg)) for qi, lg in top.legs], logscale=top.log_scale, second=chains[1].score if len(chains) > 1 else None))
    return recs


def gap_threshold(rule: dict, L: int) -> float:
    """Gap needed for 'confident' at window length L: rule['gap_table'] ({L: gap}, linear in L, flat outside) or the constant rule['gap']."""
    tab = rule.get("gap_table")
    if not tab:
        return rule["gap"]
    xs = sorted(int(k) for k in tab)
    return float(np.interp(L, xs, [tab[str(k)] for k in xs]))


def confident(r: dict, rule: dict) -> bool:
    return r["gap"] >= gap_threshold(rule, r["L"]) and r["n_matched"] >= rule["min_matched"] and r["score"] >= rule.get("min_score", -1e9)


def summarize(recs: list[dict], rule: dict) -> dict:
    n = len(recs)
    if n == 0:
        return dict(n=0)
    conf = [r for r in recs if confident(r, rule)]
    return dict(n=n, top1=sum(r["ok1"] for r in recs), top5=sum(r["ok5"] for r in recs), confident=len(conf),
                conf_correct=sum(r["ok1"] for r in conf), conf_wrong=sum(not r["ok1"] for r in conf),
                sec_mean=float(np.mean([r["sec"] for r in recs])), matched_median=float(np.median([r["n_matched"] for r in recs])))
