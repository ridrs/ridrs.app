# SPDX-License-Identifier: AGPL-3.0-or-later
"""Experiment 2: vms speed against GPX gradient.   python -m rsm.grade.run   ->  work/fable1/grade.json (+ grade_arrays.npz for the figures)"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import series, stats

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "work" / "fable1"
VIDEOS = ("vallee-de-roanne", "col-de-rousset", "col-de-grimone-1")
WINDOWS = (150, 300, 500)
MIN_SHIFT_M = 2000.0
DISC_STRETCH_M = (1000.0, 2000.0, 3000.0, 5000.0)


def braking_split(s, lo=-0.03, dec=-0.05):
    """descents (gradient < lo) split by the vms speed itself: braking = log speed falls by more than |dec| (log units) from the window one window-length behind"""
    g, lv, grid, W = s["g"], s["lv"], s["grid_m"], s["win_m"]
    k = max(int(round(W / grid)), 1)
    d = np.full_like(lv, np.nan)
    d[k:] = lv[k:] - lv[:-k]
    desc = (g < lo) & np.isfinite(lv) & np.isfinite(d)
    brk = desc & (d < dec)
    free = desc & ~brk
    out = {}
    for name, m in (("braking", brk), ("free", free)):
        out[name] = dict(n=int(m.sum()), median_lv=float(np.nanmedian(lv[m])) if m.any() else np.nan, median_grad=float(np.nanmedian(g[m])) if m.any() else np.nan,
                         r=stats.spearman(g[m], lv[m]))
    out["share_braking"] = float(brk.sum() / max(desc.sum(), 1))
    # speed-only reading of "braking": a steep descent on which the rider is not faster than on the flat (log speed below the median of the flat windows)
    flat = np.isfinite(lv) & (np.abs(g) <= 0.02)
    ref = float(np.nanmedian(lv[flat])) if flat.any() else np.nan
    for thr in (0.03, 0.05, 0.07):
        m = (g < -thr) & np.isfinite(lv)
        out[f"steep{int(thr*100)}"] = dict(n=int(m.sum()), share_not_faster_than_flat=float(np.mean(lv[m] <= ref)) if m.any() else np.nan,
                                           median_lv_minus_flat=float(np.nanmedian(lv[m]) - ref) if m.any() else np.nan)
    return out


def main():
    res, arrays = {}, {}
    prof = {v: series.gps_profile(v) for v in VIDEOS}
    spd = {v: series.Speed(v) for v in VIDEOS}
    for v in VIDEOS:
        res[v] = dict(length_km=prof[v]["length"] / 1000, ele_min=float(prof[v]["z"].min()), ele_max=float(prof[v]["z"].max()), n_gpx_points=prof[v]["n_raw"], windows={})
        for W in WINDOWS:
            s = series.aligned_series(v, W, prof=prof[v], spd=spd[v])
            g, lv, lg, grid = s["g"], s["lv"], s["lg"], s["grid_m"]
            nul = stats.shift_null(g, lv, grid, MIN_SHIFT_M)
            nul_g = stats.shift_null(g, lg, grid, MIN_SHIFT_M)
            r = stats.spearman(g, lv)
            row = dict(n=int(len(g)), valid=float(np.isfinite(lv).mean()), r_vms=r, r_gps_speed=stats.spearman(g, lg),
                       null=dict(n=int(np.isfinite(nul).sum()), median_abs=float(np.nanmedian(np.abs(nul))), p95_abs=float(np.nanpercentile(np.abs(nul), 95)),
                                 max_abs=float(np.nanmax(np.abs(nul))), mean=float(np.nanmean(nul)), sd=float(np.nanstd(nul)), share_abs_ge_0_2=float(np.nanmean(np.abs(nul) >= 0.2)),
                                 share_abs_ge_obs=float(np.nanmean(np.abs(nul) >= abs(r)))),
                       null_gps_speed=dict(median_abs=float(np.nanmedian(np.abs(nul_g))), p95_abs=float(np.nanpercentile(np.abs(nul_g), 95))),
                       classes=stats.classes(g, lv), classes_gps=stats.classes(g, lg), braking=braking_split(s))
            res[v]["windows"][W] = row
            if W == 300:
                arrays[f"{v}__c"], arrays[f"{v}__g"], arrays[f"{v}__lv"], arrays[f"{v}__lg"], arrays[f"{v}__null"] = s["c"], g, lv, lg, nul
                sh, rr = stats.curve(g, lv, grid, 6000.0, 100.0)
                arrays[f"{v}__curve_shift"], arrays[f"{v}__curve_r"] = sh, rr
                res[v]["curve_peak_shift_m"] = float(sh[np.nanargmin(rr)]); res[v]["curve_min_r"] = float(np.nanmin(rr))
    # discrimination: gradient profiles of the three tracks at 300 m, true route vs random stretches of equal length
    s3 = {v: series.aligned_series(v, 300, prof=prof[v], spd=spd[v]) for v in VIDEOS}
    gprof = {v: s3[v]["g"] for v in VIDEOS}; lvs = {v: s3[v]["lv"] for v in VIDEOS}
    res["discrimination"] = {}
    for L in DISC_STRETCH_M:
        d = stats.discrimination(gprof, lvs, L, s3[VIDEOS[0]]["grid_m"], n_rand=50, seed=int(L))
        res["discrimination"][str(int(L))] = d
        for v in VIDEOS:
            arrays[f"disc_{int(L)}__{v}"] = np.array(d[v]["ranks"])
    (OUT / "grade.json").write_text(json.dumps(res, indent=1, default=float))
    np.savez(OUT / "grade_arrays.npz", **arrays)
    for v in VIDEOS:
        print(v, {W: (round(res[v]["windows"][W]["r_vms"], 3), round(res[v]["windows"][W]["null"]["median_abs"], 3), round(res[v]["windows"][W]["null"]["p95_abs"], 3)) for W in WINDOWS})
        print("  classes 300:", {k: (c["n"], round(c["r"], 2) if c["r"] == c["r"] else None) for k, c in res[v]["windows"][300]["classes"].items()}, "braking:", res[v]["windows"][300]["braking"])
    for L, d in res["discrimination"].items():
        print("disc", L, {v: (d[v]["n_stretches"], d[v]["share_rank1"], d[v]["share_top5"], d[v]["median_rank"]) for v in VIDEOS})


if __name__ == "__main__":
    main()
