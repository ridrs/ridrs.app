# SPDX-License-Identifier: AGPL-3.0-or-later
"""Approach B on the existing COLMAP windows: how short may the reconstruction window be? f_eff from sub-windows of L s (numpy only).

python -m rsm.angle.colmapwin -> work/angle/colmap_window_length.json
"""
from __future__ import annotations

import json
from dataclasses import replace

import numpy as np

from ..bench import odo_compare as oc
from ..odometry import GateParams
from . import refs, videos


def sub_window(w, t0: float, t1: float):
    m = (w.t >= t0) & (w.t <= t1)
    if m.sum() < 8:
        return None
    s = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(w.xy[m], axis=0).T))])
    return replace(w, name=f"{w.name}[{t0:.0f}-{t1:.0f}]", t=w.t[m], xy=w.xy[m], psi_rot=w.psi_rot[m] - w.psi_rot[m][0], psi_tan=w.psi_tan[m], s=s)


def main():
    ref = json.loads((videos.WORK / "refs.json").read_text())
    out = {}
    for n in ("gotthard", "cayolle", "amalfi"):
        v = videos.VIDEOS[n]
        vms = oc.load_vms(v["csv"], n, GateParams(exclude_before_s=20.0))
        wins = [w for r in v["routes"] for w in refs.load_windows(r)]
        rows = []
        for L in (15, 30, 60, 90):
            ests = []
            for w in wins:
                if not w.kept:
                    continue
                for a in np.arange(w.t[0], w.t[-1] - L + 1e-6, L / 2):
                    sw = sub_window(w, a, a + L)
                    if sw is None:
                        continue
                    r = refs.colmap_f_eff([sw], vms, 449.0, n_boot=0 + 50)
                    if not np.isfinite(r["f_eff"]):
                        continue
                    ests.append(dict(win=w.name, t0=float(a), f=r["f_eff"], net_deg=r["per_window"][sw.name]["net_deg"], n=r["n_blocks"]))
            if not ests:
                continue
            f = np.array([e["f"] for e in ests]); net = np.array([e["net_deg"] for e in ests])
            rf = ref[n]["primary"]
            big = net >= 60
            rows.append(dict(L=L, n=len(ests), median=float(np.median(f)), rel_err_median_abs=float(np.median(np.abs(f / rf - 1))) * 100,
                             share_within10=float(np.mean(np.abs(f / rf - 1) < 0.10)),
                             n_big=int(big.sum()), big_rel_err_median_abs=float(np.median(np.abs(f[big] / rf - 1))) * 100 if big.any() else None,
                             big_share_within10=float(np.mean(np.abs(f[big] / rf - 1) < 0.10)) if big.any() else None,
                             pooled_big=float(np.exp(np.mean(np.log(f[big])))) if big.any() else None, ests=ests))
        out[n] = rows
        for r in rows:
            print(n, "L", r["L"], "n", r["n"], "median f", round(r["median"]), "med|err| %", round(r["rel_err_median_abs"], 1), "within10", round(r["share_within10"], 2),
                  "| net>=60deg:", r["n_big"], None if r["big_rel_err_median_abs"] is None else round(r["big_rel_err_median_abs"], 1), None if r["big_share_within10"] is None else round(r["big_share_within10"], 2))
    (videos.WORK / "colmap_window_length.json").write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
