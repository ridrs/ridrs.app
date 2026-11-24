# SPDX-License-Identifier: AGPL-3.0-or-later
"""Scene cuts of an edited video (F4): detection from the data of the motion and rotation passes (no extra decode), and the plan of what a cut means
for the route: a JUMP, not continuous riding.

Detection (classical, three cues on the frame pairs the vms pass already analysed):
  spike   the frame difference of a pair (vms `diff`, mean |grey difference| at 1/4 resolution) above CUT_FACTOR x its 61-pair running median and above
          CUT_MIN_DIFF (the constants of rsm.odometry.gating's cut flag), and an IMPULSE: above CUT_IMPULSE x the largest difference of the +-3 pairs around it.
          A cut changes the picture between two frames, so exactly one pair jumps; a bump, a flash or a pan raises several pairs in a row.
          Strong-impulse gate: a pair under that gate is a spike too when its impulse is above CUT_STRONG_IMPULSE, its difference above CUT_STRONG_FACTOR x
          the running median and CUT_STRONG_MIN_DIFF, and the road-flow fit collapses at that one pair (fewer than MIN_INLIERS points, a median of at least
          CUT_STRONG_AROUND around it, every pair of the +-3 around it at CUT_STRONG_NB_SHARE of that median): a hard cut after a busy shot or with a
          moderate jump (candidate field `strong`).
  vms     the road-flow model fails at that pair: fewer than MIN_INLIERS road points fit, or fewer than CUT_INL_SHARE of the median inliers around it.
  far     the far-feature rotation fit of the window across that pair fails (no band fits) or keeps fewer than CUT_INL_SHARE of the inliers around it.
A pair is a cut when it is a spike and at least one of the two model cues agrees. Cuts closer than CUT_MERGE_S are one cut.
Same-scene veto (CUT_SAME_ON, the only extra decode): the frame before and the frame after the jump of every cut are compared (points tracked on the
brightness-normalised frames, one similarity by RANSAC). A sun flash or an exposure jump spikes the difference and breaks the road-flow fit, but the scene
stays: if CUT_SAME_SHARE of the corners fit, it is no cut (kept in cuts.json as `rejected`).

Plan (applied to the heading/distance tracks of the rotation step, stored in them as `cut_before`):
  - the tracks are already split at every cut pair of gating's own cut flag (the main gate); a track that spans a confirmed cut (one of the strong-impulse
    gate) is split there (pieces shorter than tracks.MIN_SEG_SAMPLES samples are dropped). A track that follows a cut carries cut_before = the cut time.
    Nothing else changes for a video without cuts (the tracks and every later result stay byte-identical).
  - a piece between two cuts that lasts less than CUT_MIN_PIECE_S is an inserted shot (title, close-up): its tracks are dropped and it is reported.
  - start rule (maintainer): with cuts in the first CUT_INTRO_S seconds the route starts after the LAST of them; tracks before it are dropped (the video time
    stays the time base; the GPX starts at that second).
  - the steps (tracks.steps_of) bridge a cut by a free jump forward along the graph of up to about CUT_JUMP_M; the smoother (steps_c.fuse) holds the position
    up to the cut and lets it jump without any distance prior.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import subprocess

import cv2
import numpy as np
from scipy.ndimage import median_filter

from rsm.odometry.gating import GateParams

from . import config as C

VERSION = "cuts4"          # cuts4: multi-type transition detector (hard cuts on low-inlier roads, crossfades/dissolves, fade-through-black/white)
_GP = GateParams()
MIN_INLIERS = 20


def _local_median(x: np.ndarray, i: int, half: int) -> float:
    a = np.concatenate([x[max(0, i - half):i], x[i + 1:i + 1 + half]])
    a = a[np.isfinite(a)]
    return float(np.median(a)) if len(a) else float("nan")


def candidates(time: np.ndarray, diff: np.ndarray, inliers: np.ndarray) -> list[dict]:
    """spike pairs of the vms csv (columns time, diff, inliers) with their vms cue. -> [{i, t, diff, base, impulse, inliers, inliers_around, vms}]"""
    d = np.nan_to_num(np.asarray(diff, float))
    n = len(d)
    if n < 8:
        return []
    inl = np.nan_to_num(np.asarray(inliers, float))
    base = median_filter(d, size=_GP.cut_median_window, mode="nearest")
    main = (d > _GP.cut_factor * np.maximum(base, 1.0)) & (d > _GP.cut_min_diff)
    weak = ~main & (d > C.CUT_STRONG_FACTOR * np.maximum(base, 1.0)) & (d > C.CUT_STRONG_MIN_DIFF) & (inl < MIN_INLIERS)
    out = []
    for i in np.flatnonzero(main | weak):
        nb = np.concatenate([d[max(0, i - 3):i], d[i + 1:i + 4]])
        imp = float(d[i] / max(float(nb.max()) if len(nb) else 0.0, 1.0))
        around = _local_median(inl, int(i), 25)
        if weak[i]:                      # strong-impulse gate: the road-flow fit collapses at this one pair
            nbi = np.concatenate([inl[max(0, i - 3):i], inl[i + 1:i + 4]])
            if (imp < C.CUT_STRONG_IMPULSE or not np.isfinite(around) or around < C.CUT_STRONG_AROUND
                    or not len(nbi) or nbi.min() < C.CUT_STRONG_NB_SHARE * around):
                continue
        elif imp < C.CUT_IMPULSE:
            continue
        vms = bool(inl[i] < MIN_INLIERS or (np.isfinite(around) and inl[i] < C.CUT_INL_SHARE * around))
        out.append(dict(i=int(i), t=float(time[i]), diff=round(float(d[i]), 3), base=round(float(base[i]), 3), impulse=round(imp, 2), inliers=int(inl[i]),
                        inliers_around=None if not np.isfinite(around) else float(around), vms=vms, strong=bool(weak[i])))
    return out


def far_cue(cands: list[dict], ta: np.ndarray, tb: np.ndarray, ok: np.ndarray, n_inl: np.ndarray) -> list[dict]:
    """adds `far` (bool or None when no window covers the pair) to every candidate: windows [ta, tb) of the far-feature pass, ok / n_inl per (window, band)"""
    ok = np.asarray(ok, bool).reshape(len(ta), -1)
    ninl = np.nan_to_num(np.asarray(n_inl, float)).reshape(len(ta), -1)[:, 0]
    out = []
    for c in cands:
        w = int(np.searchsorted(ta, c["t"], side="right") - 1)
        x = dict(c)
        if w < 0 or w >= len(ta) or c["t"] >= tb[w]:
            x["far"] = None
        else:
            around = _local_median(ninl, w, 8)
            x["far"] = bool(not ok[w].any() or (np.isfinite(around) and ninl[w] < C.CUT_INL_SHARE * around))
        out.append(x)
    return out


def decide(cands: list[dict]) -> list[dict]:
    """cuts = spikes with a model cue (vms or far), merged within CUT_MERGE_S -> [{t, t_first, t_last, n_pairs, cues}]"""
    hits = [c for c in cands if c.get("vms") or c.get("far")]
    cuts: list[dict] = []
    for c in sorted(hits, key=lambda c: c["t"]):
        cues = sorted({"diff"} | ({"vms"} if c.get("vms") else set()) | ({"far"} if c.get("far") else set()))
        if cuts and c["t"] - cuts[-1]["t_last"] <= C.CUT_MERGE_S:
            k = cuts[-1]
            k["t_last"] = c["t"]; k["n_pairs"] += 1; k["cues"] = sorted(set(k["cues"]) | set(cues))
            continue
        cuts.append(dict(t=c["t"], t_first=c["t"], t_last=c["t"], n_pairs=1, cues=cues))
    return cuts


def _norm(x: np.ndarray) -> np.ndarray:
    """grey frame with zero mean and fixed contrast: a flash or an exposure jump changes brightness and contrast, not the structure"""
    x = x.astype(np.float32)
    x = (x - x.mean()) / (x.std() + 1e-6)
    return np.clip(128.0 + 40.0 * x, 0, 255).astype(np.uint8)


def same_scene(a: np.ndarray, b: np.ndarray, top: float | None = None) -> dict:
    """does frame b show the same scene as frame a? Corners of a tracked into b (LK, forward-backward), one similarity fitted by RANSAC.
    top: only the upper part of the frames (that share of the rows). -> {corners, inliers, share}: share = inliers / corners (0 when nothing fits)"""
    from .vmsx import motion as M
    if top is not None:
        a, b = a[:max(8, int(len(a) * top))], b[:max(8, int(len(b) * top))]
    a, b = _norm(a), _norm(b)
    p0 = cv2.goodFeaturesToTrack(a, 400, 0.01, 8, blockSize=7)
    if p0 is None:
        return dict(corners=0, inliers=0, share=0.0)
    p1, s1, _ = cv2.calcOpticalFlowPyrLK(a, b, p0, None, **M.LK_PARAMS)
    bk, s2, _ = cv2.calcOpticalFlowPyrLK(b, a, p1, None, **M.LK_PARAMS)
    ok = (s1.ravel() == 1) & (s2.ravel() == 1) & (np.linalg.norm((bk - p0).reshape(-1, 2), axis=1) < M.MAX_FB_ERROR)
    n = 0
    if ok.sum() >= 8:
        _, inl = cv2.estimateAffinePartial2D(p0[ok], p1[ok], method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=500)
        n = int(inl.sum()) if inl is not None else 0
    return dict(corners=int(len(p0)), inliers=n, share=round(n / len(p0), 3))


def grey_frames(video: str, t0: float, t1: float, ffmpeg: str = "ffmpeg", height: int | None = None) -> tuple[np.ndarray, float]:
    """grey frames of the video from t0 to t1 (s), height CUT_SAME_H rows -> (frames [n, h, w] uint8, fps)"""
    h = int(height or C.CUT_SAME_H)
    w = 2 * int(round(h * 16 / 9 / 2))
    from .vmsx.decode import probe
    fps = float(probe(video).fps)
    n = max(2, int(np.ceil((t1 - t0) * fps)) + 1)
    raw = subprocess.run([ffmpeg, "-nostdin", "-loglevel", "error", "-ss", f"{max(t0, 0.0):.3f}", "-i", video, "-frames:v", str(n), "-vf", f"scale={w}:{h}",
                          "-pix_fmt", "gray", "-f", "rawvideo", "-"], capture_output=True, check=False).stdout
    k = len(raw) // (w * h)
    return np.frombuffer(raw[:k * w * h], np.uint8).reshape(k, h, w), fps


def check_same_scene(video: str, cut: dict, ffmpeg: str = "ffmpeg") -> dict | None:
    """the frame before the first jump of the cut and the frame after its last jump (largest frame differences within +-CUT_SAME_WIN_S of t_first / t_last)
    compared by same_scene -> {t_before, t_after, corners, inliers, share} or None when the frames cannot be decoded"""
    w = C.CUT_SAME_WIN_S
    t0 = float(cut.get("t_first", cut["t"])) - w
    F, fps = grey_frames(video, t0, float(cut.get("t_last", cut["t"])) + w, ffmpeg)
    if len(F) < 2:
        return None
    d = np.abs(np.diff(F.astype(np.int16), axis=0)).mean(axis=(1, 2))
    n_win = max(1, int(round(2 * w * fps)))
    i = int(np.argmax(d[:n_win]))                           # jump near t_first
    j = len(d) - n_win + int(np.argmax(d[-n_win:]))         # jump near t_last (the same pair for a single-pair cut)
    j = max(i, j)
    r = same_scene(F[i], F[j + 1])
    return dict(t_before=round(t0 + i / fps, 3), t_after=round(t0 + (j + 1) / fps, 3), **r)


def frame_at_cut(video: str, cut: dict, side: str, ffmpeg: str = "ffmpeg") -> np.ndarray | None:
    """the grey frame just before the first jump of a cut (side "before") or just after its last jump ("after"), the jump being the largest frame
    difference within +-CUT_SAME_WIN_S; None when nothing can be decoded"""
    w = C.CUT_SAME_WIN_S
    tc = float(cut.get("t_first" if side == "before" else "t_last", cut["t"]))
    F, _fps = grey_frames(video, tc - w, tc + w, ffmpeg)
    if len(F) < 2:
        return None
    i = int(np.argmax(np.abs(np.diff(F.astype(np.int16), axis=0)).mean(axis=(1, 2))))
    return F[i] if side == "before" else F[i + 1]


def resumed_pieces(video: str, cuts: list[dict], intro_end: float | None, ffmpeg: str = "ffmpeg") -> list[dict]:
    """pieces between two consecutive cuts, CUT_MIN_PIECE_S..PANO_MAX_S long and after the intro, checked for an insert: does the road scene after the
    second cut continue the one before the first (same_scene on the upper PANO_TOP of the frames)? -> [{t0, t1, share, resumed}] (rsm.pipeline.detours)"""
    out = []
    for ca, cb in zip(cuts[:-1], cuts[1:]):
        a, b = float(ca["t"]), float(cb["t"])
        if not (C.CUT_MIN_PIECE_S <= b - a <= C.PANO_MAX_S) or (intro_end is not None and a < intro_end):
            continue
        fa, fb = frame_at_cut(video, ca, "before", ffmpeg), frame_at_cut(video, cb, "after", ffmpeg)
        if fa is None or fb is None:
            continue
        r = same_scene(fa, fb, top=C.PANO_TOP)
        out.append(dict(t0=a, t1=b, share=r["share"], resumed=bool(r["share"] >= C.PANO_SAME_SHARE)))
    return out


def veto_same_scene(video: str, cuts: list[dict], ffmpeg: str = "ffmpeg") -> tuple[list[dict], list[dict]]:
    """-> (cuts kept, cuts rejected as the same scene); every cut gets `same` (check_same_scene). Off (CUT_SAME_ON False) or no frames: kept as they are"""
    if not C.CUT_SAME_ON:
        return cuts, []
    kept, rejected = [], []
    for c in cuts:
        s = check_same_scene(video, c, ffmpeg)
        c = dict(c, same=s)
        (rejected if s is not None and s["share"] >= C.CUT_SAME_SHARE else kept).append(c)
    return kept, rejected


# ------------------------------------------------------------------ cuts4: multi-type transitions (hard, fade, dissolve)
def _is_same(a: np.ndarray, b: np.ndarray, thr: float | None = None) -> bool:
    return same_scene(a, b)["share"] >= (C.CUT_SAME_SHARE if thr is None else thr)


def _grad_energy(gray: np.ndarray) -> float:
    g = cv2.GaussianBlur(gray.astype(np.float32), (3, 3), 0)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return float(np.mean(gx * gx + gy * gy))


def _coarse_grad(bgr: np.ndarray) -> np.ndarray:
    sm = cv2.resize(bgr, (48, 27), interpolation=cv2.INTER_AREA).astype(np.float32)
    gx = sm[:, 1:, :] - sm[:, :-1, :]
    gy = sm[1:, :, :] - sm[:-1, :, :]
    return np.concatenate([gx.ravel(), gy.ravel()])


def _cos(u: np.ndarray, v: np.ndarray) -> float:
    nu = float(np.linalg.norm(u))
    nv = float(np.linalg.norm(v))
    return 0.0 if (nu < 1e-6 or nv < 1e-6) else float(np.dot(u, v) / (nu * nv))


def _is_blur_pulse_same_scene(grays_u8: np.ndarray, ens: np.ndarray, a: int, b: int) -> bool:
    """Does [a, b] merely defocus/blur and refocus onto the SAME scene (e.g. Amalfi 55:19)?
    Checks (a, b), padded outer pairs, and the nearest sharp frames outside [a, b]."""
    n = len(grays_u8)
    if _is_same(grays_u8[a], grays_u8[b]):
        return True
    # Nearest sharp frame at or before a, and at or after b
    max_pre = float(np.max(ens[:a + 1])) if a >= 0 else 0.0
    max_post = float(np.max(ens[b:])) if b < n else 0.0
    sa = a
    while sa > 0 and ens[sa] < 0.6 * max_pre:
        sa -= 1
    sb = b
    while sb < n - 1 and ens[sb] < 0.6 * max_post:
        sb += 1
    checked = {(a, b)}
    pairs = [(sa, sb)]
    for pad in (2, 4):
        oa, ob = max(0, sa - pad), min(n - 1, sb + pad)
        pairs.extend([(sa, ob), (oa, sb), (oa, ob)])
    for i, j in pairs:
        if (i, j) in checked or i >= j:
            continue
        checked.add((i, j))
        if _is_same(grays_u8[i], grays_u8[j]):
            return True
    return False


def transition_candidates(time: np.ndarray, diff: np.ndarray, inliers: np.ndarray, ta: np.ndarray, tb: np.ndarray,
                          ok: np.ndarray, n_pts: np.ndarray | None, n_inl: np.ndarray) -> list[dict]:
    """Zero-decode candidate timestamps for cuts missed by classical 1-frame impulses:
    low-inlier/busy-road hard cuts (Sa Calobra 2:45), contiguous road blackouts (fades), and far-feature rotation collapses
    (n_pts drop for hard cuts & fast dissolves; ~ok & n_inl drop for slow 1.5-3.5 s dissolves). -> [{t, hint, source}]"""
    raw: list[tuple[float, str, str]] = []
    t = np.asarray(time, float).ravel()
    d = np.nan_to_num(np.asarray(diff, float)).ravel()
    inl = np.nan_to_num(np.asarray(inliers, float)).ravel()
    n = len(t)
    if n >= 8:
        base_d = median_filter(d, size=_GP.cut_median_window, mode="nearest")
        base_i = median_filter(inl, size=_GP.cut_median_window, mode="nearest")
        nb_max = np.zeros(n)
        for k in (1, 2, 3):
            nb_max[k:] = np.maximum(nb_max[k:], d[:-k])
            nb_max[:-k] = np.maximum(nb_max[:-k], d[k:])
        imp = d / np.maximum(nb_max, 1.0)
        m_diff = (d > C.CUT_CAND_FACTOR * np.maximum(base_d, 1.0)) & (d > C.CUT_CAND_MIN_DIFF) & (imp >= C.CUT_CAND_IMPULSE)
        m_drop = (imp >= C.CUT_CAND_DROP_IMPULSE) & (d >= C.CUT_CAND_DROP_DIFF) & (inl < MIN_INLIERS) & (base_i >= C.CUT_CAND_DROP_AROUND)
        for idx in np.flatnonzero(m_diff | m_drop):
            raw.append((float(t[idx]), "hard", "diff_drop"))
        low_i = inl <= 3.0
        i = 0
        while i < n:
            if low_i[i]:
                j = i
                while j < n and low_i[j]:
                    j += 1
                dur = float(t[j - 1] - t[i])
                if C.CUT_CAND_ROAD_MIN_S <= dur <= C.CUT_CAND_ROAD_MAX_S and i >= 5 and j <= n - 5:
                    pre_med = float(np.median(inl[max(0, i - 15):i]))
                    post_med = float(np.median(inl[j:min(n, j + 15)]))
                    if pre_med >= 25.0 and post_med >= 25.0:
                        raw.append((float(0.5 * (t[i] + t[j - 1])), "transition", "road_drop"))
                i = j
            else:
                i += 1

    ta_a = np.asarray(ta, float).ravel()
    tb_a = np.asarray(tb, float).ravel()
    m = len(ta_a)
    if m >= 10:
        t_mid = 0.5 * (ta_a + tb_a)
        ok_any = np.asarray(ok, bool).reshape(m, -1).any(axis=1)
        inl_max = np.nan_to_num(np.asarray(n_inl, float)).reshape(m, -1).max(axis=1)
        med_inl = median_filter(inl_max, size=21, mode="nearest")
        bad_inl = (~ok_any) & (inl_max <= np.maximum(10.0, C.CUT_CAND_ROT_INL_SHARE * med_inl)) & (med_inl >= C.CUT_CAND_ROT_INL_MIN_MED)
        if n_pts is not None:
            pts_max = np.nan_to_num(np.asarray(n_pts, float)).reshape(m, -1).max(axis=1)
            med_pts = median_filter(pts_max, size=21, mode="nearest")
            bad_pts = (pts_max <= np.maximum(15.0, C.CUT_CAND_ROT_PTS_SHARE * med_pts)) & (med_pts >= C.CUT_CAND_ROT_PTS_MIN_MED)
            bad = bad_pts | bad_inl
            rank = inl_max + 0.1 * pts_max
        else:
            bad = bad_inl
            rank = inl_max
        i = 0
        while i < m:
            if bad[i]:
                j = i
                while j < m and bad[j]:
                    j += 1
                dur = float(t_mid[j - 1] - t_mid[i])
                if dur <= C.CUT_CAND_ROT_MAX_S:
                    k_min = i + int(np.argmin(rank[i:j]))
                    raw.append((float(t_mid[k_min]), "transition", "rot_drop"))
                i = j
            else:
                i += 1

    raw.sort(key=lambda x: x[0])
    merged: list[dict] = []
    for tc, hint, src in raw:
        if merged and tc - merged[-1]["t"] <= C.CUT_CAND_MERGE_S:
            prev = merged[-1]
            if hint == "hard" and prev["hint"] != "hard":
                merged[-1] = dict(t=tc, hint="hard", source=src)
            elif prev["hint"] != "hard":
                prev["t"] = 0.5 * (prev["t"] + tc)
        else:
            merged.append(dict(t=tc, hint=hint, source=src))
    return merged


def bgr_window(video: str, t_center: float, half: float | None = None, fps: float | None = None,
               height: int | None = None, ffmpeg: str = "ffmpeg") -> tuple[np.ndarray, np.ndarray]:
    """Decode +-half seconds around t_center at fps and height (16:9 BGR24) -> (frames [N, H, W, 3] uint8, timestamps [N] float)."""
    half = float(C.CUT_TRANS_HALF_S if half is None else half)
    fps = float(C.CUT_TRANS_FPS if fps is None else fps)
    h = int(C.CUT_TRANS_H if height is None else height)
    w = 2 * int(round(h * 16 / 9 / 2))
    t0 = max(0.0, float(t_center) - half)
    dur = float(t_center) + half - t0
    raw = subprocess.run([ffmpeg, "-nostdin", "-loglevel", "error", "-threads", "2", "-ss", f"{t0:.3f}", "-t", f"{dur:.3f}",
                          "-i", video, "-an", "-vf", f"fps={fps},scale={w}:{h}", "-pix_fmt", "bgr24", "-f", "rawvideo", "-"],
                         capture_output=True, check=False).stdout
    n = len(raw) // (w * h * 3)
    if n < 2:
        return np.zeros((0, h, w, 3), np.uint8), np.zeros(0, float)
    return np.frombuffer(raw[:n * w * h * 3], np.uint8).reshape(n, h, w, 3), t0 + np.arange(n, dtype=float) / fps


def verify_hard_frames(F: np.ndarray, fps: float, t0: float, tc: float) -> dict | None:
    """Verify a native-fps hard cut in grey frames F [N, H, W] starting at t0 around candidate time tc.
    Requires a sharp 1-frame impulse, scene change at the jump, and wide-bracket same-scene veto against flashes/occlusions."""
    if len(F) < 6 or fps <= 0:
        return None
    d = np.abs(np.diff(F.astype(np.int16), axis=0)).mean(axis=(1, 2))
    ts_mid = t0 + (np.arange(len(d), dtype=float) + 0.5) / fps
    in_w = np.flatnonzero(np.abs(ts_mid - tc) <= 0.55)
    if len(in_w) == 0:
        return None
    pk = int(in_w[int(np.argmax(d[in_w]))])
    nb = np.concatenate([d[max(0, pk - 6):max(0, pk - 1)], d[min(len(d), pk + 2):min(len(d), pk + 7)]])
    loc_med = float(np.median(nb)) if len(nb) else float(np.median(d))
    loc_max = float(nb.max()) if len(nb) else loc_med
    imp_med = float(d[pk] / max(loc_med, 1.0))
    imp_max = float(d[pk] / max(loc_max, 1.0))
    if d[pk] < C.CUT_HARD_MIN_DIFF or imp_med < C.CUT_HARD_IMP_MED or imp_max < C.CUT_HARD_IMP_MAX:
        return None
    ss = same_scene(F[pk], F[pk + 1])
    if ss["share"] >= C.CUT_SAME_SHARE:
        return None
    for dt_v in (0.35, 0.60):
        off = max(2, int(round(dt_v * fps)))
        a, b = pk - off, pk + 1 + off
        if a >= 0 and b < len(F) and _is_same(F[a], F[b]):
            return None
    t_cut = round(float(ts_mid[pk]), 3)
    return dict(t=t_cut, t_first=t_cut, t_last=t_cut, n_pairs=1, kind="hard", cues=["diff", "visual"],
                same=dict(t_before=round(float(t0 + pk / fps), 3), t_after=round(float(t0 + (pk + 1) / fps), 3), **ss),
                visual=dict(diff=round(float(d[pk]), 1), imp_med=round(imp_med, 2), imp_max=round(imp_max, 2)))


def verify_transition_frames(bgrs: np.ndarray, ts: np.ndarray, tc: float) -> dict | None:
    """Verify a multi-frame transition (fade-through-black/white, crossfade/dissolve, or ultra-short 0.15-0.35 s crossfade)
    on low-fps BGR frames [N, H, W, 3] with timestamps ts around candidate time tc."""
    n = len(bgrs)
    if n < 6:
        return None
    grays_u8 = np.array([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in bgrs])
    grays = grays_u8.astype(np.float32)
    ens = np.array([_grad_energy(g) for g in grays])

    # 1. Fade through black / dip to white
    means = grays.mean(axis=(1, 2))
    stds = grays.std(axis=(1, 2))
    unif = (stds < C.CUT_FADE_MAX_STD) & ((means < C.CUT_FADE_DARK_MEAN) | (means > C.CUT_FADE_BRIGHT_MEAN))
    in_c = np.flatnonzero(unif & (np.abs(ts - tc) <= 1.2))
    if len(in_c) > 0:
        m_idx = int(in_c[int(np.argmin(stds[in_c]))])
        pre = [i for i in range(m_idx - 1, -1, -1) if 35.0 <= means[i] <= 230.0 and stds[i] >= 15.0]
        post = [i for i in range(m_idx + 1, n) if 35.0 <= means[i] <= 230.0 and stds[i] >= 15.0]
        if pre and post:
            a, b = pre[0], post[0]
            if not _is_blur_pulse_same_scene(grays_u8, ens, a, b):
                tm, ta_s, tb_s = round(float(ts[m_idx]), 3), round(float(ts[a]), 3), round(float(ts[b]), 3)
                return dict(t=tm, t_first=ta_s, t_last=tb_s, n_pairs=int(b - a), kind="fade", cues=["visual", "fade"],
                            visual=dict(mean=round(float(means[m_idx]), 1), std=round(float(stds[m_idx]), 1)))

    # 2. Crossfade / dissolve (0.3-3.5 s): quadratic gradient-energy dip + coarse-BGR collinearity + dual-edge superposition + spatial alpha uniformity
    coarse = np.array([cv2.resize(f, (32, 18), interpolation=cv2.INTER_AREA) for f in bgrs], dtype=np.float32)
    cgrads = [_coarse_grad(f) for f in bgrs]
    dxs = [0.0] + [float(cv2.phaseCorrelate(grays[j], grays[j + 1])[0][0]) for j in range(n - 1)]

    best = None
    for k in (2, 4, 6, 8, 10, 12):
        if k >= n:
            continue
        for a in range(0, n - k):
            b = a + k
            if abs(0.5 * (ts[a] + ts[b]) - tc) > 1.2:
                continue
            A, B = coarse[a], coarse[b]
            dAB = B - A
            denom = float(np.sum(dAB * dAB))
            if denom < 1e-3 or float(np.mean(np.abs(dAB))) < C.CUT_DISS_MIN_DIFF:
                continue
            seg = coarse[a:b + 1]
            alpha = np.sum((seg - A) * dAB, axis=(1, 2, 3)) / denom
            if float(np.min(np.diff(alpha))) < -0.15:
                continue
            al_in = alpha[1:-1]
            mi_rel = int(np.argmin(np.abs(al_in - 0.5)))
            mi = 1 + mi_rel
            al = float(al_in[mi_rel])
            if not (0.20 <= al <= 0.80):
                continue

            e_lin = (1.0 - al) * ens[a] + al * ens[b]
            if e_lin < 1e-3:
                continue
            e_dip = float(ens[a + mi] / e_lin)
            if e_dip > C.CUT_DISS_MAX_EDIP:
                continue

            M = seg[mi]
            devC = float(np.linalg.norm(M - ((1.0 - al) * A + al * B)) / np.sqrt(denom))
            if devC > C.CUT_DISS_MAX_DEVC:
                continue
            pred_in = (1.0 - al_in[:, None, None, None]) * A + al_in[:, None, None, None] * B
            devAll = float(np.mean(np.linalg.norm((seg[1:-1] - pred_in).reshape(len(al_in), -1), axis=1)) / np.sqrt(denom))
            if devAll > C.CUT_DISS_MAX_DEVA:
                continue

            gA, gB, gM = cgrads[a], cgrads[b], cgrads[a + mi]
            cgcos = _cos(gM, (1.0 - al) * gA + al * gB)
            if cgcos < C.CUT_DISS_MIN_CGCOS:
                continue
            nA2 = float(np.dot(gA, gA)) + 1e-6
            nB2 = float(np.dot(gB, gB)) + 1e-6
            gA_p = gA - (float(np.dot(gA, gB)) / nB2) * gB
            gB_p = gB - (float(np.dot(gB, gA)) / nA2) * gA
            both_p = min(_cos(gM, gA_p), _cos(gM, gB_p))
            if both_p < C.CUT_DISS_MIN_BOTHP:
                continue

            tile_als = []
            for r in range(3):
                for c_col in range(4):
                    tA = A[r * 6:(r + 1) * 6, c_col * 8:(c_col + 1) * 8]
                    tB = B[r * 6:(r + 1) * 6, c_col * 8:(c_col + 1) * 8]
                    tM = M[r * 6:(r + 1) * 6, c_col * 8:(c_col + 1) * 8]
                    td = tB - tA
                    td2 = float(np.sum(td * td))
                    if td2 > 0.05 * denom / 12.0:
                        tile_als.append(float(np.sum((tM - tA) * td) / td2))
            aIQR = float(np.percentile(tile_als, 75) - np.percentile(tile_als, 25)) if len(tile_als) >= 4 else 1.0
            if aIQR > C.CUT_DISS_MAX_AIQR:
                continue

            pos = float(np.sum(np.maximum(dAB, 0.0)))
            neg = float(np.sum(np.maximum(-dAB, 0.0)))
            bidir = min(pos, neg) / max(pos, neg, 1e-6)
            mmean = min(float(grays[a].mean()), float(grays[b].mean()))
            if abs(sum(dxs[a + 1:b + 1])) > C.CUT_DISS_MAX_PAN_PX:
                continue
            lit_ok = bidir >= C.CUT_DISS_MIN_BIDIR and mmean >= C.CUT_DISS_MIN_MEAN
            dark_card_ok = mmean >= 15.0 and devC <= 0.16 and devAll <= 0.12 and cgcos >= 0.58 and aIQR <= 0.10
            if not (lit_ok or dark_card_ok):
                continue

            sc = cgcos * (1.0 - devC) * (1.0 - e_dip)
            if best is None or sc > best[0]:
                if not _is_blur_pulse_same_scene(grays_u8, ens, a, b):
                    best = (sc, a, b, a + mi, dict(e_dip=round(e_dip, 3), dev_c=round(devC, 3), dev_all=round(devAll, 3),
                                                   cgcos=round(cgcos, 3), both_p=round(both_p, 3), alpha_iqr=round(aIQR, 3)))
    if best is not None:
        _, a, b, m_idx, vis = best
        return dict(t=round(float(ts[m_idx]), 3), t_first=round(float(ts[a]), 3), t_last=round(float(ts[b]), 3),
                    n_pairs=int(b - a), kind="dissolve", cues=["visual", "dissolve"], visual=vis)

    # 3. Ultra-short crossfade (0.15-0.35 s, 4-9 frames): looks like a clean 1-step scene break at 5 fps
    d5 = np.array([float(np.mean(np.abs(grays[i + 1] - grays[i]))) for i in range(n - 1)])
    in_w5 = np.flatnonzero(np.abs(0.5 * (ts[:-1] + ts[1:]) - tc) <= 1.0)
    if len(in_w5) > 0:
        pk5 = int(in_w5[int(np.argmax(d5[in_w5]))])
        nb5 = [d5[i] for i in range(max(0, pk5 - 4), min(len(d5), pk5 + 5)) if abs(i - pk5) >= 2]
        loc5 = float(np.median(nb5)) if nb5 else float(np.median(d5))
        imp5 = d5[pk5] / max(loc5, 1.0)
        d_pre = d5[pk5 - 1] if pk5 > 0 else 0.0
        d_post = d5[pk5 + 1] if pk5 + 1 < len(d5) else 0.0
        if (d5[pk5] >= 24.0 and imp5 >= 2.4 and d5[pk5] >= 1.8 * max(d_pre, d_post, 1.0)
                and not _is_same(grays_u8[pk5], grays_u8[pk5 + 1])
                and not _is_same(grays_u8[max(0, pk5 - 1)], grays_u8[min(n - 1, pk5 + 2)])):
            (dx, _), _ = cv2.phaseCorrelate(grays[pk5], grays[pk5 + 1])
            if abs(float(dx)) < 35.0:
                vetoed = any(_is_same(grays_u8[pk5 - o], grays_u8[pk5 + 1 + o])
                             for o in (2, 3, 4) if pk5 - o >= 0 and pk5 + 1 + o < n)
                if not vetoed:
                    t_cut = round(float(0.5 * (ts[pk5] + ts[pk5 + 1])), 3)
                    return dict(t=t_cut, t_first=round(float(ts[pk5]), 3), t_last=round(float(ts[pk5 + 1]), 3),
                                n_pairs=1, kind="dissolve", cues=["visual", "fast_crossfade"],
                                visual=dict(d5=round(float(d5[pk5]), 1), imp5=round(float(imp5), 2)))
    return None


def _verify_one_candidate(video: str, cand: dict, ffmpeg: str) -> dict | None:
    tc = float(cand["t"])
    if cand.get("hint") == "hard":
        t0 = max(0.0, tc - C.CUT_HARD_WIN_S)
        F, fps = grey_frames(video, t0, tc + C.CUT_HARD_WIN_S, ffmpeg=ffmpeg, height=C.CUT_TRANS_H)
        hit = verify_hard_frames(F, fps, t0, tc)
        if hit is not None:
            return hit
    bgrs, ts = bgr_window(video, tc, ffmpeg=ffmpeg)
    if len(bgrs) < 6:
        return None
    grays_u8 = np.array([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in bgrs])
    # Check whether a rot_drop/road_drop candidate actually hides a hard cut before checking fades/dissolves
    d5 = np.array([float(np.mean(np.abs(grays_u8[i + 1].astype(np.float32) - grays_u8[i].astype(np.float32)))) for i in range(len(bgrs) - 1)])
    in_w = np.flatnonzero(np.abs(0.5 * (ts[:-1] + ts[1:]) - tc) <= 1.0)
    if len(in_w) > 0:
        pk = int(in_w[int(np.argmax(d5[in_w]))])
        nb = [d5[i] for i in range(max(0, pk - 4), min(len(d5), pk + 5)) if abs(i - pk) >= 2]
        loc = float(np.median(nb)) if nb else float(np.median(d5))
        if d5[pk] >= 18.0 and d5[pk] / max(loc, 1.0) >= 1.6 and not _is_same(grays_u8[pk], grays_u8[pk + 1]):
            t_pk = float(0.5 * (ts[pk] + ts[pk + 1]))
            t0 = max(0.0, t_pk - C.CUT_HARD_WIN_S)
            F, fps = grey_frames(video, t0, t_pk + C.CUT_HARD_WIN_S, ffmpeg=ffmpeg, height=C.CUT_TRANS_H)
            hit = verify_hard_frames(F, fps, t0, t_pk)
            if hit is not None:
                return hit
    return verify_transition_frames(bgrs, ts, tc)


def verify_transitions(video: str, classical_cuts: list[dict], extra_cands: list[dict],
                       ffmpeg: str = "ffmpeg", workers: int | None = None) -> tuple[list[dict], list[dict]]:
    """Verify classical hard-cut candidates (via same-scene veto) AND extra transition candidates (hard/fade/dissolve) in parallel.
    -> (cuts kept sorted by t, classical cuts rejected as same scene)."""
    kept, rejected = veto_same_scene(video, classical_cuts, ffmpeg) if classical_cuts else ([], [])
    kept = [dict(c, kind=c.get("kind", "hard")) for c in kept]
    if not C.CUT_TRANS_ON or not extra_cands:
        return kept, rejected
    todo = [c for c in extra_cands if not any(abs(float(c["t"]) - float(k["t"])) <= C.CUT_CAND_MERGE_S for k in kept)]
    if todo:
        n_w = max(1, min(int(workers or C.MAX_WORKERS), len(todo)))
        if n_w == 1:
            hits = [_verify_one_candidate(video, c, ffmpeg) for c in todo]
        else:
            with ThreadPoolExecutor(max_workers=n_w) as ex:
                hits = list(ex.map(lambda c: _verify_one_candidate(video, c, ffmpeg), todo))
        kept.extend(h for h in hits if h is not None)
    kept.sort(key=lambda c: float(c["t"]))
    dedup: list[dict] = []
    for c in kept:
        if dedup and float(c["t"]) - float(dedup[-1]["t"]) <= C.CUT_DEDUP_S:
            # Prefer a native-fps hard cut over a multi-frame transition if both hit the same event
            if c.get("kind") == "hard" and dedup[-1].get("kind") != "hard":
                dedup[-1] = c
            continue
        dedup.append(c)
    return dedup, rejected


def plan(tracks: list[dict], cuts: list[dict], intro_user: float | None = None, resumed: list[tuple[float, float]] | None = None) -> tuple[list[dict], dict]:
    """-> (tracks to use, info). Tracks after a cut get cut_before = cut time; tracks of inserted shots and of the intro are dropped (see module doc).
    intro_user ("Intro-Ende hier setzen", --intro-end): the intro ends there instead of at the last early cut (also without cuts; a track across it is split
    there, the piece after it starts without a jump). resumed: longer pieces (t0, t1) between two cuts after which the drive goes on where it was before
    the first (resumed_pieces): inserted shots too. Without cuts and intro_user the input list is returned as it is."""
    times = [float(c["t"]) for c in cuts]
    info = dict(n_cuts=len(times), cut_times=times, intro_end=None, intro_source=None, inserted=[], dropped_tracks=0, split_tracks=0)
    if not times and intro_user is None:
        return tracks, info
    spans_cut: list[tuple[float, float]] = [(float(c.get("t_first", c["t"])), float(c.get("t_last", c["t"]))) for c in cuts]
    if intro_user is not None:
        spans_cut.append((float(intro_user), float(intro_user)))
    tracks, info["split_tracks"], short_pieces = _split_at(tracks, spans_cut)
    info["dropped_tracks"] += short_pieces
    if intro_user is not None:
        intro_end, info["intro_source"] = float(intro_user), "user"
    else:
        early = [t for t in times if t < C.CUT_INTRO_S]
        intro_end = max(early) if early else None
        info["intro_source"] = "cuts" if intro_end is not None else None
    info["intro_end"] = intro_end
    # pieces between consecutive cuts that are too short to be riding (inserted shots)
    short = [(a, b) for a, b in zip(times[:-1], times[1:]) if b - a < C.CUT_MIN_PIECE_S and (intro_end is None or a >= intro_end)]
    kinds = ["short"] * len(short)
    for a, b in resumed or []:
        if (a, b) not in short and any(abs(a - x) < 1e-6 for x in times) and any(abs(b - x) < 1e-6 for x in times) and (intro_end is None or a >= intro_end):
            short.append((float(a), float(b))); kinds.append("resumed")
    info["inserted"] = sorted((dict(t0=a, t1=b, kind=k) for (a, b), k in zip(short, kinds)), key=lambda x: x["t0"])
    if intro_end is not None and not any(float(tr["t"][-1]) > intro_end for tr in tracks):
        info["intro_end"] = intro_end = info["intro_source"] = None   # nothing after the intro: the rule would leave no route; keep the tracks
        info["intro_rule_skipped"] = True
    out: list[dict] = []
    for tr in tracks:
        t0, t1 = float(tr["t"][0]), float(tr["t"][-1])
        if (intro_end is not None and t1 <= intro_end) or any(a <= t0 and t1 <= b for a, b in short):
            info["dropped_tracks"] += 1
            continue
        if out:                                  # a cut in the gap to the previous kept track: the gap is a jump (tracks never span a cut: gating splits there)
            prev_end = float(out[-1]["t"][-1])
            between = [c for c in times if prev_end < c <= t0]
            if between:
                tr = dict(tr, cut_before=float(between[-1]))
        out.append(tr)
    return out, info


def _split_at(tracks: list[dict], splits: list[float] | list[tuple[float, float]]) -> tuple[list[dict], int, int]:
    """tracks split at every cut strictly inside them (point cut `c`: samples <= c / > c; transition span `(a, b)` with a < b: samples <= a / >= b,
    excising blended/black frames strictly inside `(a, b)`; s and th of each piece restart at 0; pieces shorter than tracks.MIN_SEG_SAMPLES dropped)
    -> (tracks, number of tracks split, number of pieces dropped). Tracks without a cut inside are kept as they are."""
    from .tracks import MIN_SEG_SAMPLES
    raw_spans = [(float(x), float(x)) if isinstance(x, (int, float)) else (float(x[0]), float(x[1])) for x in splits]
    raw_spans.sort()
    # Merge overlapping spans
    merged: list[tuple[float, float]] = []
    for a_t, b_t in raw_spans:
        if merged and a_t <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b_t))
        else:
            merged.append((a_t, b_t))
    out, n_split, n_drop = [], 0, 0
    for tr in tracks:
        t = np.asarray(tr["t"], float)
        inner = [(a_t, b_t) for a_t, b_t in merged if b_t > t[0] and a_t < t[-1]]
        if not inner:
            out.append(tr)
            continue
        n_split += 1
        slices: list[tuple[int, int]] = []
        cur = 0
        for a_t, b_t in inner:
            end = int(np.searchsorted(t, a_t, side="right"))
            slices.append((cur, max(cur, end)))
            cur = int(np.searchsorted(t, b_t, side="left")) if b_t > a_t else end
        slices.append((cur, len(t)))
        for a, b in slices:
            if b - a < MIN_SEG_SAMPLES:
                n_drop += b > a
                continue
            piece = {k: (np.asarray(v)[a:b] if isinstance(v, np.ndarray) and len(v) == len(t) else v) for k, v in tr.items()}
            for k in ("s", "th"):
                if k in piece:
                    piece[k] = piece[k] - piece[k][0]
            out.append(piece)
    return out, n_split, n_drop


def mmss(t: float) -> str:
    t = int(round(t))
    return f"{t // 60}:{t % 60:02d}"


def spans(st, tracks: list[dict]) -> list[tuple[float, float, float, float]]:
    """(ta, tb, tc, v) of every cut gap of the steps st (rsm.hmm.seq.Steps): time of the last step before it, of the first step after it, of the cut itself
    (clipped to [ta, tb]), and the nominal speed (m/s) at the last step before it (the riding between ta and the cut)"""
    out = []
    for tr in tracks:
        if tr.get("cut_before") is None:
            continue
        t0 = float(tr["t"][0])
        j = int(np.searchsorted(st.t, t0 - 1e-6))       # the gap run ends at the step at t0 (its last sub-step ends there)
        j = min(j, st.T - 1)
        if not st.gap[j]:
            continue
        a = j
        while a > 0 and st.gap[a - 1]:
            a -= 1
        ta, tb = (float(st.t[a - 1]) if a > 0 else float(st.t[0])), float(st.t[j])
        v = float(st.v[a - 1]) if a > 0 and np.isfinite(st.v[a - 1]) else 0.0
        out.append((ta, tb, min(max(float(tr["cut_before"]), ta), tb), v))
    return out
