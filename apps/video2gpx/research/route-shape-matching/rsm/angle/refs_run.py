# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.angle.refs_run  ->  work/angle/refs.json : reference f_eff of the six videos (GPS windows / COLMAP pooled slopes)."""
from __future__ import annotations

import json

from ..bench import odo_compare as oc
from ..odometry import GateParams
from . import refs, videos


def main():
    out = {}
    for n, v in videos.VIDEOS.items():
        if "gps" in v:
            r = {f"W{W}": refs.gps_f_eff(v["gps"], str(v["csv"]), W) for W in (12, 24, 48)}
            out[n] = dict(kind="gps", primary=r["W12"]["f_eff"], lo=r["W12"]["lo"], hi=r["W12"]["hi"], detail=r)
        else:
            vms = oc.load_vms(v["csv"], n, GateParams(exclude_before_s=20.0))
            wins = [w for r in v["routes"] for w in refs.load_windows(r)]
            r = {f"inc{i}": refs.colmap_f_eff(wins, vms, 449.0, inc_s=float(i)) for i in (1, 2, 4, 8, 30)}
            out[n] = dict(kind="colmap", primary=r["inc2"]["f_eff"], lo=r["inc2"]["lo"], hi=r["inc2"]["hi"], detail=r,
                          colmap_fx360=float(wins[0].colmap_fx360), colmap_fx360_all={w.name: float(w.colmap_fx360) for w in wins})
    videos.WORK.mkdir(parents=True, exist_ok=True)
    (videos.WORK / "refs.json").write_text(json.dumps(out, indent=1, default=float))
    for n, r in out.items():
        print(n, r["kind"], round(r["primary"], 1), round(r["lo"]), round(r["hi"]))


if __name__ == "__main__":
    main()
