# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sure standstill of the camera vehicle (research: work/standstill, docs/DECISIONS).

vms measures the motion on a road trapezoid. When the camera stands while a car passes close by, the car's flow is read as ego-motion (Amalfi 4881-4884 s:
1-2 m/s and about -22 deg of phantom turning). The test here looks at the WHOLE frame: whole-frame Lucas-Kanade over STILL_BASE_S, a global similarity
(RANSAC) as the hypothesis "the camera only sways / turns", and a grid of cells. If static cells cover most of the frame and nearly all of the part above the
horizon, the camera stands, whatever moves in one region of the picture.

Candidates are cheap to find from the stored series (vms speed below STILL_GATE_REL x median and no far-feature rotation); only those windows are decoded
(about 20-45 s per video hour on Amalfi). Long candidate runs are tested densely near their ends and sparsely inside; where two neighbouring samples
disagree, every window between them is tested (a stop inside a run whose ends still creep).

Result: rotation/standstill.json, spans [t0, t1) of SURE standstill, written at the end of the rotation step (the image side: the route side never
reads the video). Every route-side step treats them as measured (zero distance, far-only heading),
and the fusion holds the position there (steps_c.fuse). A measurement gap (odofail failure, cut, darkness) is something else and stays free.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import cv2
import numpy as np

from . import config as C

VERSION = 2
H, W = 360, 640


def _windows(d: Path):
    """per STILL_WIN_S window: median vms rel_speed / video median, and the far-only heading change (sum of |dth|) -> (t, rel, far)"""
    from rsm.odometry.vms_csv import load_pairs
    p = load_pairs(d / "motion" / "motion.csv")
    med = float(np.nanmedian(p.rel_speed))
    w = np.floor(p.time / C.STILL_WIN_S).astype(int)
    n = int(w.max()) + 1
    rel = np.full(n, np.nan)
    order = np.argsort(w, kind="stable")
    ws, rs = w[order], p.rel_speed[order]
    cuts = np.flatnonzero(np.diff(ws)) + 1
    for g_w, g_r in zip(np.split(ws, cuts), np.split(rs, cuts)):
        if np.isfinite(g_r).any():
            rel[g_w[0]] = np.nanmedian(g_r) / med if med > 0 else np.nan
    far = np.zeros(n)
    f = d / "rotation" / "far_heading.npz"
    if f.exists():
        z = np.load(f)
        mid = 0.5 * (z["ta"] + z["tb"])
        k = np.floor(mid / C.STILL_WIN_S).astype(int)
        ok = np.isfinite(z["dth"]) & (k >= 0) & (k < n)
        np.add.at(far, k[ok], np.abs(z["dth"][ok]))
    return np.arange(n) * C.STILL_WIN_S, rel, far


def candidates(d: Path) -> np.ndarray:
    """window start times that pass the cheap gate"""
    t, rel, far = _windows(d)
    ok = np.isfinite(rel) & (rel < C.STILL_GATE_REL) & (far < C.STILL_GATE_FAR)
    return t[ok]


def _track(a, b, mask):
    p0 = cv2.goodFeaturesToTrack(a, 600, 0.005, 8, mask=mask, blockSize=7)
    if p0 is None:
        return np.empty((0, 2)), np.empty((0, 2))
    from .vmsx import motion as M
    p1, s1, _ = cv2.calcOpticalFlowPyrLK(a, b, p0, None, **M.LK_PARAMS)
    bk, s2, _ = cv2.calcOpticalFlowPyrLK(b, a, p1, None, **M.LK_PARAMS)
    fb = np.linalg.norm((bk - p0).reshape(-1, 2), axis=1)
    g = (s1.ravel() == 1) & (s2.ravel() == 1) & (fb < M.MAX_FB_ERROR)
    return p0.reshape(-1, 2)[g].astype(float), p1.reshape(-1, 2)[g].astype(float)


