# SPDX-License-Identifier: AGPL-3.0-or-later
"""Approach B on the freshly reconstructed bike windows (work/angle/colmap/<video>-<start>-<dur>): f_eff from the COLMAP rotation slope, compared with the GPS
f_eff of the whole video and of the same window. numpy only.   python -m rsm.angle.colmap_b -> work/angle/colmap_b.json"""
from __future__ import annotations

import json
import re

import numpy as np

from ..bench import odo_compare as oc
from ..odometry import GateParams
from . import colmapwin, refs, videos


def main():
    out = {}
    for d in sorted((videos.WORK / "colmap").glob("*-*-*")):
        name, start, dur = d.name.rsplit("-", 2)
        if name not in videos.VIDEOS or not (d / "metadata" / "cameras.json").exists():
            continue
        v = videos.VIDEOS[name]
        w = refs.load_kept_dir(d)[0]
        vms = oc.load_vms(v["csv"], name, GateParams(exclude_before_s=20.0))
        full = refs.colmap_f_eff([w], vms, 449.0, inc_s=2.0)
        pipe = json.loads((d / "metadata" / "pipeline.json").read_text())["stages"]
        summ = pipe["camera_tracking"]["summary"]
        r = dict(window=[float(w.t[0]), float(w.t[-1])], f_eff=full["f_eff"], lo=full.get("lo"), hi=full.get("hi"), n_blocks=full["n_blocks"],
                 net_deg=full["per_window"][w.name]["net_deg"], colmap_fx360=float(w.colmap_fx360), colmap_fy360=float(w.colmap_fy360),
                 registered=summ["registered"], keyframes=summ["keyframes"], models=summ["models"], seconds={k: pipe[k].get("seconds") for k in pipe},
                 clip=[float(start), float(dur)])
        sub = {}
        for L in (30,):
            es = []
            for a in np.arange(w.t[0], w.t[-1] - L + 1e-6, L / 2):
                sw = colmapwin.sub_window(w, a, a + L)
                if sw is None:
                    continue
                q = refs.colmap_f_eff([sw], vms, 449.0, n_boot=50)
                if np.isfinite(q["f_eff"]):
                    es.append(dict(t0=float(a), f=q["f_eff"], net_deg=q["per_window"][sw.name]["net_deg"]))
            sub[f"L{L}"] = es
        r["sub"] = sub
        if "gps" in v:
            r["gps_whole_video"] = json.loads((videos.WORK / "refs.json").read_text())[name]["primary"]
            g = refs.gps_f_eff(v["gps"], str(v["csv"]), 12, t_range=(w.t[0], w.t[-1]))
            r["gps_same_window"] = g
        lg = d.parent.parent / f"colmap_{name}.log"
        if lg.exists():
            m = re.search(r"peak group RSS ([\d.]+) GB", lg.read_text())
            r["peak_gb"] = float(m.group(1)) if m else None
        out[name] = r
        print(name, {k: (round(x, 1) if isinstance(x, float) else x) for k, x in r.items() if k in ("f_eff", "lo", "hi", "net_deg", "colmap_fx360", "registered", "keyframes", "gps_whole_video", "peak_gb")}, r.get("seconds"))
    (videos.WORK / "colmap_b.json").write_text(json.dumps(out, indent=1, default=float))


if __name__ == "__main__":
    main()
