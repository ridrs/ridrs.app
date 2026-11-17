# SPDX-License-Identifier: AGPL-3.0-or-later
"""work/plaus/frozen.json: priors, thresholds, margins and the sha256 of the code that produces TEST / TEST-B numbers (written after DEV-A is done)."""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict
from pathlib import Path

from . import fit as fitmod

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work" / "plaus"
CODE = sorted([f"rsm/plaus/{n}.py" for n in ("data", "stagea", "path", "fit", "pipeline", "decide", "experiment", "run")]
              + ["rsm/quanta/chain.py", "rsm/quanta/evalrun.py", "rsm/quanta/video.py", "rsm/quanta/gps.py", "rsm/quanta/qdef.py", "rsm/quanta/legs.py", "rsm/quanta/area.py",
                 "rsm/odometry/heading.py", "rsm/odometry/gating.py", "rsm/odometry/vms_csv.py", "rsm/odometry/turns.py", "rsm/core/metrics.py"])
DATA = ["work/quanta/params.json", "work/vangestel/frozen_params.json", "work/plaus/splits.json"]


def code_hash():
    h, per = hashlib.sha256(), {}
    for f in CODE + DATA:
        d = (ROOT / f).read_bytes()
        per[f] = hashlib.sha256(d).hexdigest()
        h.update(f.encode()); h.update(d)
    return h.hexdigest(), per


def freeze(cal: dict, extra: dict) -> dict:
    h, per = code_hash()
    slim = {s: {st: {k: v for k, v in c.items() if not k.endswith("rows")} for st, c in d.items()} for s, d in cal.items()}
    fz = dict(frozen_at=time.strftime("%Y-%m-%d %H:%M:%S"), priors={k: {a: b for a, b in asdict(p).items()} for k, p in fitmod.PRIORS.items()}, cal=slim, code_hash=h,
              code_files_sha256=per, **extra)
    (WORK / "frozen.json").write_text(json.dumps(fz, indent=1, default=float))
    return fz


def check() -> str:
    fz = json.loads((WORK / "frozen.json").read_text())
    h, per = code_hash()
    if h != fz["code_hash"]:
        raise SystemExit("CODE HASH MISMATCH vs work/plaus/frozen.json; changed: " + ", ".join(f for f in per if per[f] != fz["code_files_sha256"].get(f)))
    return h