def cell_shares(a: np.ndarray, b: np.ndarray, horizon: float) -> tuple[float, float] | None:
    """(share of static cells over the frame, share above the horizon) for one frame pair of grey 360-row frames; None if too few tracks"""
    h, w = a.shape
    mask = np.zeros((h, w), np.uint8)
    mask[int(0.04 * h):h - int(0.03 * h), :] = 255          # no letterbox / overlay rows at the very top and bottom
    p0, p1 = _track(a, b, mask)
    if len(p0) < 20:
        return None
    M, _ = cv2.estimateAffinePartial2D(p0, p1, method=cv2.RANSAC, ransacReprojThreshold=0.5, maxIters=500)
    if M is None:
        return None
    res = np.linalg.norm(p1 - (p0 @ M[:, :2].T + M[:, 2]), axis=1)
    gx, gy = C.STILL_GRID
    cx = np.clip((p0[:, 0] / w * gx).astype(int), 0, gx - 1)
    cy = np.clip((p0[:, 1] / h * gy).astype(int), 0, gy - 1)
    cnt = np.zeros((gy, gx)); ok = np.zeros((gy, gx))
    np.add.at(cnt, (cy, cx), 1)
    np.add.at(ok, (cy, cx), res < C.STILL_THR_PX * h / H)
    pop = cnt >= 3
    stat = pop & (ok >= C.STILL_CELL_SHARE * np.maximum(cnt, 1))
    up = pop & ((np.arange(gy) + 0.5) * h / gy <= horizon)[:, None]
    s_all = float(stat.sum() / pop.sum()) if pop.sum() else np.nan
    s_up = float((stat & up).sum() / up.sum()) if up.sum() else np.nan
    return s_all, s_up


def window_test(fr: list, i0: int, fps: float, horizon: float) -> dict:
    """the window starting at frame index i0 of fr: median shares of STILL_NPAIR pairs, and the decision"""
    k = max(1, round(C.STILL_BASE_S * fps))
    sh = []
    for j in range(C.STILL_NPAIR):
        i = i0 + round(j * fps / 6)
        if i + k < len(fr):
            r = cell_shares(fr[i], fr[i + k], horizon)
            if r is not None:
                sh.append(r)
    if not sh:
        return dict(stat_all=None, stat_up=None, still=False)
    a = np.array(sh, float)
    s_all, s_up = float(np.nanmedian(a[:, 0])), (float(np.nanmedian(a[:, 1])) if np.isfinite(a[:, 1]).any() else None)
    return dict(stat_all=round(s_all, 3), stat_up=None if s_up is None else round(s_up, 3),
                still=bool(s_all >= C.STILL_ALL and s_up is not None and s_up >= C.STILL_UP))


