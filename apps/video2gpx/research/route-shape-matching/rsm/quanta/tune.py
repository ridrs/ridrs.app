# SPDX-License-Identifier: AGPL-3.0-or-later
"""DEV-only parameter and decision-rule tuning (Grimone, Roanne). Never touches the TEST video."""
from __future__ import annotations

import itertools
import json
import sys
from dataclasses import asdict, replace

import numpy as np

from . import evalrun as ev
from .chain import MapIndex, Params
from .qdef import mirror, take

DEV = ("col-de-grimone-1", "vallee-de-roanne")
LS = (5, 10, 20)


class DevData:
    def __init__(self, videos=DEV, thr=45.0):
        self.v = {}
        for vid in videos:
            ctx = ev.load_ctx(vid, thr)
            d = dict(ctx=ctx)
            for src in ("refined", "gps"):
                q = ev.video_q(vid, "refined", thr) if src == "refined" else ev.gps_q(ctx, thr)
                d[src] = (q, ev.scorable(ctx, q), *ev.turn_positions(ctx, q))
            self.v[vid] = d

    def evaluate(self, p: Params, controls: bool = True, lengths=LS):
        """records[(video, source, L)] -> list of window records."""
        out = {}
        for vid, d in self.v.items():
            ix = MapIndex(d["ctx"].m, p)
            for src in ("refined", "gps"):
                q, mask, p1, p2 = d[src]
                for L in lengths:
                    out[(vid, src, L)] = ev.run_windows(ix, q, ev.windows(mask, L), p1, p2)
            if controls:
                q, mask, p1, p2 = d["refined"]
                qm = mirror(q)
                perm = np.random.default_rng(7).permutation(np.flatnonzero(mask))
                qs = take(q, perm)
                s1, s2 = ev.turn_positions(d["ctx"], qs)
                for L in lengths:
                    out[(vid, "mirror", L)] = ev.run_windows(ix, qm, ev.windows(mask, L), p1, p2)
                    out[(vid, "shuffle", L)] = ev.run_windows(ix, qs, ev.windows(np.ones(len(perm), bool), L), s1, s2)
                for other in self.v:
                    if other == vid:
                        continue
                    oix = MapIndex(self.v[other]["ctx"].m, p)
                    for L in lengths:
                        out[(vid, "foreign", L)] = out.get((vid, "foreign", L), []) + ev.run_windows(oix, q, ev.windows(mask, L), p1, p2)
        return out


def score_top1(out, src="refined", lengths=LS):
    return {L: (sum(r["ok1"] for (v, s, l), rs in out.items() if s == src and l == L for r in rs), sum(len(rs) for (v, s, l), rs in out.items() if s == src and l == L)) for L in lengths}


def rule_eval(out, rule, lengths=LS):
    res = {}
    for src in ("refined", "gps", "mirror", "shuffle", "foreign"):
        c = w = n = 0
        for (v, s, L), rs in out.items():
            if s != src or L not in lengths:
                continue
            for r in rs:
                n += 1
                if ev.confident(r, rule):
                    c += r["ok1"]
                    w += not r["ok1"]
        res[src] = dict(n=n, conf_correct=c, conf_wrong=w)
    return res
