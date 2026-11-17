# SPDX-License-Identifier: AGPL-3.0-or-later
"""Ablations (beam size, gap model): python -m rsm.track.ablate -> work/track/ablate.json / ablate.md.  DEV videos: free; Rousset: POST HOC (TEST was already used)."""
from __future__ import annotations

import json
import time
from dataclasses import replace

import numpy as np

from . import consensus as C
from . import graphs, run, score, tracker

WORK = graphs.WORK
VARIANTS = [("beam 8", dict(beam=8, gap_beam=8)), ("beam 24", dict(beam=24, gap_beam=24)), ("beam 96 (frozen)", {}), ("beam 300", dict(beam=300)), ("beam 1000", dict(beam=1000, gap_beam=1500)),
            ("no gap beam (gap_beam = beam)", dict(gap_beam=96)), ("no gap factors (gamma = 1 only)", dict(gammas=(1.0,))), ("no cost caps", dict(ce_cap=99.0, cc_cap=99.0)),
            ("dedupe 6 m (default 6)", dict(dedupe_m=6.0)), ("dedupe 25 m", dict(dedupe_m=25.0))]


def one(video, kw, n_dec=None, n_wrong=12):
    prm = replace(tracker.Params(), **kw)
    S = run.setup(video, prm=prm)
    T = score.Truth(video, S["g"], S["fw"], log=lambda *a: None)
    grp = run.groups_for(S, video)
    dec = grp["dec"][:: max(1, len(grp["dec"]) // n_dec)] if n_dec else grp["dec"]
    wr = grp["rank25"][:n_wrong] + grp["random"][:n_wrong]
    t0 = time.time()
    rt, _ = run.track_all(S, dec, log=lambda *a: None)
    sec_dec = time.time() - t0
    rw, _ = run.track_all(S, wr, log=lambda *a: None)
    rt = [r for r in rt if r]; rw = [r for r in rw if r]
    sc = [score.score_route(r, T) for r in rt]
    return dict(n=len(rt), on30_mean=float(np.mean([s["on30"] for s in sc])), on30_min=float(np.min([s["on30"] for s in sc])), on100_mean=float(np.mean([s["on100"] for s in sc])),
                junc=float(sum(s["junc_correct"] for s in sc) / max(sum(s["junc_n"] for s in sc), 1)), cpk_true=float(np.median([r.cost_per_km for r in rt])),
                cpk_wrong=float(np.median([r.cost_per_km for r in rw])), auc=C.auc([r.cost_per_km for r in rt], [r.cost_per_km for r in rw]), sec_per_anchor=sec_dec / max(len(rt), 1),
                mean_route_s=float(np.mean([r.seconds for r in rt])))


def main():
    out = {}
    lines = ["| variant | video | routes | on road <= 30 m (mean / min) | <= 100 m (mean) | junction decisions correct | cost per km true / wrong (median) | AUC | s per anchor (wall, 11 workers) | CPU s per route |", "|---|---|---|---|---|---|---|---|---|---|"]
    for video, nd, post in (("vallee-de-roanne", None, False), ("col-de-grimone-1", None, False), ("col-de-rousset", 10, True)):
        for name, kw in VARIANTS:
            r = one(video, kw, nd)
            out[f"{name}|{video}"] = r
            lines.append(f"| {name} | {video}{' (post hoc)' if post else ''} | {r['n']} | {100*r['on30_mean']:.0f} % / {100*r['on30_min']:.0f} % | {100*r['on100_mean']:.0f} % | {100*r['junc']:.0f} % | {r['cpk_true']:.0f} / {r['cpk_wrong']:.0f} | {r['auc']:.2f} | {r['sec_per_anchor']:.2f} | {r['mean_route_s']:.1f} |")
            print(lines[-1], flush=True)
    (WORK / "ablate.json").write_text(json.dumps(out, indent=1))
    (WORK / "ablate.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
