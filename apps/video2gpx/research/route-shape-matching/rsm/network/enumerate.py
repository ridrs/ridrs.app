# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.network.enumerate <slug> [--lengths 1000 2000 5000 10000] [--max-paths 4000000] [--max-expansions 40000000]
       [--max-turn-paths 300000] [--seed 1] [--workers 8]

Per length L: bounded DFS over ALL node starts. If it stays under the caps the full set is enumerated; else the explosion is recorded
(count-only run with a bigger expansion cap, then an estimate from random start nodes) and a START-SAMPLED set is stored instead
(random start nodes until about max-turn-paths paths; flagged sampling="starts" in the meta). If a full set is larger than
max-turn-paths a random PATH subset gets turn sequences (sampling="paths"). Nothing is truncated silently.
"""
from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from rsm.odometry.turns import TurnParams

from .area import WORK
from .graph import NetGraph
from .paths import PathLimitExceeded, enumerate_paths, path_polyline, turns_of_polyline
from .store import save_paths

_G = None


def _init(slug):
    global _G
    _G = NetGraph.load(WORK / slug / "network.npz")


def _turns_chunk(args):
    edges_list, L = args
    return [turns_of_polyline(path_polyline(_G, e, L)) for e in edges_list]


def compute_turns(slug, edges, off, L, idx, workers):
    chunks = [(([edges[off[i]:off[i + 1]] for i in idx[a:a + 2000]]), L) for a in range(0, len(idx), 2000)]
    if workers <= 1 or len(chunks) == 1:
        _init(slug)
        res = [_turns_chunk(c) for c in chunks]
    else:
        with ProcessPoolExecutor(workers, initializer=_init, initargs=(slug,)) as ex:
            res = list(ex.map(_turns_chunk, chunks))
    return [t for r in res for t in r]


def sample_starts_estimate(g, out, L, rng, n_starts=300, max_exp=3_000_000):
    """Mean paths per start from random start nodes -> extrapolated total (a ratio estimator; huge variance when the count explodes)."""
    nodes = rng.choice(g.n_nodes, min(n_starts, g.n_nodes), replace=False)
    counts, exp = [], 0
    for s in nodes:
        try:
            ps = enumerate_paths(g, L, starts=[int(s)], out=out, store=False, max_paths=10**9, max_expansions=max_exp)
            counts.append(ps.count); exp += ps.expansions
        except PathLimitExceeded:
            return {"n_starts": len(counts), "note": f"a single start exceeded {max_exp} expansions"}
    c = np.array(counts, float)
    return {"n_starts": len(c), "mean_per_start": float(c.mean()), "sd_per_start": float(c.std(ddof=1)), "extrapolated_total": float(c.mean() * g.n_nodes),
            "extrapolated_total_se": float(c.std(ddof=1) / np.sqrt(len(c)) * g.n_nodes)}


def run(slug, lengths, max_paths, max_exp, max_turn_paths, seed, workers):
    g = NetGraph.load(WORK / slug / "network.npz")
    out = g.out_edges()
    rng = np.random.default_rng(seed)
    rows = []
    for L in lengths:
        row = {"L": L}
        try:
            ps = enumerate_paths(g, L, out=out, max_paths=max_paths, max_expansions=max_exp)
            row.update(complete=True, n_paths=len(ps), expansions=ps.expansions, dfs_seconds=round(ps.seconds, 2), dead_end_prefixes=ps.dead_ends)
            n = len(ps)
            sampling = "all"
            edges, off, tot = ps.edges, ps.off, ps.total_len
            if n > max_turn_paths:
                idx = np.sort(rng.choice(n, max_turn_paths, replace=False)); sampling = "paths"
            else:
                idx = np.arange(n)
            n_enum = n
        except PathLimitExceeded as e:
            row.update(complete=False, limit=str(e), emitted_at_limit=e.emitted, expansions_at_limit=e.expansions)
            try:
                cs = enumerate_paths(g, L, out=out, store=False, max_paths=10**10, max_expansions=max_exp * 4)
                row.update(count_only=cs.count, count_expansions=cs.expansions, count_seconds=round(cs.seconds, 1))
                n_enum = cs.count
            except PathLimitExceeded as e2:
                row.update(count_only=None, count_only_limit=str(e2))
                n_enum = None
            row["start_estimate"] = sample_starts_estimate(g, out, L, rng)
            # start-sampled stored set
            order = rng.permutation(g.n_nodes)
            fl, offs, tots = [], [0], []
            for s in order:
                try:
                    p1 = enumerate_paths(g, L, starts=[int(s)], out=out, max_paths=max_turn_paths, max_expansions=max_exp)
                except PathLimitExceeded:
                    continue
                if len(tots) + len(p1) > max_turn_paths:
                    break
                for i in range(len(p1)):
                    fl.extend(p1.path_edges(i).tolist()); offs.append(len(fl))
                tots.extend(p1.total_len.tolist())
                row["sampled_starts"] = row.get("sampled_starts", 0) + 1
            edges, off, tot = np.array(fl, np.int32), np.array(offs, np.int64), np.array(tots)
            idx = np.arange(len(tot)); sampling = "starts"
        t0 = time.time()
        turns = compute_turns(slug, edges, off, L, idx, workers)
        sub_off = np.zeros(len(idx) + 1, np.int64)
        sub_off[1:] = np.cumsum([off[i + 1] - off[i] for i in idx])
        sub_edges = np.concatenate([edges[off[i]:off[i + 1]] for i in idx]) if len(idx) else np.zeros(0, np.int32)
        meta = {"slug": slug, "n_enumerated": n_enum, "n_stored": int(len(idx)), "sampling": sampling, "seed": seed, "turn_params": TurnParams().to_dict(),
                "dfs_row": row, "turn_seconds": round(time.time() - t0, 1), "n_nodes_graph": g.n_nodes}
        save_paths(WORK / slug / f"paths_L{int(L)}.npz", L, sub_edges, sub_off, tot[idx], turns, meta)
        row.update(stored=len(idx), sampling=sampling, turn_seconds=round(time.time() - t0, 1), turns_total=int(sum(len(t) for t in turns)))
        print(json.dumps(row), flush=True)
        rows.append(row)
    (WORK / slug / "enumeration.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--lengths", type=int, nargs="+", default=[1000, 2000, 5000, 10000])
    ap.add_argument("--max-paths", type=int, default=4_000_000)
    ap.add_argument("--max-expansions", type=int, default=40_000_000)
    ap.add_argument("--max-turn-paths", type=int, default=300_000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    run(a.slug, a.lengths, a.max_paths, a.max_expansions, a.max_turn_paths, a.seed, a.workers)
