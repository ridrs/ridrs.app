# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.quanta.freeze: write work/quanta/frozen.json (parameters, rules, code hash) BEFORE the single TEST run; `check()` verifies it."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from .area import WORK

ROOT = Path(__file__).resolve().parents[2]
CORE = ["qdef", "gps", "video", "area", "legs", "chain", "evalrun", "run"]  # matching-relevant; report/fig/truth/diag/tune/calib_rule/mapstats/inspect_wrong are presentation or DEV tools
CODE = sorted([f"rsm/quanta/{n}.py" for n in CORE]
              + ["rsm/odometry/turns.py", "rsm/odometry/heading.py", "rsm/odometry/gating.py", "rsm/odometry/vms_csv.py", "rsm/network/paths.py", "rsm/network/pbf.py",
                 "rsm/network/graph.py"])
DATA = ["work/quanta/params.json", "work/quanta/rule_45.json", "work/quanta/rule_30.json", "work/vangestel/frozen_params.json"]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def code_hash() -> tuple[str, dict]:
    h, per = hashlib.sha256(), {}
    for f in CODE + DATA:
        d = (ROOT / f).read_bytes()
        per[f] = hashlib.sha256(d).hexdigest()
        h.update(f.encode())
        h.update(d)
    return h.hexdigest(), per


def freeze() -> dict:
    h, per = code_hash()
    fz = dict(frozen_at=time.strftime("%Y-%m-%d %H:%M:%S"), split={"col-de-grimone-1": "DEV", "vallee-de-roanne": "DEV", "col-de-rousset": "TEST"},
              params=json.loads((ROOT / "work/quanta/params.json").read_text()), rule_45=json.loads((ROOT / "work/quanta/rule_45.json").read_text()),
              rule_30=json.loads((ROOT / "work/quanta/rule_30.json").read_text()),
              area_rule="R = min(L_vms usable nominal length, 20 km); square half-width R around the Nominatim hit of the video-name query (rsm/quanta/area.py)",
              straight_max_m=2000, vms_configs="work/vangestel/frozen_params.json (refined = primary, baseline f449 = second), not re-run",
              maps={f: sha(ROOT / "work/quanta" / f) for f in sorted(p.name for p in (WORK).glob("map_*.npz"))},
              test_command=".venv/bin/python -m rsm.quanta.run col-de-rousset --params work/quanta/params.json --rule work/quanta/rule_45.json --out work/quanta/runs_test45 (and the same with rule_30 / --thr 30)",
              code_hash=h, code_files_sha256=per)
    (WORK / "frozen.json").write_text(json.dumps(fz, indent=1))
    return fz


def check() -> str:
    fz = json.loads((WORK / "frozen.json").read_text())
    h, per = code_hash()
    if h != fz["code_hash"]:
        raise SystemExit("CODE HASH MISMATCH vs work/quanta/frozen.json; changed: " + ", ".join(f for f in per if per[f] != fz["code_files_sha256"].get(f)))
    return h


if __name__ == "__main__":
    print(freeze()["code_hash"])
