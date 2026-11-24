# SPDX-License-Identifier: AGPL-3.0-or-later
"""Odometry failure handling on the route side (GOTTHARD_DIAGNOSIS section 2.4/2.5, recommendation 2).

The vms distance can fail without the scene changing: sun straight ahead on smooth asphalt (Gotthard valley road 4:22-5:36) leaves only 20-50 % of the pairs
usable, and the "good" ones say 0.0-0.1 x the median speed while the car drives fast. A standstill looks different: its slow pairs fit well (usable 0.8-0.9 on
Madone, Amalfi). So a stretch of LOW USABLE SHARE is a failure, not a slow car:

- failure stretches (usable share in +-ODO_FAIL_WIN_S below ODO_FAIL_USABLE for at least ODO_FAIL_MIN_S) are cut out of the tracks and become gaps;
- a failure gap gets its nominal distance from the speeds on BOTH sides (ODO_NB_S each), and a wide systematic sd (ODO_GAP_REL of the gap) with more sub-steps
  (ODO_GAP_UPPER x), so the HMM can stretch it to a multiple of the prior (wide upper tail; the advance per sub-step is limited to about 2.4 cells);
- every gap's distance error is systematic: total sd = rel x gap length, the same for any step length (sub-step rel = rel x sqrt(n), no cap). Before, the
  per-sub-step rel was capped at 1, so the 15 m local pass gave long gaps sqrt(2) less slack than the 30 m search;
- emitting steps where the usable share in +-ODO_LOW_WIN_S is below ODO_LOW_USABLE get relative distance sd ODO_LOW_REL;
- heading across gaps (ROT_BRIDGE_ON): the sub-steps of every gap (vms speed gaps and failure gaps, never cut jumps) get far-feature-only heading increments
  where the far windows are valid (rotation/far_heading.npz, tracks.FarHeading); their distance treatment is unchanged.

route_steps() is THE step builder of every route-side step (map info, route_search, plausibility, refine, local pass): the same steps for the same d0.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from rsm.odometry import gating
from rsm.odometry.calib import CAMERA_HEIGHT_M
from rsm.odometry.vms_csv import load_pairs

from . import config as C
from . import standstill as SS
from . import tracks as T


def quality(p, fl) -> dict:
    """usable share around any time: good pairs / pairs that count (cuts and the excluded intro do not count). A pair rejected only for its rms
    below C.ODO_FAIL_RMS_PX counts as good here: gating's 0.8 px traffic gate (2026-11-17) is for the speed, not a failure signal."""
    rms = getattr(p, "rms_px", None)
    good = fl == 0
    if rms is not None:
        good = good | ((fl == gating.HIGH_RMS) & (np.nan_to_num(np.asarray(rms, float), nan=np.inf) <= C.ODO_FAIL_RMS_PX))
    cnt = (fl & (gating.CUT | gating.EXCLUDED)) == 0
    cg = np.concatenate([[0], np.cumsum(good & cnt)])
    cc = np.concatenate([[0], np.cumsum(cnt)])
    tm = np.asarray(p.time, float)

    def usable(t, half):
        t = np.asarray(t, float)
        a = np.searchsorted(tm, t - half); b = np.searchsorted(tm, t + half)
        n = cc[b] - cc[a]
        return np.where(n > 0, (cg[b] - cg[a]) / np.maximum(n, 1), 1.0)
    return dict(usable=usable, time=tm, good=good & cnt, s=np.asarray(p.s, float), dt=float(p.dt))


def fail_spans(q: dict, usable_thr: float | None = None, win: float | None = None, min_s: float | None = None, merge_s: float | None = None) -> list[tuple[float, float]]:
    """time spans of odometry failure: usable share below the threshold, runs merged across short good bits, at least min_s long"""
    usable_thr = C.ODO_FAIL_USABLE if usable_thr is None else usable_thr
    win = C.ODO_FAIL_WIN_S if win is None else win
    min_s = C.ODO_FAIL_MIN_S if min_s is None else min_s
    merge_s = C.ODO_FAIL_MERGE_S if merge_s is None else merge_s
    tm = q["time"]
    if len(tm) == 0:
        return []
    tb = np.arange(np.floor(tm[0]), np.ceil(tm[-1]) + 1.0, 1.0)
    bad = q["usable"](tb, win) < usable_thr
    e = np.diff(np.concatenate([[0], bad.astype(np.int8), [0]]))
    runs = [[float(tb[a]), float(tb[b - 1]) + 1.0] for a, b in zip(np.flatnonzero(e == 1), np.flatnonzero(e == -1))]
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < merge_s:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(a, b) for a, b in merged if b - a >= min_s]


