# SPDX-License-Identifier: AGPL-3.0-or-later
"""Experiment driver.  python -m rsm.plaus.run recall --halves DEV-A [--variants base wide ...]
                       python -m rsm.plaus.run main --halves DEV-A --variant base --tag dev
"""
from __future__ import annotations

import argparse
import time

from . import fit as fitmod
from . import pipeline as P

VIDEOS = {"DEV-A": ["col-de-grimone-1", "vallee-de-roanne"], "TEST-B": ["col-de-grimone-1", "vallee-de-roanne"], "TEST": ["col-de-rousset"]}
SOURCES = ("refined", "baseline", "gps")


def recall(halves, variants, sources=SOURCES, lengths=P.LENGTHS):
    for var in variants:
        for h in halves:
            for v in VIDEOS[h]:
                for sname in sources:
                    t = time.time()
                    src = P.Source(v, sname, variant=var)
                    recs = P.run_source(src, f"{var}/{v}/{sname}", lengths, {h}, [], {}, KF=0, K=200)
                    P.save(recs, f"recall_{var}_{h}_{v}_{sname}")
                    print(var, h, v, sname, len(recs), f"{time.time()-t:.0f}s", flush=True)


def main_run(halves, variant, tag, sources=SOURCES, settings=("tight", "measured", "loose"), lengths=P.LENGTHS, KF=200, controls=True):
    for h in halves:
        for v in VIDEOS[h]:
            jobs = [(s, None, None) for s in sources]
            if controls:
                jobs += [("refined", "mirror", None), ("refined", "shuffle", None)]
                if v == "col-de-rousset":
                    jobs += [("refined", "foreign", "col-de-grimone-1")]
                else:
                    other = "vallee-de-roanne" if v == "col-de-grimone-1" else "col-de-grimone-1"
                    jobs += [("refined", "foreign", other)]
            for sname, ctl, mv in jobs:
                t = time.time()
                src = P.Source(v, sname, ctl=ctl, map_video=mv, variant=variant)
                recs = P.run_source(src, f"{tag}/{v}/{sname}/{ctl}", lengths, {h}, list(settings), {k: fitmod.PRIORS[k] for k in settings}, KF=KF, K=200, shuffle=(ctl == "shuffle"))
                P.save(recs, f"{tag}_{h}_{v}_{sname}_{ctl or 'real'}")
                print(tag, h, v, sname, ctl, len(recs), f"{time.time()-t:.0f}s", flush=True)


def calibrate_cmd(tag, variant):
    """DEV-A only: thresholds and margins (pass 1), video-level refit (pass 2), thresholds and margins (pass 2); writes work/plaus/frozen.json."""
    import pickle
    from . import experiment as X
    from . import freeze as F
    cal = X.calibrate(tag)
    X.pass2(tag, "DEV-A", cal, variant=variant)
    cal = X.calibrate2(tag, cal)
    pickle.dump(cal, open(P.WORK / f"cal_{tag}.pkl", "wb"))
    fz = F.freeze(cal, dict(tag=tag, variant=variant, K_stageA=200, K_stageB=50, topn_vc=X.TOPN_VC, vc_widths=[X.VC_RHO_W, X.VC_KAPPA_W]))
    print("frozen", fz["code_hash"][:12])


def apply_cmd(tag, halves, variant):
    import pickle
    from . import experiment as X
    from . import freeze as F
    print("code hash OK", F.check()[:12], flush=True)
    cal = pickle.load(open(P.WORK / f"cal_{tag}.pkl", "rb"))
    main_run(halves, variant, tag)
    for h in halves:
        X.pass2(tag, h, cal, variant=variant)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--halves", nargs="*", default=["DEV-A"])
    ap.add_argument("--variants", nargs="*", default=list(P.VARIANTS))
    ap.add_argument("--variant", default="wider")
    ap.add_argument("--tag", default="p1")
    a = ap.parse_args()
    if a.cmd == "recall":
        recall(a.halves, a.variants)
    if a.cmd == "calibrate":
        calibrate_cmd(a.tag, a.variant)
    if a.cmd == "apply":
        apply_cmd(a.tag, a.halves, a.variant)
    if a.cmd == "main":
        main_run(a.halves, a.variant, a.tag)


if __name__ == "__main__":
    main()
