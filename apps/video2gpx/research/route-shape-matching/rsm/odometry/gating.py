# SPDX-License-Identifier: AGPL-3.0-or-later
"""Quality gating of vms frame pairs and the split into cut-free, gap-free segments.

The per-pair criteria are those `vms.evaluate.usable_pairs` applies (reimplemented here; same constants, which are counts of
frame pairs, not seconds):
  no_fit      no fit (empty rel_speed) or fewer than `min_inliers` (vms.motion.MIN_INLIERS = 10) road points kept
  high_rms    fit rms above the limit `rms_limit`: `max_rms_px` (0.8 px at 360 rows; vms.evaluate.MAX_RMS = 2.0 until 2026-11-17), or
              `max_rms_rel` x the video's median rms if that is higher. Passing traffic: a vehicle that
              covers much of the road area inflates the trimming threshold of the fit, nothing is trimmed, and the speed is a blend of road and
              vehicle. Overtaking from behind reads slow (its flow points at the horizon), oncoming traffic reads fast. Those pairs have 1-3 px rms
              against 0.2 px on plain road; above 0.8 px 28-80 % of the pairs are >20 % off on all six app videos (work/passing-cars).
              A soft, low-resolution or shaky video fits PLAIN road at 0.75-0.96 px (median; PCI25WijGrE 480p, Switzerland 6): there the
              absolute limit rejected half of all pairs and split the tracks for minutes, so the limit follows the video's own level (1.5 x the
              median; videos with a median up to 0.53 px keep the 0.8 px). On PCI25WijGrE pairs up to 1.5 x the median read the speed like the
              clean pairs (median ratio 1.00-1.05), pairs at 1.5-2.5 x read it 11-17 % fast and 25-52 % of them >20 % off.
              On such a video (relative limit) the limit also rises in curves: x (1 + `max_rms_yaw` (0.5) x min(w / `rms_yaw_ref` (80 px/s), 1)),
              w = 1 s mean of |yaw flow| (2026-11-26). Filmed from a leaning motorcycle the fit gets worse with the turn rate: share above the
              limit 8 % on straights, 28-40 % at w >= 80 px/s (Griesalp gIGsrHCyZZA, Furka 0eEylPLoqMA, Stelvio my42mzltbPo, 480p25). In slow
              hairpins that split the motion into pieces too short for an HMM step (< 2 x D0) and 80 s of a correct route became a gap
              (Griesalp 30:38-31:58). The pairs it admits read the speed >20 % off in 7-17 % (clean pairs 2-6 %, the still rejected 30 %), far
              better than a gap; a clean video (Monaco, UWSxwOHNApI: absolute limit) is not touched, its few admitted pairs were 25-32 % off.
  cut         frame difference above `cut_factor` (4) x its 61-pair running median (>= 1) and above `cut_min_diff` (25),
              dilated by +-7 pairs (a scene cut, or a bump / flash big enough to look like one)
  spike       speed more than 0.35 |median| + 2e-4 from the 31-pair running median of the usable speeds
  neg_speed   rel_speed <= -1e-4 (vms requires > -1e-4)
  excluded    before `exclude_before_s` (e.g. a title or map intro the caller knows about)
  false_stop  the speed (1 s running median of the clean pairs) falls below `stop_rel` (0.2) x the `stop_ref_pct` (75th) percentile of
              the `stop_ref_s` (30 s) around it (widened by `stop_widen_s`, 2 s, on both sides)
              while the picture keeps changing: the 1 s running median of the frame difference stays above `stop_diff_rel` (0.9) x the
              video's median (2026-11-24). On a pass road with a drop-off the road area of a curve shows the far valley side below the
              horizon; those points barely move, the ground-plane fit takes them at rms 0.1 px and reads 2-6 % of the speed for 2-8 s
              (Furka 0eEylPLoqMA 25:48-25:55, 26:02-26:07: the path stood still and then caught up at 20-27 m/s, 40-60 m behind). A real
              stop changes the picture far less: 1-40 % of the median frame difference at the red lights of Monaco (0Jlebs29SOc) and the
              stop sign in Realp (up to 80 % while pulling away), 70-270 % in the Furka curves. Only at speed: the 30 s reference must be at
              least `stop_ref_min` (0.7) x the video's median speed, because a crawl with a crossing cyclist or pedestrian also changes the
              picture (Monaco 39:45, 1:04:31) and a vehicle at walking pace can stop within a second; one at cruising speed cannot drop to a
              fifth of it within the 1 s window. Left over on Monaco: 0.4 % of the pairs, pulling away from a stop with crossing traffic;
              there the distance is bridged from the stop to the moving speed, about the real ramp.
              A false stop does not split the segments and keeps its measured yaw (the rotation of the picture is right, only the distance
              is wrong): `heading.integrate` fills only its distance from the neighbours. Splitting dropped the clean 6 s between two false
              stops in a Furka hairpin (33:13 and 33:21) as a too-short section and turned the whole hairpin into a gap.

Segments: an unusable run of pairs SPLITS the stream when it contains a cut pair, or when it lasts at least `max_gap_s`
(max_gap_s = 0: every unusable pair splits = strict), or when the CSV time jumps by more than 1.5 pair intervals.
Shorter unusable runs without a cut are bridged: yaw and s of their pairs are linearly interpolated from the usable neighbours
(counted and reported). Passing traffic while moving is bridged up to `traffic_bridge_s`: a run without a cut in which at least
`traffic_share` of the pairs are high_rms, with the usable speed in the `traffic_side_s` before AND after it at least `traffic_min_rel` x
the video median (the camera moves on both sides; a stop with traffic is left to the standstill test and the measured gaps). Nothing is ever bridged across a split. A section must last `min_segment_s` to be usable.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
from scipy.ndimage import maximum_filter1d, median_filter, percentile_filter, uniform_filter1d

from .vms_csv import Pairs

NO_FIT, HIGH_RMS, CUT, SPIKE, NEG_SPEED, EXCLUDED, FALSE_STOP = 1, 2, 4, 8, 16, 32, 64
REASONS = {"cut": CUT, "no_fit": NO_FIT, "high_rms": HIGH_RMS, "spike": SPIKE, "neg_speed": NEG_SPEED, "excluded": EXCLUDED,
           "false_stop": FALSE_STOP}  # display priority


@dataclass(frozen=True)
class GateParams:
    min_inliers: int = 10
    max_rms_px: float = 0.8
    max_rms_rel: float = 1.5
    max_rms_yaw: float = 0.5
    rms_yaw_ref: float = 80.0
    traffic_bridge_s: float = 4.0
    traffic_share: float = 0.3
    traffic_side_s: float = 1.0
    traffic_min_rel: float = 0.3
    spike_rel: float = 0.35
    spike_abs: float = 2e-4
    spike_window: int = 31
    cut_factor: float = 4.0
    cut_min_diff: float = 25.0
    cut_median_window: int = 61
    cut_halfwidth: int = 7
    neg_speed: float = -1e-4
    stop_rel: float = 0.2
    stop_ref_s: float = 30.0
    stop_ref_pct: float = 75.0
    stop_diff_rel: float = 0.9
    stop_ref_min: float = 0.7
    stop_win_s: float = 1.0
    stop_widen_s: float = 2.0
    max_gap_s: float = 0.5
    min_segment_s: float = 10.0
    exclude_before_s: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Segment:
    i0: int  # first pair (inclusive)
    i1: int  # last pair (exclusive)
    t0: float  # video seconds at the start edge of the first pair
    t1: float
    n_bridged: int  # unusable pairs inside, bridged by interpolation
    usable: bool
    reason: str  # "" if usable, else "too_short"

    @property
    def duration(self) -> float:
        return self.t1 - self.t0


def _nan_running_median(x: np.ndarray, size: int) -> np.ndarray:
    filled = x.copy()
    idx = np.arange(len(x))
    good = ~np.isnan(x)
    if good.sum() == 0:
        return x
    filled[~good] = np.interp(idx[~good], idx[good], x[good])
    return median_filter(filled, size=size, mode="nearest")


def rms_limit(rms_px: np.ndarray, inliers: np.ndarray, gp: GateParams = GateParams()) -> float:
    """the high_rms limit of a video (px): max(max_rms_px, max_rms_rel x the median rms of its fitted pairs). Takes the WHOLE video's pairs."""
    r = np.asarray(rms_px, float)
    r = r[np.isfinite(r) & (np.asarray(inliers, float) >= gp.min_inliers)]
    return float(max(gp.max_rms_px, gp.max_rms_rel * np.median(r))) if len(r) else float(gp.max_rms_px)