def split_tracks(tracks: list[dict], spans) -> list[dict]:
    """tracks without their samples inside the spans; a track cut by a span continues as a new track after it (flag `odo_fail_before`)"""
    if not spans:
        return list(tracks)
    out = []
    for tr in tracks:
        t = np.asarray(tr["t"], float)
        inside = np.zeros(len(t), bool)
        for a, b in spans:
            inside |= (t >= a) & (t <= b)
        if not inside.any():
            out.append(tr)
            continue
        e = np.diff(np.concatenate([[0], (~inside).astype(np.int8), [0]]))
        for i, (a, b) in enumerate(zip(np.flatnonzero(e == 1), np.flatnonzero(e == -1))):
            if b - a < 2:
                continue
            s = np.asarray(tr["s"], float)[a:b]
            piece = dict(t=t[a:b], s=s - s[0], th=np.asarray(tr["th"], float)[a:b])
            if a == 0 and tr.get("cut_before") is not None:
                piece["cut_before"] = tr["cut_before"]
            if a > 0:
                piece["odo_fail_before"] = True
            out.append(piece)
    return out


def _overlaps(t0: float, t1: float, spans) -> bool:
    return any(min(t1, b) - max(t0, a) > 0.5 for a, b in spans)


def _speed(q: dict, t0: float, t1: float, spans) -> float | None:
    """nominal m/s of the good pairs in [t0, t1] outside the spans (mean, as the tracks accumulate distance), None if too few"""
    tm = q["time"]
    m = (tm >= t0) & (tm <= t1) & q["good"]
    for a, b in spans:
        m &= ~((tm >= a) & (tm <= b))
    if m.sum() < 10:
        return None
    return float(C.F360 * CAMERA_HEIGHT_M * np.mean(np.maximum(np.nan_to_num(q["s"][m]), 0.0)) / q["dt"])


def fail_gap_nominal(q: dict, tracks: list[dict], spans) -> list:
    """per track: prior nominal metres of the failure gap before it (None: not a failure gap). Speed = mean of the speeds before and after the gap"""
    out = [None]
    for a, b in zip(tracks[:-1], tracks[1:]):
        t0, t1 = float(a["t"][-1]), float(b["t"][0])
        if b.get("cut_before") is not None or not _overlaps(t0, t1, spans):
            out.append(None)
            continue
        vs = [v for v in (_speed(q, t0 - C.ODO_NB_S, t0, spans), _speed(q, t1, t1 + C.ODO_NB_S, spans)) if v is not None]
        v = float(np.mean(vs)) if vs else _speed(q, -np.inf, np.inf, spans) or 0.0
        out.append(C.ODO_GAP_MU_X * v * max(t1 - t0, 0.0))
    return out


