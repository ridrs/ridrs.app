# SPDX-License-Identifier: AGPL-3.0-or-later
"""Validation tables of the yaw series.  python -m rsm.farrot.report validate  -> work/farrot/validate.json (GPS and COLMAP are scoring only)"""
from __future__ import annotations

import json
import sys

import numpy as np

from rsm.angle import videos
from rsm.quanta import video as qv

from . import anchors as an
from . import series, validate

WORK = series.WORK
BIKES = {"grimone": "Grimone", "roanne": "Roanne", "rousset": "Rousset"}
KEYS = ("n", "n_turn_blocks", "slope", "r", "resid_deg", "resid_turn_deg", "ratio_p10", "ratio_median", "ratio_p90", "ratio_cv", "drift_rms_deg", "drift_p95_deg")


def pick(r):
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items() if k in KEYS}


def build_series(name: str, refined: bool = True, **kw):
    """series with the vms fallback CSV of the stored HMM runs (refined for bikes) or the baseline CSV of videos.py"""
    csv = an.vms_config(BIKES[name])["csv"] if (refined and name in BIKES) else str(videos.VIDEOS[name]["csv"])
    return series.build(name, csv, p=series.SeriesParams(**kw))


def bikes(block_s: float = 4.0) -> dict:
    out = {}
    for name in BIKES:
        gps = videos.VIDEOS[name]["gps"]
        res = {}
        S = build_series(name)                        # world yaw (lean-corrected) + vms fallback (refined csv)
        Sb = build_series(name, refined=False)         # same far fit, baseline vms csv for the "vms" reference
        Sc = build_series(name, lean=False)
        ref, ser_v, t0 = validate.gps_blocks(gps, S, "vms", block_s)
        cov = validate.coverage(S, t0, block_s)
        sel = cov >= 0.85
        res["coverage"] = dict(window_far_share=S.meta["frac_far"], blocks=int(len(t0)), blocks_ge85=int(sel.sum()), band_share=S.meta["band_share"], x0=S.meta["x0"], g_vms=S.meta["g_vms"], lean_deg_p50_p95_max=S.meta["lean_abs_deg_p50_p95_max"])
        for lab, SS, which in (("vms_refined", S, "vms"), ("vms_baseline", Sb, "vms"), ("far_camera_yaw", Sc, "dth_far"), ("far_world_yaw", S, "dth_far"), ("fused", S, "dth")):
            r, s_, t_ = validate.gps_blocks(gps, SS, which, block_s)
            res[lab + "_covered"] = pick(validate.block_compare(r[sel], s_[sel], t_blocks=t_[sel], block_s=block_s))
            res[lab + "_all"] = pick(validate.block_compare(r, s_, t_blocks=t_, block_s=block_s))
        out[name] = res
    return out


def amalfi() -> dict:
    csv = str(videos.VIDEOS["amalfi"]["csv"])
    S = series.build("amalfi", csv)
    Sc = series.build("amalfi", csv, p=series.SeriesParams(lean=False))
    res = dict(meta={k: v for k, v in S.meta.items() if k not in ("params",)})
    for bs in (2.0, 4.0):
        ref, s_, t0 = validate.colmap_blocks(S, "vms", block_s=bs)
        cov = validate.coverage(S, t0, bs); sel = cov >= 0.85
        res[f"blocks{bs:g}"] = dict(n=int(len(t0)), covered=int(sel.sum()))
        for lab, SS, which in (("vms", S, "vms"), ("far_camera_yaw", Sc, "dth_far"), ("far_world_yaw", S, "dth_far"), ("fused", S, "dth")):
            r, x, t_ = validate.colmap_blocks(SS, which, block_s=bs)
            res[f"blocks{bs:g}"][lab + "_covered"] = pick(validate.block_compare(r[sel], x[sel], block_s=bs))
            res[f"blocks{bs:g}"][lab + "_all"] = pick(validate.block_compare(r, x, block_s=bs))
    res["curves"] = {}
    for lab, SS, which in (("vms", S, "vms"), ("far_camera_yaw", Sc, "dth"), ("fused", S, "dth")):
        rows = validate.colmap_curves(SS, which)
        rat = np.array([r["ratio_colmap_over_series"] for r in rows])
        res["curves"][lab] = dict(rows=rows, min=float(np.nanmin(rat)), max=float(np.nanmax(rat)), median=float(np.nanmedian(rat)), n=len(rows),
                                  cv=float(1.4826 * np.nanmedian(np.abs(rat - np.nanmedian(rat))) / np.nanmedian(rat)))
    return res


def main():
    out = dict(bikes=bikes(), amalfi=amalfi())
    (WORK / "validate.json").write_text(json.dumps(out, indent=1, default=float))
    print(json.dumps(out, indent=1, default=float)[:6000])


if __name__ == "__main__":
    main()
