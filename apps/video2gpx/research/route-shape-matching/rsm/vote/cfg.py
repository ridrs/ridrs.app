# SPDX-License-Identifier: AGPL-3.0-or-later
"""Hypotheses of the angle scale for stage A and the frozen-params files that realise them (outputs in work/fable2/)."""
from __future__ import annotations

import json
from pathlib import Path

from rsm.nogps import cfg as ncfg

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "fable2"
RES = WORK / "res"
VIDEOS = ("vallee-de-roanne", "col-de-grimone-1", "col-de-rousset", "amalfi")
F_REF = 449.0
F_FIXED = (269.0, 359.0, 449.0, 561.0)  # = f_ref x (0.6, 0.8, 1.0, 1.25); in the brief's wording rho = f/449
F_A = {"col-de-grimone-1": 401.0, "vallee-de-roanne": 449.0, "col-de-rousset": 502.0, "amalfi": 325.0}  # approach A (work/angle) f_eff = f_A * g
GPS_REF = {"col-de-grimone-1": 390.0, "vallee-de-roanne": 486.0, "col-de-rousset": 494.0}  # GPS f_eff, evaluation only
AMALFI_COLMAP = 273.0
SHORT = {"vallee-de-roanne": "Roanne", "col-de-grimone-1": "Grimone", "col-de-rousset": "Rousset", "amalfi": "Amalfi"}


def hypotheses(video: str) -> list[float]:
    out = list(F_FIXED)
    if F_A[video] not in out:
        out.append(F_A[video])
    return sorted(out)


def install(video: str, F: float) -> str:
    """point rsm.quanta.video at a frozen-params file whose 'refined' label is this video's vms input integrated with f360 = F. -> label"""
    from rsm.quanta import video as qv
    fz = json.loads(ncfg.VMS_FROZEN.read_text())
    if video == "amalfi":
        csv, src, *_ = ncfg.VARIANTS["base"]  # vms default flags, baseline config (as the earlier Amalfi runs and the fable1 decoys)
        c = dict(fz["configs"][src]); c["csv"] = csv
    else:
        c = dict(fz["configs"]["refined"])
    c["f360"] = float(F)
    fz["configs"] = {"refined": c}
    WORK.mkdir(parents=True, exist_ok=True)
    f = WORK / "cache" / f"frozen_{'amalfi' if video == 'amalfi' else 'gps'}_{int(F)}.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(fz, indent=1))
    qv.FROZEN = f
    return "refined"
