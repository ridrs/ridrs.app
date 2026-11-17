# SPDX-License-Identifier: AGPL-3.0-or-later
"""Verdict without the decoy test (the default): from signals that need no decoys. All thresholds PROVISIONAL (dev runs only: Grimone, Roanne, Rousset, Amalfi)."""
from __future__ import annotations

import pickle
from pathlib import Path

from . import config as C
from .common import jload

BASIS = "without decoy check"


def verdict_nodecoy(d: Path) -> dict:
    rs = pickle.load(open(Path(d) / "route_search" / "route.pkl", "rb"))
    ms = jload(Path(d) / "motion" / "summary.json")
    rot = jload(Path(d) / "rotation" / "summary.json")["features"]
    return verdict_from(rs, ms, rot)


RANK = {"confident": 2, "uncertain": 1, "no_route": 0}


def verdict_from(rs: dict, ms: dict, rot: dict) -> dict:
    """the decoy-free verdict from the route search result, the motion summary and the rotation features (also used inside route_search to judge a corridor result)"""
    sf = rs["surface"]
    inter = bool(sf["interior_f"] and sf["interior_kappa"])
    sig = dict(peak_interior=inter, peak_above_median_nats_per_km=sf["best_minus_median"], conf_mean=rs["conf_mean"], conf_below_half=rs["conf_below_half"], usable_share=ms["usable_share"],
               yaw_ratio=rot["yaw_ratio"])
    if rs.get("candidates"):
        sig["n_candidates"] = len(rs["candidates"])
    hard = []
    if not inter and sf["best_minus_median"] < C.PEAK_FLAT[1]:
        hard.append("calibration peak at the edge of the scan and flat")
    if rs["conf_mean"] < C.NODECOY["conf_mean_min"]:
        hard.append(f"mean posterior {rs['conf_mean']:.2f} < {C.NODECOY['conf_mean_min']}")
    if ms["usable_share"] < C.COVERAGE[1]:
        hard.append(f"usable motion {100 * ms['usable_share']:.0f} % < {100 * C.COVERAGE[1]:.0f} %")
    soft = []
    if not inter:
        soft.append("calibration peak at the edge of the scan")
    if sf["best_minus_median"] < C.PEAK_FLAT[0]:
        soft.append(f"calibration peak only {sf['best_minus_median']:.1f} nats/km above the surface median")
    if rs["conf_mean"] < C.NODECOY["conf_mean"]:
        soft.append(f"mean posterior {rs['conf_mean']:.2f} < {C.NODECOY['conf_mean']}")
    if rs["conf_below_half"] > C.NODECOY["below_half"]:
        soft.append(f"{100 * rs['conf_below_half']:.0f} % of the time with posterior < 0.5")
    if ms["usable_share"] < C.COVERAGE[0]:
        soft.append(f"usable motion {100 * ms['usable_share']:.0f} % < {100 * C.COVERAGE[0]:.0f} %")
    if rot["yaw_ratio"] >= C.YAW_RATIO[1]:
        soft.append(f"heading noise {rot['yaw_ratio']:.1f}x the bike level")
    if rs.get("rival_confident"):
        soft.append("two calibration candidates of similar quality give different routes")
    if rs.get("calibration_implausible"):
        soft.append("the calibration needs more speed or lateral acceleration than a road vehicle has")
    v = "no_route" if hard else "uncertain" if soft else "confident"
    return dict(verdict=v, basis=BASIS, decoys=0, reasons=hard + soft, signals=sig, provisional=True)
