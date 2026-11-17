# SPDX-License-Identifier: AGPL-3.0-or-later
"""Paths and per-video vms configuration of the no-GPS runs (outputs under work/amalfi/, git-ignored)."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "amalfi"
VIDEO = "amalfi"
PBF = ROOT / "work" / "osm" / "cache" / "sud-latest.osm.pbf"
VMS_FROZEN = ROOT / "work" / "vangestel" / "frozen_params.json"
QPARAMS = ROOT / "work" / "quanta" / "params.json"
NAME_QUERY = "Amalfi Coast"  # a priori, from the video name
R_MIN = 20_000.0
THR = 45.0
# vms input variants: label -> (csv template relative to the project root, frozen config of the vangestel work it follows)
VARIANTS = {
    "base": ("work/amalfi/vms/{video}.csv", "baseline"),  # vms unchanged, default flags; f 449, distance factor 1.0, rsm default turn detector
    "base_f310": ("work/amalfi/vms/{video}.csv", "baseline", 310.0),  # POST HOC: f360 449 / 1.45 (COLMAP-window slope of heading, 30 s increments, 780-960 s)
    "ho": ("work/amalfi/vms/{video}_ho24_rw0.5.csv", "refined"),  # --horizon-offset 24 --road-width 0.5; refined config (dist 0.935, detector 4 / 0.8 / 0.3 / 25)
}


def install(variant: str = "base") -> str:
    """Point rsm.quanta.video at a frozen-params file with a "refined" label that means the Amalfi CSV of `variant` (the label is what rsm.plaus and
    rsm.track ask for). The original work/vangestel/frozen_params.json is read, not written. Returns the label."""
    from rsm.quanta import video
    csv, src, *f = VARIANTS[variant]
    fz = json.loads(VMS_FROZEN.read_text())
    c = dict(fz["configs"][src])
    c["csv"] = csv
    if f:
        c["f360"] = f[0]
    fz["configs"] = {"refined": c}
    f = WORK / f"frozen_params_{variant}.json"
    WORK.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(fz, indent=1))
    video.FROZEN = f
    return "refined"
