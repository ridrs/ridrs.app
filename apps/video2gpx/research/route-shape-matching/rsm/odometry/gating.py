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
  cut         frame difference above `cut_factor` (4) x its 61-pair running median (>= 1) and above `cut_min_diff` (25),
              dilated by +-7 pairs (a scene cut, or a bump / flash big enough to look like one)
  spike       speed more than 0.35 |median| + 2e-4 from the 31-pair running median of the usable speeds
  neg_speed   rel_speed <= -1e-4 (vms requires > -1e-4)
  excluded    before `exclude_before_s` (e.g. a title or map intro the caller knows about)

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
from scipy.ndimage import median_filter

from .vms_csv import Pairs

NO_FIT, HIGH_RMS, CUT, SPIKE, NEG_SPEED, EXCLUDED = 1, 2, 4, 8, 16, 32
REASONS = {"cut": CUT, "no_fit": NO_FIT, "high_rms": HIGH_RMS, "spike": SPIKE, "neg_speed": NEG_SPEED, "excluded": EXCLUDED}  # display priority


@dataclass(frozen=True)
class GateParams:
    min_inliers: int = 10
    max_rms_px: float = 0.8
    max_rms_rel: float = 1.5
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


def pair_flags(p: Pairs, gp: GateParams = GateParams()) -> np.ndarray:
    """Per pair a bit mask of the reasons it is unusable (0 = usable)."""
    v = p.rel_speed
    fitted = ~np.isnan(v) & ~np.isnan(p.yaw) & (p.inliers >= gp.min_inliers)
    rms_bad = fitted & (p.rms_px > rms_limit(np.where(fitted, p.rms_px, np.nan), p.inliers, gp))
    diff = np.nan_to_num(p.diff)
    base = median_filter(diff, size=gp.cut_median_window, mode="nearest")
    cut = (diff > gp.cut_factor * np.maximum(base, 1.0)) & (diff > gp.cut_min_diff)
    cut = np.convolve(cut.astype(float), np.ones(2 * gp.cut_halfwidth + 1), mode="same") > 0
    vv = np.where(fitted & ~rms_bad, v, np.nan)
    med = _nan_running_median(vv, gp.spike_window)
    spike = fitted & ~rms_bad & (np.abs(vv - med) > gp.spike_rel * np.abs(med) + gp.spike_abs)
    neg = fitted & (v <= gp.neg_speed)
    excl = p.time < gp.exclude_before_s
    flags = (np.where(~fitted, NO_FIT, 0) | np.where(rms_bad, HIGH_RMS, 0) | np.where(cut, CUT, 0)
             | np.where(spike, SPIKE, 0) | np.where(neg, NEG_SPEED, 0) | np.where(excl, EXCLUDED, 0))
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
    bad = flags != 0
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
            n_br = int(bad[i0:i1].sum())
            t0, t1 = float(p.time[i0] - dt / 2), float(p.time[i1 - 1] + dt / 2)
            usable = (t1 - t0) >= gp.min_segment_s
            segs.append(Segment(i0, i1, t0, t1, n_br, usable, "" if usable else "too_short"))
    return segs
