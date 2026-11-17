# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.nogps.run stage <variant>   stage A + B (and the mirrored control)   -> work/amalfi/res/recs_<variant>[_mirror].pkl
   python -m rsm.nogps.run track <variant>   tracker v2 from the decisions, random and mirror controls -> work/amalfi/res/track_<variant>.pkl
"""
from __future__ import annotations

import json
import pickle
import sys
import time

from rsm.plaus import freeze as PF
from rsm.track import experiment as TX

from . import cfg, mapbuild, stages, trackrun


def main():
    cmd, variant = sys.argv[1], sys.argv[2]
    label = cfg.install(variant)
    print("plaus code hash OK", PF.check()[:12], flush=True)
    fz = json.loads((TX.WORK / "frozen_v2.json").read_text())
    assert fz["code_hash"] == TX.code_hash(), "rsm.track differs from frozen_v2"
    ctx = mapbuild.load_ctx()
    if cmd == "stage":
        for ctl in (None, "mirror"):
            t0 = time.time()
            src = stages.Source(ctx, label, ctl=ctl)
            print(f"{variant} {ctl}: {len(src.q['t0'])} video quanta, {len(src.tracks)} segments", flush=True)
            recs = stages.run_windows(src, f"{variant}/{ctl}")
            stages.save(recs, f"recs_{variant}" + (f"_{ctl}" if ctl else ""))
            print(f"{variant} {ctl} done {time.time()-t0:.0f}s", flush=True)
    elif cmd == "track":
        recs = stages.load(f"recs_{variant}")
        cal = stages.video_cal(recs)
        if cal is None:
            raise SystemExit("no accepted windows: no calibration, no anchors")
        t0 = time.time()
        out = trackrun.run_all(ctx, recs, dict(rho0=cal["rho"], kappa0=cal["kappa"], n=cal["n"], **{k: cal[k] for k in ("rho_iqr", "kappa_iqr")}))
        out["seconds"] = time.time() - t0
        with open(cfg.WORK / "res" / f"track_{variant}.pkl", "wb") as fh:
            pickle.dump(out, fh)
        print("track done", round(out["seconds"]), "s", flush=True)


if __name__ == "__main__":
    main()
