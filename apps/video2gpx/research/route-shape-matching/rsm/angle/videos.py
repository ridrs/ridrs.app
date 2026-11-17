# SPDX-License-Identifier: AGPL-3.0-or-later
"""The six videos of the angle-scale study: file, vms CSV (default flags), role (tuning / held out)."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "angle"
VAN = Path(__file__).resolve().parents[4] / "test-data" / "vangestel"  # Van Gestel rides, git-ignored (docs/README.md)
SAMPLES = ROOT.parent / "road-reconstruction" / "sample_videos"

VIDEOS = {
    "grimone": dict(video=VAN / "col-de-grimone-1" / "video.mp4", csv=ROOT / "work/vangestel/vms/col-de-grimone-1.csv", gps="col-de-grimone-1", role="tune"),
    "roanne": dict(video=VAN / "vallee-de-roanne" / "video.mp4", csv=ROOT / "work/vangestel/vms/vallee-de-roanne.csv", gps="vallee-de-roanne", role="tune"),
    "rousset": dict(video=VAN / "col-de-rousset" / "video.mp4", csv=ROOT / "work/vangestel/vms/col-de-rousset.csv", gps="col-de-rousset", role="tune"),
    "gotthard": dict(video=SAMPLES / "Gotthard Pass 4K.mp4", csv=ROOT / "work/odometry/vms/gotthard.csv", routes=["gotthard-450", "gotthard-600"], role="tune"),
    "cayolle": dict(video=SAMPLES / "Cayolle Pass.mp4", csv=ROOT / "work/odometry/vms/cayolle.csv", routes=["cayolle-1630", "cayolle-2850", "cayolle-4000", "cayolle-4000-dense"], role="heldout"),
    "amalfi": dict(video=SAMPLES / "amalfi.mkv", csv=ROOT / "work/amalfi/vms/amalfi.csv", routes=["amalfi-780"], role="heldout (seen in matching)"),
}


def horizon(name: str) -> float:
    j = json.loads(Path(str(VIDEOS[name]["csv"])[:-4] + ".json").read_text())
    return float(j["horizon"])