def plan(ts: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    """candidate runs (consecutive windows) -> per run (all windows, the windows to test): all within STILL_EDGE_S of the ends, one every STILL_SAMPLE_S inside"""
    if len(ts) == 0:
        return []
    ts = np.sort(np.asarray(ts, float))
    runs = np.split(ts, np.flatnonzero(np.diff(ts) > C.STILL_WIN_S + 1e-6) + 1)
    out = []
    for r in runs:
        a, b = r[0], r[-1] + C.STILL_WIN_S
        edge = (r < a + C.STILL_EDGE_S) | (r + C.STILL_WIN_S > b - C.STILL_EDGE_S)
        inner = np.flatnonzero(~edge)
        pick = edge.copy()
        if len(inner):
            step = max(1, int(round(C.STILL_SAMPLE_S / C.STILL_WIN_S)))
            pick[inner[::step]] = True
            pick[inner[-1]] = True
        out.append((r, r[pick]))
    return out


def spans_of(runs: list[tuple[np.ndarray, np.ndarray]], tested: dict[float, bool]) -> list[list[float]]:
    """sure spans: tested windows that are still, and the untested windows between two still tested ones of the same run; at least STILL_MIN_S long"""
    still = []
    for r, tw in runs:
        tw = np.sort(tw)
        for t in r:
            if t in tested:
                ok = tested[t]
            else:
                lo, hi = tw[tw < t], tw[tw > t]
                ok = len(lo) > 0 and len(hi) > 0 and tested[float(lo[-1])] and tested[float(hi[0])]
            if ok:
                still.append(float(t))
    if not still:
        return []
    still = np.array(still)
    parts = np.split(still, np.flatnonzero(np.diff(still) > C.STILL_WIN_S + 1e-6) + 1)
    sp = [[round(float(p[0]), 3), round(float(p[-1] + C.STILL_WIN_S), 3)] for p in parts]
    return [s for s in sp if s[1] - s[0] >= C.STILL_MIN_S - 1e-6]


def _horizon(d: Path) -> float:
    m = json.loads((d / "motion" / "motion.json").read_text())
    return float(m.get("horizon_vms") or (m["roi"][0] - 0.02 * H))


def refill(runs: list[tuple[np.ndarray, np.ndarray]], tested: dict[float, bool]) -> list[float]:
    """untested windows between two neighbouring tested windows of a run whose results differ: where the state changes, every window is tested"""
    out = []
    for r, _ in runs:
        tw = np.array(sorted(t for t in r.tolist() if t in tested))
        for a, b in zip(tw[:-1], tw[1:]):
            if tested[float(a)] != tested[float(b)]:
                out += [float(t) for t in r if a < t < b and float(t) not in tested]
    return sorted(set(out))


def _blocks(ts) -> list[np.ndarray]:
    ts = np.sort(np.asarray(ts, float))
    return np.split(ts, np.flatnonzero(np.diff(ts) > C.STILL_WIN_S + 1e-6) + 1) if len(ts) else []


def detect(d: Path, video: str, progress=None) -> dict:
    """decode the candidate windows, test them, write rotation/standstill.json -> its content"""
    from .vmsx.decode import frames, probe
    d = Path(d)
    t0 = time.time()
    runs = plan(candidates(d))
    fps = probe(video).fps
    hz = _horizon(d)
    tested: dict[float, bool] = {}
    rows = []

    def test(ts, p0, p1):
        blocks = _blocks(ts)                      # contiguous windows -> one decode each
        for gi, blk in enumerate(blocks):
            a = float(blk[0])
            dur = float(blk[-1] - blk[0]) + C.STILL_WIN_S + C.STILL_BASE_S + 0.05
            fr = [f for _, f in frames(video, H, start=a, duration=dur)]
            for t in blk:
                r = window_test(fr, round((float(t) - a) * fps), fps, hz)
                tested[float(t)] = r["still"]
                rows.append(dict(t=float(t), **r))
            if progress:
                progress(p0 + (p1 - p0) * (gi + 1) / len(blocks))
    test(np.concatenate([tw for _, tw in runs]) if runs else [], 0.0, 0.8)
    for k in range(3):                            # where the state changes between two samples, test every window in between
        fill = refill(runs, tested)
        if not fill:
            break
        test(fill, 0.8 + 0.06 * k, 0.86 + 0.06 * k)
    rows.sort(key=lambda x: x["t"])
    sp = spans_of(runs, tested)
    res = dict(version=VERSION, spans=sp, n_candidates=int(sum(len(r) for r, _ in runs)), n_runs=len(runs), n_tested=len(rows), seconds=round(time.time() - t0, 1),
               params=dict(gate_rel=C.STILL_GATE_REL, gate_far=C.STILL_GATE_FAR, base_s=C.STILL_BASE_S, thr_px=C.STILL_THR_PX, all=C.STILL_ALL, up=C.STILL_UP,
                           min_s=C.STILL_MIN_S), windows=rows)
    (d / "rotation").mkdir(exist_ok=True)
    (d / "rotation" / "standstill.json").write_text(json.dumps(res, indent=1))
    return res


def load_spans(d: Path) -> list[tuple[float, float]]:
    """the sure spans of project d ([] when switched off or not detected yet)"""
    f = Path(d) / "rotation" / "standstill.json"
    if not C.STILL_ON or not f.exists():
        return []
    return [(float(a), float(b)) for a, b in json.loads(f.read_text())["spans"]]
