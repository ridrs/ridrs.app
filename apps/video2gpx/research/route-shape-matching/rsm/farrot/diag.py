# SPDX-License-Identifier: AGPL-3.0-or-later
"""Truth-free consistency of the curve anchors (Amalfi): spread of the per-segment distance factor k_i between consecutive merged anchors, anchors per km, shifts of the same video turn.
python -m rsm.farrot.diag"""
import json
import numpy as np

from rsm.fusion import core
from rsm.refine import segment
from . import anchors as an, report as rep, series


def stats(v, label):
    ctx = v.ctx
    ac, rg, rm, feats = core.pipeline_anchors(v, v.cand, True)
    segs = segment.segments(sorted(ac, key=lambda a: a.t), ctx.D, ctx.gapfrac, ctx.kappa)
    k = np.array([s.k for s in segs if np.isfinite(s.k) and s.L_vms > 30])
    lk = np.log(k / np.median(k))
    km = (ctx.path.sg[-1]) / 1000
    return dict(label=label, n_cand=len(v.cand), n_gated_merged=len(ac), n_old_merge=len(v.acc), per_km=len(ac) / km, k_median=float(np.median(k)), lnk_mad=float(1.4826 * np.median(np.abs(lnk := lk))), lnk_sd=float(lk.std()),
                share_dev_gt30=float((np.abs(lk) > 0.26).mean()), n_seg=len(k)), ac


def main():
    S = rep.build_series  # noqa
    sa = series.build("amalfi", an.vms_config("Amalfi")["csv"])
    out = {}
    anc = {}
    for lab, ser in (("vms", None), ("far", sa)):
        v = an.load_video("Amalfi", ser)
        out[lab], anc[lab] = stats(v, lab)
        # also the ungated merged set
        segs = segment.segments(sorted(v.acc, key=lambda a: a.t), v.ctx.D, v.ctx.gapfrac, v.ctx.kappa)
        k = np.array([s.k for s in segs if np.isfinite(s.k) and s.L_vms > 30]); lk = np.log(k / np.median(k))
        out[lab]["ungated_merged"] = dict(n=len(v.acc), lnk_mad=float(1.4826 * np.median(np.abs(lk))), lnk_sd=float(lk.std()))
    # same video turns: anchor shifts
    tv = {round(a.t, 1): a for a in anc["vms"]}
    d = [a.s - tv[round(a.t, 1)].s for a in anc["far"] if round(a.t, 1) in tv]
    out["common_turn_shift_m"] = dict(n=len(d), abs_median=float(np.median(np.abs(d))) if d else None, abs_p90=float(np.percentile(np.abs(d), 90)) if d else None)
    print(json.dumps(out, indent=1))
    json.dump(out, open(series.WORK / "res" / "amalfi_anchor_consistency.json", "w"), indent=1)


if __name__ == "__main__":
    main()
