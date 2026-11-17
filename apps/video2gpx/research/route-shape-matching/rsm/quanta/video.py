# SPDX-License-Identifier: AGPL-3.0-or-later
"""Video quanta from vms segments (frozen configurations of work/vangestel/frozen_params.json). vms itself is not re-run.

Turns of all usable segments are pooled in time order. Two consecutive turns in one segment have a measured straight (nominal m). Across
a vms gap (different segments) the straight is only estimated (rest of the first segment + gap time x mean speed + start of the next
segment) and the quantum is marked `unc` ("uncertain length"); so is a quantum with a clipped turn (segment edge).
"""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import numpy as np

from rsm.odometry import gating, heading
from rsm.odometry.turns import TurnParams, detect_turns
from rsm.odometry.vms_csv import load_pairs

from .qdef import TurnRec, quanta_from_turns

WORK = Path(__file__).resolve().parents[2] / "work"
FROZEN = WORK / "vangestel" / "frozen_params.json"


def config(label: str, video: str) -> dict:
    c = dict(json.loads(FROZEN.read_text())["configs"][label])
    c["csv"] = str(WORK.parent / c["csv"].format(video=video))
    return c


def segments(video: str, label: str = "refined"):
    """[(t0, t1, s_total, turns)] per usable segment; turns are rsm Turn objects (>= 25 deg)."""
    cfg = config(label, video)
    p = load_pairs(cfg["csv"])
    fl = gating.pair_flags(p)
    segs = gating.build_segments(p, fl, gating.GateParams())
    tp = replace(TurnParams(**{**TurnParams().to_dict(), **cfg.get("turn", {})}), min_angle_deg=25.0)
    out = []
    for i, sg in enumerate(segs):
        if not sg.usable:
            continue
        tr = heading.integrate(p, sg, fl, cfg["f360"], dist_scale=cfg.get("dist_scale", 1.0))
        out.append((sg.t0, sg.t1, float(tr.s[-1]), detect_turns(tr.s, tr.theta, tr.t, tp), i))
    return out


def video_turns(segs, thr: float):
    """Pool the turns >= thr of all segments: list of TurnRec (seg = segment index) plus per-turn tail/head distances."""
    turns, tails, heads = [], [], []
    for (t0, t1, stot, ts, si) in segs:
        for t in ts:
            if abs(t.angle_deg) < thr:
                continue
            turns.append(TurnRec(t.sign, abs(t.angle_deg), t.length_m, t.s_start, t.s_end, t.t_start, t.t_end, seg=si, clipped=t.clipped))
            tails.append(stot - t.s_end)
            heads.append(t.s_start)
    return turns, tails, heads


def video_quanta(segs, thr: float = 45.0) -> dict:
    """Quanta dict (qdef fields) of the video at threshold thr."""
    turns, tails, heads = video_turns(segs, thr)
    seginfo = {si: (t0, t1, stot) for (t0, t1, stot, _, si) in segs}
    straights, unc = [], []
    for k in range(len(turns) - 1):
        a, b = turns[k], turns[k + 1]
        u = a.clipped or b.clipped
        if a.seg == b.seg:
            straights.append(b.s0 - a.s1)
        else:
            ta, tb = seginfo[a.seg], seginfo[b.seg]
            v = 0.5 * (ta[2] / (ta[1] - ta[0]) + tb[2] / (tb[1] - tb[0]))  # nominal m/s
            straights.append(tails[k] + max(tb[0] - ta[1], 0.0) * v + heads[k + 1])
            u = True
        unc.append(u)
    q = quanta_from_turns(turns, straights, unc)
    q["turns_t"] = np.array([[t.t0, t.t1] for t in turns])
    return q


def total_length(segs) -> float:
    return float(sum(s[2] for s in segs))