def _gap_runs(st):
    g = np.asarray(st.gap, bool)
    e = np.diff(np.concatenate([[0], g.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(e == 1).tolist(), np.flatnonzero(e == -1).tolist()))


def shape_steps(st, spans, d0: float, low_usable=None, gap_dth=None):
    """systematic gap sd, failure gaps with more sub-steps and a wide sd, low-usable emitting steps with a wide sd (see module doc)"""
    T_, DT, MU, REL, V, GAP, SEG = ([] for _ in range(7))
    has_jump = getattr(st, "jump", None) is not None
    JMP = [] if has_jump else None
    pos = 0

    def take(a, b):
        for L, f in zip((T_, DT, MU, REL, V, GAP, SEG), ("t", "dth", "mu", "rel", "v", "gap", "seg")):
            L.extend(np.asarray(getattr(st, f))[a:b].tolist())
        if JMP is not None:
            JMP.extend(np.asarray(st.jump, bool)[a:b].tolist())
    for a, b in _gap_runs(st):
        take(pos, a)
        pos = b
        mu = np.asarray(st.mu[a:b], float)
        if np.all(mu == T.CUT_SUB_MU):            # cut jump (tracks.steps_of): own model
            take(a, b)
            continue
        n, gnom = b - a, float(mu.sum())
        tp, te = (float(st.t[a - 1]) if a > 0 else float(st.t[a])), float(st.t[b - 1])
        if _overlaps(tp, te, spans):
            ng = max(n, int(round(C.ODO_GAP_UPPER * gnom / d0)), 1)
            rel = C.ODO_GAP_REL * np.sqrt(ng)
            v = gnom / max(te - tp, 1e-3)
            for q in range(1, ng + 1):
                ta_, tb_ = tp + (te - tp) * (q - 1) / ng, tp + (te - tp) * q / ng
                T_.append(tb_); DT.append(np.nan if gap_dth is None else float(gap_dth(ta_, tb_))); MU.append(gnom / ng); REL.append(rel); V.append(v); GAP.append(True); SEG.append(int(st.seg[a]))
                if JMP is not None:
                    JMP.append(False)
        else:
            take(a, b)
            REL[-n:] = [C.GAP_SYS_REL * np.sqrt(n)] * n
    take(pos, st.T)
    jmp_arr = np.array(JMP, bool) if JMP is not None else None
    out = st.copy(t=np.array(T_), dth=np.array(DT), mu=np.array(MU), rel=np.array(REL), v=np.array(V), gap=np.array(GAP, bool), seg=np.array(SEG),
                  jump=jmp_arr if (jmp_arr is not None and jmp_arr.any()) else None)
    if low_usable is not None and out.T > 1:
        u = low_usable(out.t, C.ODO_LOW_WIN_S)
        widen = (~out.gap) & (u < C.ODO_LOW_USABLE)
        widen[0] = False
        out = out.copy(rel=np.where(widen, np.maximum(out.rel, C.ODO_LOW_REL), out.rel))
    return out


def far_heading_of(csv: str | None):
    """the project's far-only heading (rotation/far_heading.npz next to motion/motion.csv) when ROT_BRIDGE_ON, else None (old projects: no file, no bridge)"""
    if not C.ROT_BRIDGE_ON or csv is None:
        return None
    return T.load_far_heading(Path(csv).parent.parent / "rotation" / "far_heading.npz")


def still_spans_of(csv: str | None) -> list[tuple[float, float]]:
    """sure standstill spans of the project (rotation/standstill.json next to motion/motion.csv), [] if none"""
    if csv is None or not C.STILL_ON:
        return []
    return SS.load_spans(Path(csv).parent.parent)


def still_gap_nominal(csv: str, tracks: list[dict], still) -> list:
    """per track: MEASURED nominal metres of the gap before it if that gap contains a sure standstill (None otherwise): the vms distance of the pairs in the
    gap outside the standstill (the approach and the start, negative speeds as 0, unfitted pairs as the median of the fitted), zero inside it"""
    out = [None] * len(tracks)
    if not still:
        return out
    p = load_pairs(csv)
    fl = gating.pair_flags(p)
    good = (fl & (gating.NO_FIT | gating.HIGH_RMS | gating.CUT | gating.EXCLUDED)) == 0
    inside = np.zeros(len(p.time), bool)
    for a, b in still:
        inside |= (p.time >= a) & (p.time < b)
    k = C.F360 * CAMERA_HEIGHT_M
    for i, (a, b) in enumerate(zip(tracks[:-1], tracks[1:]), start=1):
        t0, t1 = float(a["t"][-1]), float(b["t"][0])
        if b.get("cut_before") is not None or not any(min(t1, y) > max(t0, x) for x, y in still):
            continue
        m = (p.time > t0) & (p.time < t1) & ~inside
        sp = np.maximum(np.nan_to_num(p.s[m]), 0.0)
        gm = good[m]
        med = float(np.median(sp[gm])) if gm.any() else 0.0
        out[i] = float(k * np.where(gm, sp, med).sum())
    return out


def apply_still(tracks: list[dict], csv: str | None, gap_nom: list | None = None) -> tuple[list[dict], list | None, list]:
    """tracks without their samples inside sure standstills (phantom distance and heading of passing traffic gone), and the gap nominals with the
    standstill gaps measured -> (tracks, gap_nom or None, spans). Unchanged when there is no span."""
    still = still_spans_of(csv)
    if not still:
        return tracks, gap_nom, []
    tr = split_tracks(tracks, still)
    sg = still_gap_nominal(csv, tr, still)
    if gap_nom is not None and len(gap_nom) != len(tr):
        gap_nom = T.gap_nominal(csv, tr)            # the caller measured on the unsplit tracks: measure again on the pieces
    base = gap_nom if gap_nom is not None else [None] * len(tr)
    gn = [s if s is not None else g for s, g in zip(sg, base)]
    return tr, (gn if (gap_nom is not None or any(x is not None for x in sg)) else None), still


def build(tracks: list[dict], csv: str | None, d0: float | None = None, measure_gaps: bool = False, gap_dth="auto"):
    """-> (steps, info). csv None or ODO_FAIL_ON off: tracks.steps_of as before (with measured gaps if asked).
    gap_dth: heading of gap sub-steps ("auto": the project's far_heading_of(csv); None: gap sub-steps never emit)"""
    d0 = C.D0 if d0 is None else d0
    if isinstance(gap_dth, str):
        gap_dth = far_heading_of(csv)
    have = csv is not None and Path(csv).exists()
    tracks, sgn, still = apply_still(tracks, csv) if have else (tracks, None, [])
    if not C.ODO_FAIL_ON or not have:
        gn = T.gap_nominal(csv, tracks) if (measure_gaps and have) else None
        if sgn is not None:
            gn = [s if s is not None else g for s, g in zip(sgn, gn or [None] * len(tracks))]
        kw = {} if gap_dth is None else dict(gap_dth=gap_dth)
        st = T.steps_of(tracks, **kw) if (d0 == C.D0 and gn is None) else T.steps_of(tracks, d0=d0, gap_nom=gn, **kw)
        return st, dict(on=False, spans=[], gaps_measured=sum(x is not None for x in (gn or [None])[1:]))
    p = load_pairs(csv)
    fl = gating.pair_flags(p)
    q = quality(p, fl)
    spans = fail_spans(q)
    tr = split_tracks(tracks, spans)
    fg = fail_gap_nominal(q, tr, spans)
    gn = T.gap_nominal(csv, tr) if measure_gaps else [None] * len(tr)
    sg = still_gap_nominal(csv, tr, still)
    gn = [s if s is not None else (f if f is not None else m) for s, f, m in zip(sg, fg, gn)]   # a sure standstill wins over a failure estimate
    st = T.steps_of(tr, d0=d0, gap_nom=gn, **({} if gap_dth is None else dict(gap_dth=gap_dth)))
    st = shape_steps(st, spans, d0, q["usable"], gap_dth=gap_dth)
    info = dict(on=True, spans=[[round(a, 1), round(b, 1)] for a, b in spans], fail_s=float(sum(b - a for a, b in spans)),
                gaps_measured=int(sum(x is not None and f is None for x, f in zip(gn[1:], fg[1:]))), low_usable_steps=int(np.sum((st.rel == C.ODO_LOW_REL) & ~st.gap)),
                gap_steps=int(st.gap.sum()), gap_steps_heading=int(np.sum(st.gap & np.isfinite(st.dth))),
                still=[[round(a, 2), round(b, 2)] for a, b in still], still_s=float(sum(b - a for a, b in still)))
    return st, info


def route_steps(d: Path, tracks: list[dict] | None = None, d0: float | None = None, measure_gaps: bool = False):
    """steps of the project d (rotation/tracks.pkl unless given) with the odometry failure handling"""
    import pickle
    d = Path(d)
    if tracks is None:
        tracks = pickle.load(open(d / "rotation" / "tracks.pkl", "rb"))
    return build(tracks, str(d / "motion" / "motion.csv"), d0=d0, measure_gaps=measure_gaps)[0]
