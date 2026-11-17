# SPDX-License-Identifier: AGPL-3.0-or-later
"""vms CSV + far-feature series -> heading/distance tracks {t, s, th}, steps, quality features, vehicle guess."""
from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter1d

from rsm.farrot import series as fser
from rsm.hmm import seq
from rsm.odometry import gating
from rsm.odometry.calib import CAMERA_HEIGHT_M
from rsm.odometry.vms_csv import load_pairs

from . import config as C

DS, SM_M, MIN_SEG_SAMPLES = 4.0, 6.0, 10     # as rsm.plaus.data


def _resample(t, s, th):
    s = np.asarray(s, float) - s[0]
    if s[-1] < DS * MIN_SEG_SAMPLES:
        return None
    se = s + 1e-9 * np.arange(len(s))
    g = np.arange(0.0, s[-1], DS)
    return dict(t=np.interp(g, se, t), s=g, th=gaussian_filter1d(np.interp(g, se, th), SM_M / DS, mode="nearest"))


def pair_rad(S, p) -> np.ndarray:
    k, fps = S.meta["k"], S.meta["fps"]
    w = np.clip(np.floor((p.time * fps - 0.5) / k).astype(int), 0, len(S.dth) - 1)
    x = np.where(np.isfinite(S.dth), S.dth, S.vms)
    return np.where(np.isfinite(x), x, 0.0)[w] / k


def far_tracks(csv: str, S) -> list[dict]:
    """as rsm.farrot.anchors.tracks_from_series: th = far heading (rad at f_far) / (F_REF / f_far), so a_ang = F_REF / f_eff gives rad_far * f_far / f_eff"""
    a_ang = C.F_REF / S.f
    p = load_pairs(csv)
    fl = gating.pair_flags(p)
    om = pair_rad(S, p)
    out = []
    for sg in gating.build_segments(p, fl, gating.GateParams()):
        if not sg.usable:
            continue
        sl = slice(sg.i0, sg.i1)
        ok = fl[sl] == 0
        sp = np.maximum(fser._fill(np.where(ok, p.s[sl], np.nan)), 0.0)
        k = C.F360 * CAMERA_HEIGHT_M
        theta = np.concatenate([[0.0], np.cumsum(om[sl])]) / a_ang
        s = np.concatenate([[0.0], np.cumsum(k * sp)])
        tm = p.time[sl]
        t = np.concatenate([tm - p.dt / 2, [tm[-1] + p.dt / 2]])
        r = _resample(t, s, theta)
        if r is not None:
            out.append(r)
    return out


class FarHeading:
    """far-feature-only heading per window (track units: rad at f_far / (F_REF / f_far), NaN = window not valid or next to a scene cut). Gives the heading
    increment of a gap sub-step over a time span, so heading continues across vms speed gaps where only the distance failed (ROT_BRIDGE_ON)."""

    def __init__(self, ta, tb, dth, min_valid: float | None = None):
        self.ta, self.tb, self.dth = np.asarray(ta, float), np.asarray(tb, float), np.asarray(dth, float)
        self.min_valid = C.ROT_BRIDGE_MIN_VALID if min_valid is None else min_valid

    def __call__(self, t0: float, t1: float) -> float:
        """increment over [t0, t1]: sum of the valid windows' increments by overlap, scaled up by the invalid share (NaN below min_valid)"""
        if not t1 > t0:
            return np.nan
        a = max(int(np.searchsorted(self.tb, t0, side="right")), 0)
        b = int(np.searchsorted(self.ta, t1, side="left"))
        if b <= a:
            return np.nan
        ov = np.clip(np.minimum(self.tb[a:b], t1) - np.maximum(self.ta[a:b], t0), 0.0, None)
        tot = float(ov.sum())
        ok = np.isfinite(self.dth[a:b])
        w = self.tb[a:b] - self.ta[a:b]
        cov = float(ov[ok].sum())
        if tot < 0.9 * (t1 - t0) or cov < self.min_valid * tot:
            return np.nan
        return float(np.sum(self.dth[a:b][ok] * ov[ok] / w[ok]) * tot / cov)


