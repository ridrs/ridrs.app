# SPDX-License-Identifier: AGPL-3.0-or-later
"""Parameter sweep of approach A on the tuning videos: python -m rsm.angle.sweep <label> key=value ... (vms venv, cv2). Appends to work/angle/sweep.jsonl."""
from __future__ import annotations

import json
import sys
from dataclasses import fields

from . import analyse, farfeat, videos


def run(label: str, kv: dict, names, procs=4):
    refs = json.loads((videos.WORK / "refs.json").read_text())
    types = {f.name: type(f.default) for f in fields(farfeat.Params)}
    kw = {k: (tuple(float(x) for x in v.split(",")) if k == "k1_grid" else types[k](v)) for k, v in kv.items()}
    p = farfeat.Params(**kw)
    out = []
    for n in names:
        v = videos.VIDEOS[n]
        res = farfeat.run_video(str(v["video"]), str(v["csv"]), videos.horizon(n), p, procs=procs, log=lambda *_: None)
        s = analyse.summarize(res)
        ref = refs[n]["primary"]
        s.update(video=n, label=label, params=kv, ref=ref, err_pct=100 * (s["f_eff_A"] / ref - 1), f_A_err_vs_fx_pct=(100 * (s["f_A"] / refs[n]["colmap_fx360"] - 1)) if "colmap_fx360" in refs[n] else None)
        out.append(s)
        print(f"{label:28s} {n:9s} f_A {s['f_A']:6.1f} g {s['g']:.3f} f_eff_A {s['f_eff_A']:6.1f} ref {ref:6.1f} err {s['err_pct']:+5.1f}%  stretches {s['n_stretch']} pairs {s['n_pairs']}", flush=True)
        with open(videos.WORK / "sweep.jsonl", "a") as fh:
            fh.write(json.dumps(s, default=float) + "\n")
    return out


if __name__ == "__main__":
    label = sys.argv[1]
    names = ["grimone", "roanne", "rousset", "gotthard"]
    kv = dict(a.split("=", 1) for a in sys.argv[2:] if "=" in a and not a.startswith("videos="))
    for a in sys.argv[2:]:
        if a.startswith("videos="):
            names = a[7:].split(",")
    run(label, kv, names)
