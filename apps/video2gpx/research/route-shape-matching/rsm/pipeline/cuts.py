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

import subprocess

import cv2
import numpy as np
from scipy.ndimage import median_filter

from rsm.odometry.gating import GateParams

from . import config as C

VERSION = "cuts3"          # cuts3: strong-impulse gate, tracks split at a cut
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


def same_scene(a: np.ndarray, b: np.ndarray) -> dict:
    """does frame b show the same scene as frame a? Corners of a tracked into b (LK, forward-backward), one similarity fitted by RANSAC.
    -> {corners, inliers, share}: share = inliers / corners (0 when nothing fits)"""
    from .vmsx import motion as M
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


def plan(tracks: list[dict], cuts: list[dict], intro_user: float | None = None) -> tuple[list[dict], dict]:
    """-> (tracks to use, info). Tracks after a cut get cut_before = cut time; tracks of inserted shots and of the intro are dropped (see module doc).
    intro_user ("Intro-Ende hier setzen", --intro-end): the intro ends there instead of at the last early cut (also without cuts; a track across it is split
    there, the piece after it starts without a jump). Without cuts and intro_user the input list is returned as it is."""
    times = [float(c["t"]) for c in cuts]
    info = dict(n_cuts=len(times), cut_times=times, intro_end=None, intro_source=None, inserted=[], dropped_tracks=0, split_tracks=0)
    if not times and intro_user is None:
        return tracks, info
    split = sorted(set(times) | ({float(intro_user)} if intro_user is not None else set()))
    tracks, info["split_tracks"], short_pieces = _split_at(tracks, split)
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
    info["inserted"] = [dict(t0=a, t1=b) for a, b in short]
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


def _split_at(tracks: list[dict], times: list[float]) -> tuple[list[dict], int, int]:
    """tracks split at every cut time strictly inside them (samples up to the cut / after it; s and th of each piece restart at 0; pieces shorter than
    tracks.MIN_SEG_SAMPLES samples dropped) -> (tracks, number of tracks split, number of pieces dropped). Tracks without a cut inside are kept as they are."""
    from .tracks import MIN_SEG_SAMPLES
    out, n_split, n_drop = [], 0, 0
    for tr in tracks:
        t = np.asarray(tr["t"], float)
        inner = [c for c in times if t[0] < c < t[-1]]
        if not inner:
            out.append(tr)
            continue
        n_split += 1
        edges = [0] + [int(np.searchsorted(t, c, side="right")) for c in inner] + [len(t)]
        for a, b in zip(edges[:-1], edges[1:]):
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