def far_heading(S, cut_spans=()) -> dict:
    """the series' far-only increments in track units (as far_tracks: th = rad / a_ang, a_ang = F_REF / f), windows touching a scene cut set invalid"""
    dth = np.asarray(S.dth_far, float) / (C.F_REF / S.f)
    ta, tb = np.asarray(S.ta, float), np.asarray(S.tb, float)
    for a, b in cut_spans:
        dth = np.where((tb > a - 0.5) & (ta < b + 0.5), np.nan, dth)
    return dict(ta=ta, tb=tb, dth=dth)


def save_far_heading(path, fh: dict) -> None:
    np.savez(path, **fh)


def load_far_heading(path) -> FarHeading | None:
    from pathlib import Path
    if not Path(path).exists():
        return None
    z = np.load(path)
    return FarHeading(z["ta"], z["tb"], z["dth"])


def steps_of(tracks, d0: float | None = None, gap_nom: list | None = None, prior_sd: float | None = None, gap_dth=None) -> seq.Steps:
    """HMM steps of the tracks. A gap before a track with `cut_before` (a scene cut, rsm.pipeline.cuts) is a JUMP, not riding: jump_substeps(d0) sub-steps
    with a distance prior of sd `prior_sd` (default CUT_PRIOR_SD_M): each sub-step advances Normal(0, sd / sqrt(n)) (forward only), so the walk through the
    jump is half-normal with that sd and a start d m further along costs about d^2 / 2 sd^2 nats, up to about CUT_JUMP_M. The default (1e5) makes the jump FLAT
    (maintainer decision 2026-11-13); CUT_PRIOR_SD_SOFT_M (400 m, a soft stay prior from an unexplained edit, DECISIONS A13) is the option / way back.
    Heading is never integrated across: the first emitting step after
    the cut starts a new increment. Tracks without cuts: exactly rsm.hmm.seq.make_steps (unchanged).
    gap_dth (FarHeading or None): heading increments of the sub-steps of vms gaps (never of cut jumps, whose sub-steps keep dth NaN)."""
    d0 = C.D0 if d0 is None else d0
    sd = C.CUT_PRIOR_SD_M if prior_sd is None else prior_sd
    if not any(tr.get("cut_before") is not None for tr in tracks):
        return seq.make_steps(tracks, d0=d0, gap_nom=gap_nom, gap_dth=gap_dth)
    # make_steps skips tracks shorter than 2 d0 (no step); drop them here so a cut before a skipped track moves to the next one
    gn = list(gap_nom) if gap_nom is not None else [None] * len(tracks)
    kept, kgn, pend = [], [], None
    for tr, g in zip(tracks, gn):
        if int(np.asarray(tr["s"])[-1] // d0) < 2:
            if tr.get("cut_before") is not None:
                pend = tr["cut_before"]
            continue
        if pend is not None and tr.get("cut_before") is None:
            tr = dict(tr, cut_before=pend)
        pend = None
        kept.append(tr)
        kgn.append(g)
    n = jump_substeps(d0)
    kgn = [n * d0 if (i > 0 and tr.get("cut_before") is not None) else g for i, (tr, g) in enumerate(zip(kept, kgn))]
    st = seq.make_steps(kept, d0=d0, gap_nom=kgn, gap_dth=gap_dth)
    rel, mu, dth = st.rel.copy(), st.mu.copy(), st.dth.copy()
    for tr in kept[1:]:
        if tr.get("cut_before") is None:
            continue
        j = min(int(np.searchsorted(st.t, float(tr["t"][0]) - 1e-6)), st.T - 1)   # last sub-step of the gap ends at the track start
        while j > 0 and st.gap[j]:
            rel[j] = sd / np.sqrt(n) / CUT_SUB_MU
            mu[j] = CUT_SUB_MU
            dth[j] = np.nan                          # a jump never emits heading
            j -= 1
    return st.copy(rel=rel, mu=mu, dth=dth)


CUT_SUB_MU = 1.0     # nominal metres of a jump sub-step: ~0, so the zero-advance entry (stay) is the most likely; the spread comes from `rel`


def jump_substeps(d0: float) -> int:
    """sub-steps of a cut jump: each may advance up to about 2 cells (the grid keeps advances up to 2.4 cells of >= 0.8 d0), so this many reach CUT_JUMP_M"""
    return max(1, int(np.ceil(C.CUT_JUMP_M / (2.0 * d0))))


def gap_nominal(csv: str, tracks: list[dict], min_share: float = C.GAP_MEASURED_SHARE) -> list:
    """Measured nominal distance of every gap between two tracks (None = not measurable, the gap is then estimated from the speeds around it).
    A standstill (traffic light, junction) is split off the tracks because its near-zero speeds are flagged as spikes / negative, and the steps would fill it with
    the mean speed before and after: up to 130 m of distance never driven (Madone, Menton seafront). If at least min_share of the gap's pairs have a good fit
    (enough inliers, low rms, no scene cut), the gap gets the vms distance of those pairs (negative speeds as 0, unfitted pairs as the median of the fitted)."""
    p = load_pairs(csv)
    fl = gating.pair_flags(p)
    good = (fl & (gating.NO_FIT | gating.HIGH_RMS | gating.CUT | gating.EXCLUDED)) == 0
    cut = (fl & gating.CUT) != 0
    k = C.F360 * CAMERA_HEIGHT_M
    out = [None]
    for a, b in zip(tracks[:-1], tracks[1:]):
        t0, t1 = float(a["t"][-1]), float(b["t"][0])
        m = (p.time > t0) & (p.time < t1)
        n = int(m.sum())
        if n == 0:
            out.append(0.0 if t1 - t0 < 2 * p.dt else None)
            continue
        if cut[m].any() or good[m].mean() < min_share:
            out.append(None)
            continue
        sp = np.maximum(np.nan_to_num(p.s[m]), 0.0)
        med = float(np.median(sp[good[m]]))
        out.append(float(k * np.where(good[m], sp, med).sum()))
    return out


def yaw_noise(tracks) -> float:
    """median over segments of the robust sd of the second difference of the 4 m heading grid (rad, reference scale)"""
    v = []
    for t in tracks:
        g = np.arange(0, t["s"][-1], 4.0)
        d2 = np.diff(np.interp(g, t["s"], t["th"]), 2)
        if len(d2) > 10:
            v.append(1.4826 * np.median(np.abs(d2 - np.median(d2))) / np.sqrt(6.0))
    return float(np.median(v)) if v else float("nan")


def level(x, good, diff, higher_is_better=True) -> str:
    if higher_is_better:
        return "good" if x >= good else "difficult" if x >= diff else "problem"
    return "good" if x < good else "difficult" if x < diff else "problem"


def estimate_vehicle(f: dict) -> dict:
    """SOFT PRIOR, never used to narrow the scan. Votes for a motorised vehicle: yaw noise >= 3x bike level (Amalfi 4.5x, bikes 0.5-1.2x), far-feature fallback share >= 15 %
    (Amalfi 29 %, bikes 1.5-3.5 %), lean p95 >= 15 deg (Amalfi 16.9, bikes 10-12.6), nominal speed p90 x 1.4 > 18 m/s (not rideable). 2 votes (or the speed vote) -> motorcycle,
    else bike. Car and motorcycle are not separable on the dev data (no car video among them), so 'auto' never says car."""
    votes = dict(yaw_noise=f["yaw_ratio"] >= C.YAW_RATIO[0], far_fallback=f["frac_vms"] >= 0.15, lean=f["lean_p95_deg"] >= 15.0, speed=f["v_nom_p90"] * 1.4 > 18.0)
    n = sum(votes.values())
    veh = "motorcycle" if (n >= 2 or votes["speed"]) else "bike"
    return dict(vehicle=veh, votes={k: bool(v) for k, v in votes.items()}, n_votes=int(n), features=f,
                note="soft prior only: sets road classes of the map, default driving-line offset; the f_eff x kappa scan is always the full range")
