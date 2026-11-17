# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.network.demo_guided <slug> <L> [n_queries] : sequence-driven search on real stored paths.
Query = the turn list of a random stored path with >= 5 turns (exact, and perturbed: angles x U(0.85,1.15), positions x1.15 = a 15 % scale
error). Reports whether the source path is among the guided results, how many paths the guide returns and expansions/time vs. the
unguided DFS of the same L (from enumeration.json). A demonstration that the hook works, NOT a matcher evaluation."""
import json
import sys
import time

import numpy as np

from .area import WORK
from .guided import TurnGuide
from .paths import enumerate_paths
from .store import PathStore


def main(slug, L, nq=10):
    ps = PathStore.load(WORK / slug, L)
    g = ps.g
    out = g.out_edges()
    rng = np.random.default_rng(3)
    cnt = np.diff(ps.z["turn_off"])
    cand = np.flatnonzero(cnt >= 5)
    rows = []
    for i in rng.choice(cand, nq, replace=False):
        tt = ps.turns(int(i))
        true = tuple(ps.edges(int(i)).tolist())
        for name, ka, ks in (("exact", 1.0, 1.0), ("perturbed", None, 1.15)):
            q = [((t["angle_deg"] * (rng.uniform(0.85, 1.15) if ka is None else 1.0)), ks * (t["s_start"] + t["s_end"]) / 2) for t in tt]
            guide = TurnGuide(g, q, max_lead=0, scale_lo=0.5, scale_hi=2.0)
            t0 = time.time()
            r = enumerate_paths(g, L, allow=guide, out=out, max_paths=200000, max_expansions=5_000_000)
            got = {tuple(r.path_edges(k).tolist()) for k in range(len(r))}
            rows.append({"path": int(i), "n_turns": len(tt), "query": name, "found": true in got, "returned": len(r), "expansions": r.expansions,
                         "seconds": round(time.time() - t0, 2)})
            print(json.dumps(rows[-1]), flush=True)
    unguided = [x for x in json.loads((WORK / slug / "enumeration.json").read_text()) if x["L"] == L][0]
    summ = {"slug": slug, "L": L, "unguided_expansions": unguided.get("expansions", unguided.get("expansions_at_limit")), "unguided_complete": unguided["complete"]}
    for name in ("exact", "perturbed"):
        r = [x for x in rows if x["query"] == name]
        summ[name] = {"found": f"{sum(x['found'] for x in r)}/{len(r)}", "median_returned": float(np.median([x["returned"] for x in r])),
                      "median_expansions": float(np.median([x["expansions"] for x in r])), "median_seconds": float(np.median([x["seconds"] for x in r]))}
    print(json.dumps(summ))
    (WORK / slug / f"guided_demo_L{L}.json").write_text(json.dumps({"summary": summ, "rows": rows}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 10)
