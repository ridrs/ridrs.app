# SPDX-License-Identifier: AGPL-3.0-or-later
"""Amalfi is a motorcycle: does the per-increment deficit of the vms yaw against COLMAP correlate with the vms pitch / roll columns?
Increments of 2 s inside the COLMAP window amalfi-780 (780-960 s). No new vms run: reads work/amalfi/vms/amalfi.csv."""
from __future__ import annotations

import json

import numpy as np
from scipy.ndimage import median_filter
from scipy.stats import pearsonr, spearmanr

from rsm.angle import refs, videos
from rsm.bench import odo_compare as oc
from rsm.odometry import GateParams
from rsm.odometry.vms_csv import load_pairs

from . import cfg


def run(inc_s=2.0, min_dy_deg=3.0) -> dict:
    v = videos.VIDEOS["amalfi"]
    vms = oc.load_vms(v["csv"], "amalfi", GateParams(exclude_before_s=20.0))
    raw = np.genfromtxt(v["csv"], delimiter=",", names=True)
    t, yaw, pitch, roll = raw["time"], raw["yaw"], raw["pitch"], raw["roll"]
    dt = float(np.median(np.diff(t)))
    k = int(round(30.0 / dt)) | 1
    pitch_d = pitch - median_filter(np.nan_to_num(pitch), size=k, mode="nearest")  # remove the slow bias
    roll_d = roll - median_filter(np.nan_to_num(roll), size=k, mode="nearest")
    rows = []
    for w in [w for w in refs.load_windows("amalfi-780") if w.kept]:
        for pc in oc.pieces_for(w, vms, 449.0):
            tg = oc._grid(w, pc)
            if len(tg) < 8:
                continue
            th = np.interp(tg, pc.t, pc.theta)
            rot = np.interp(tg, w.t, w.psi_rot)
            n = int(round(inc_s / oc.GRID_DT))
            for i in range(0, len(tg) - n, n):
                a, b = tg[i], tg[i + n]
                m = (t >= a) & (t < b)
                dx, dy = rot[i + n] - rot[i], th[i + n] - th[i]
                if abs(dy) < np.radians(min_dy_deg) or abs(dx) < np.radians(min_dy_deg):
                    continue
                f = 449.0
                rows.append([0.5 * (a + b), dx, dy, np.nansum(pitch_d[m]) / f * np.sign(dy), np.nansum(roll_d[m]) * np.sign(dy), np.nansum(yaw[m]) / f])
    R = np.array(rows)
    ratio = R[:, 1] / R[:, 2]  # COLMAP / vms (rho per increment); 1 / cos(lean) if lean explains the deficit
    tanphi = np.abs(R[:, 3] / R[:, 2])
    pred = np.sqrt(1 + tanphi ** 2)
    ok = (ratio > 0) & (ratio < 5)
    out = dict(n=int(len(R)), n_used=int(ok.sum()), ratio_median=float(np.median(ratio[ok])), ratio_p10_p90=[float(x) for x in np.percentile(ratio[ok], [10, 90])],
               pitch_over_yaw_median=float(np.median(tanphi[ok])), pred_median=float(np.median(pred[ok])),
               spearman_ratio_vs_abs_pitchyaw=[float(x) for x in spearmanr(ratio[ok], tanphi[ok])],
               pearson_ratio_vs_pred=[float(x) for x in pearsonr(ratio[ok], pred[ok])],
               spearman_ratio_vs_signed_pitchyaw=[float(x) for x in spearmanr(ratio[ok], R[ok, 3] / R[ok, 2])],
               spearman_ratio_vs_abs_roll=[float(x) for x in spearmanr(ratio[ok], np.abs(R[ok, 4]))],
               spearman_ratio_vs_signed_roll=[float(x) for x in spearmanr(ratio[ok], R[ok, 4])],
               slope_ratio_on_pred=float(np.polyfit(pred[ok], ratio[ok], 1)[0]))
    cfg.WORK.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(cfg.WORK / "lean.json", "w"), indent=1)
    np.save(cfg.WORK / "lean_rows.npy", R)
    return out


if __name__ == "__main__":
    print(json.dumps(run(), indent=1))