def _false_stop(p: Pairs, v: np.ndarray, diff: np.ndarray, gp: GateParams) -> np.ndarray:
    """pairs whose speed collapses while the picture keeps changing (see `false_stop` in the module doc)"""
    n = len(v)
    if gp.stop_rel <= 0 or n == 0 or not np.isfinite(v).any():
        return np.zeros(n, bool)
    dt = float(p.dt) if np.isfinite(p.dt) and p.dt > 0 else 1.0
    win = max(1, int(round(gp.stop_win_s / dt))) | 1
    ref_win = max(win, int(round(gp.stop_ref_s / dt))) | 1
    v1 = _nan_running_median(v, win)
    vf = v.copy()  # the reference: a high percentile, so that two collapses in one window (Furka 25:48 and 26:01) cannot pull it down
    good = np.isfinite(vf)
    vf[~good] = np.interp(np.flatnonzero(~good), np.flatnonzero(good), vf[good])
    ref = percentile_filter(vf, gp.stop_ref_pct, size=ref_win, mode="nearest")
    d1 = median_filter(diff, size=win, mode="nearest")
    dmed = float(np.median(diff)) if n else 0.0
    vmed = float(np.nanmedian(v))
    hit = (v1 < gp.stop_rel * ref) & (ref > gp.stop_ref_min * vmed) & (vmed > 0) & (d1 > gp.stop_diff_rel * dmed) & (dmed > 0)
    # widened by `stop_widen_s` on both sides: the edges of a collapse are half road, half valley side (Furka 25:48: 2-3 m/s against 12; the
    # frame difference passes its limit only a second after the speed collapsed) and would otherwise be the only speeds left to fill it with
    w = max(1, int(round(gp.stop_widen_s / dt)))
    return maximum_filter1d(hit.astype(np.int8), size=2 * w + 1, mode="constant") > 0


def pair_rms_limit(p: Pairs, fitted: np.ndarray, gp: GateParams = GateParams()) -> np.ndarray | float:
    """the high_rms limit per pair (px): `rms_limit`, and on a video whose limit is relative (its plain level is above max_rms_px / max_rms_rel) raised
    in curves by max_rms_yaw x min(w / rms_yaw_ref, 1), w = the 1 s mean of |yaw flow| in px/s (see the module doc, high_rms)."""
    lim = rms_limit(np.where(fitted, p.rms_px, np.nan), p.inliers, gp)
    if gp.max_rms_yaw <= 0 or lim <= gp.max_rms_px or len(p.yaw) == 0:
        return lim
    dt = float(p.dt) if np.isfinite(p.dt) and p.dt > 0 else 1.0
    w = uniform_filter1d(np.abs(np.nan_to_num(np.asarray(p.yaw, float))) / dt, max(1, int(round(1.0 / dt))), mode="nearest")
    return lim * (1.0 + gp.max_rms_yaw * np.minimum(w / gp.rms_yaw_ref, 1.0))


def pair_flags(p: Pairs, gp: GateParams = GateParams()) -> np.ndarray:
    """Per pair a bit mask of the reasons it is unusable (0 = usable)."""
    v = p.rel_speed
    fitted = ~np.isnan(v) & ~np.isnan(p.yaw) & (p.inliers >= gp.min_inliers)
    rms_bad = fitted & (p.rms_px > pair_rms_limit(p, fitted, gp))
    diff = np.nan_to_num(p.diff)
    base = median_filter(diff, size=gp.cut_median_window, mode="nearest")
    cut = (diff > gp.cut_factor * np.maximum(base, 1.0)) & (diff > gp.cut_min_diff)
    cut = np.convolve(cut.astype(float), np.ones(2 * gp.cut_halfwidth + 1), mode="same") > 0
    vv = np.where(fitted & ~rms_bad, v, np.nan)
    med = _nan_running_median(vv, gp.spike_window)
    spike = fitted & ~rms_bad & (np.abs(vv - med) > gp.spike_rel * np.abs(med) + gp.spike_abs)
    neg = fitted & (v <= gp.neg_speed)
    excl = p.time < gp.exclude_before_s
    stop = _false_stop(p, np.where(fitted & ~rms_bad & ~neg, v, np.nan), diff, gp) & fitted
    flags = (np.where(~fitted, NO_FIT, 0) | np.where(rms_bad, HIGH_RMS, 0) | np.where(cut, CUT, 0)
             | np.where(spike, SPIKE, 0) | np.where(neg, NEG_SPEED, 0) | np.where(excl, EXCLUDED, 0) | np.where(stop, FALSE_STOP, 0))
    return flags.astype(np.int32)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    e = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(e == 1).tolist(), np.flatnonzero(e == -1).tolist()))


def _traffic(fl: np.ndarray, v: np.ndarray, a: int, b: int, side: int, vmed: float, dt: float, gp: GateParams) -> bool:
    """the unusable run [a, b) is passing traffic while moving (see the module doc): short, mostly high_rms, usable speed on both sides"""
    if (b - a) * dt >= gp.traffic_bridge_s - 1e-9 or not np.isfinite(vmed) or vmed <= 0:
        return False
    if ((fl & HIGH_RMS) != 0).mean() < gp.traffic_share:
        return False
    before, after = v[max(0, a - side):a], v[b:b + side]
    if not (np.isfinite(before).any() and np.isfinite(after).any()):
        return False
    return min(np.nanmedian(before), np.nanmedian(after)) >= gp.traffic_min_rel * vmed


def build_segments(p: Pairs, flags: np.ndarray, gp: GateParams = GateParams()) -> list[Segment]:
    """All sections between splits (usable and too short), in time order."""
    n, dt = len(p), p.dt
    bad = (flags & ~FALSE_STOP) != 0  # a false stop never splits: its yaw is measured, only its distance is filled (heading.integrate)
    breaker = np.zeros(n, bool)
    v = np.where(bad, np.nan, p.rel_speed)
    vmed = float(np.nanmedian(v)) if np.isfinite(v).any() else np.nan
    side = max(1, int(round(gp.traffic_side_s / dt)))
    for a, b in _runs(bad):
        if (flags[a:b] & (CUT | EXCLUDED)).any():
            breaker[a:b] = True
        elif (b - a) * dt >= gp.max_gap_s - 1e-9 and not _traffic(flags[a:b], v, a, b, side, vmed, dt, gp):
            breaker[a:b] = True
    jumps = np.flatnonzero(np.diff(p.time) > 1.5 * dt) + 1  # a pair index after which a hole in the CSV starts
    segs = []
    for a, b in _runs(~breaker):
        cuts = [a, *[j for j in jumps if a < j < b], b]
        for c, d in zip(cuts[:-1], cuts[1:]):
            good = np.flatnonzero(~bad[c:d])
            if len(good) == 0:
                continue
            i0, i1 = c + int(good[0]), c + int(good[-1]) + 1
            n_br = int((flags[i0:i1] != 0).sum())
            t0, t1 = float(p.time[i0] - dt / 2), float(p.time[i1 - 1] + dt / 2)
            usable = (t1 - t0) >= gp.min_segment_s
            segs.append(Segment(i0, i1, t0, t1, n_br, usable, "" if usable else "too_short"))
    return segs
