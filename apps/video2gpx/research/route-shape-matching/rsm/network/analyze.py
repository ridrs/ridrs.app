# SPDX-License-Identifier: AGPL-3.0-or-later
"""python -m rsm.network.analyze <slug>: geometry quality, turn density, map self-ambiguity, pass-named road, figure.
Writes work/osm/<slug>/analysis.json and work/osm/<slug>.png. The figure carries the ODbL attribution."""
from __future__ import annotations

import json
import re
import sys
import time

import numpy as np

from rsm.odometry.turns import Turn, TurnParams, detect_turns

from .area import WORK
from .graph import NetGraph
from .paths import densify_smooth, heading_curve, path_polyline, turns_of_polyline
from .store import PathStore

# ---------------------------------------------------------------- self-ambiguity -----------------------------------------------------

AMB = {"angle_rel": 0.20, "scale_lo": 0.7, "scale_hi": 1.4, "gap_rel": 0.20, "gap_abs_m": 15.0, "max_shared": 0.5}


def undirected_ids(g: NetGraph) -> np.ndarray:
    """Edge e and its reverse (v,u,same way, same length) share one id."""
    key = {}
    ids = np.zeros(g.n_edges, np.int64)
    for e in range(g.n_edges):
        u, v = int(g.edge_u[e]), int(g.edge_v[e])
        k = (min(u, v), max(u, v), int(g.edge_way[e]), round(float(g.edge_len[e]) / 2))
        ids[e] = key.setdefault(k, len(key))
    return ids


def turn_matrix(ps: PathStore):
    z = ps.z
    n = len(ps)
    cnt = np.diff(z["turn_off"])
    mid = (z["turn_s0_m"].astype(float) + z["turn_s1_m"]) / 2
    return cnt, mid


def self_ambiguity(ps: PathStore, und: np.ndarray, n_queries: int = 1000, min_turns: int = 2, seed: int = 0) -> dict:
    """For sampled query paths with >= min_turns turns: number of DISTINCT other stored paths (shared edge length <= max_shared of the shorter
    one) whose turn sequence is near-identical: same count, same signs, each angle within angle_rel of the larger |angle|, and (n>=2)
    a common length factor lambda=median(gap ratio) in [scale_lo, scale_hi] with every gap within max(gap_rel*lambda*g_q, gap_abs_m)."""
    z = ps.z
    cnt, mid = turn_matrix(ps)
    sign, ang = z["turn_sign"], z["turn_angle_deg"].astype(float)
    off = z["turn_off"]
    rng = np.random.default_rng(seed)
    groups: dict[bytes, list[int]] = {}
    for i in range(len(ps)):
        if cnt[i] >= 1:
            groups.setdefault(sign[off[i]:off[i + 1]].tobytes(), []).append(i)
    cache = {}

    def mats(key):
        if key not in cache:
            ix = np.array(groups[key])
            n = cnt[ix[0]]
            sel = off[ix][:, None] + np.arange(n)[None, :]
            cache[key] = (ix, ang[sel], mid[sel])
        return cache[key]

    elig = np.flatnonzero(cnt >= min_turns)
    q = rng.choice(elig, min(n_queries, len(elig)), replace=False) if len(elig) else np.array([], int)
    res = []
    for i in q:
        key = sign[off[i]:off[i + 1]].tobytes()
        ix, A, M = mats(key)
        a, m = ang[off[i]:off[i + 1]], mid[off[i]:off[i + 1]]
        ok = np.all(np.abs(A - a) <= AMB["angle_rel"] * np.maximum(np.abs(A), np.abs(a)), axis=1)
        if len(a) >= 2:
            gq, gc = np.diff(m), np.diff(M, axis=1)
            lam = np.median(gc / gq, axis=1)
            ok &= (lam >= AMB["scale_lo"]) & (lam <= AMB["scale_hi"])
            ok &= np.all(np.abs(gc - lam[:, None] * gq) <= np.maximum(AMB["gap_rel"] * lam[:, None] * gq, AMB["gap_abs_m"]), axis=1)
        cand = ix[ok]
        cand = cand[cand != i]
        n_dist = 0
        if len(cand):
            eq = ps.edges(int(i))
            uq = und[eq]
            lq = ps.g.edge_len[eq]
            for c in cand:
                ec = ps.edges(int(c))
                shared = lq[np.isin(uq, und[ec])].sum()
                other = ps.g.edge_len[ec]
                if shared <= AMB["max_shared"] * min(lq.sum(), other.sum()):
                    n_dist += 1
        res.append((int(cnt[i]), len(cand), n_dist))
    r = np.array(res) if res else np.zeros((0, 3), int)
    out = {"n_queries": len(r), "min_turns": min_turns, "stored_paths": len(ps), "sampling": ps.meta["sampling"], "n_enumerated": ps.meta["n_enumerated"]}
    if len(r):
        out.update(median_turns_of_queries=float(np.median(r[:, 0])), frac_with_distinct_twin=float((r[:, 2] >= 1).mean()),
                   frac_with_ge10_distinct=float((r[:, 2] >= 10).mean()), median_distinct=float(np.median(r[:, 2])),
                   p90_distinct=float(np.percentile(r[:, 2], 90)), max_distinct=int(r[:, 2].max()),
                   frac_with_any_match_incl_overlapping=float((r[:, 1] >= 1).mean()))
        for k in (3, 5, 8):
            m = r[:, 0] >= k
            if m.sum() >= 20:
                out[f"frac_twin_given_ge{k}_turns"] = {"n": int(m.sum()), "value": float((r[m, 2] >= 1).mean())}
    return out


# ---------------------------------------------------------------- geometry quality ---------------------------------------------------

def match_turns(a: list[Turn], b: list[Turn]):
    """Greedy one-to-one match of turns of the same sign whose [s_start, s_end] overlap; returns list of (ta, tb)."""
    used, pairs = set(), []
    for ta in a:
        best, bo = None, 0.0
        for j, tb in enumerate(b):
            if j in used or tb.sign != ta.sign:
                continue
            ov = min(ta.s_end, tb.s_end) - max(ta.s_start, tb.s_start)
            if ov > bo:
                best, bo = j, ov
        if best is not None:
            used.add(best)
            pairs.append((ta, b[best]))
    return pairs


def geometry_quality(g: NetGraph, ps: PathStore, n=400, seed=0) -> dict:
    rng = np.random.default_rng(seed)
    # vertex spacing overall and in curves (local turning angle at the vertex >= 10 deg)
    seg_all, seg_curve, big_turn_vertices = [], [], 0
    for e in range(g.n_edges):
        p = g.geom(e)
        d = np.diff(p, axis=0)
        sl = np.hypot(d[:, 0], d[:, 1])
        seg_all.append(sl)
        if len(d) >= 2:
            th = np.arctan2(-d[:, 0], d[:, 1])
            dth = np.degrees(np.abs((np.diff(th) + np.pi) % (2 * np.pi) - np.pi))
            c = dth >= 10
            seg_curve.append(((sl[:-1] + sl[1:]) / 2)[c])
            big_turn_vertices += int((dth >= 60).sum())
    sa, sc = np.concatenate(seg_all), np.concatenate(seg_curve)
    out = {"segment_m_percentiles_5_25_50_75_95_99": [float(x) for x in np.percentile(sa, [5, 25, 50, 75, 95, 99])],
           "segment_m_at_curve_vertices(>=10deg)_p5_25_50_75_95_99": [float(x) for x in np.percentile(sc, [5, 25, 50, 75, 95, 99])],
           "n_curve_vertices": int(len(sc)), "vertices_with_ge60deg_kink": big_turn_vertices}
    # angle histogram of detected turns >= 100 deg over the whole stored set
    A = np.abs(ps.z["turn_angle_deg"].astype(float))
    bins = [25, 50, 100, 140, 160, 170, 180, 190, 200, 220, 270, 361]
    h, _ = np.histogram(A, bins)
    out["abs_turn_angle_hist"] = {f"{bins[i]}-{bins[i+1]}": int(h[i]) for i in range(len(h))}
    out["turns_total"] = int(len(A))
    # raw vs spline-densified polyline on random stored paths
    idx = rng.choice(len(ps), min(n, len(ps)), replace=False)
    n_raw = n_den = n_pair = 0
    dang, dpos = [], []
    unmatched_raw_big = unmatched_den_big = 0
    for i in idx:
        p = path_polyline(g, ps.edges(int(i)), ps.L)
        try:
            pd = densify_smooth(p, 5.0)
        except Exception:  # noqa: BLE001
            continue
        tr, td = turns_of_polyline(p), turns_of_polyline(pd)
        pr = match_turns(tr, td)
        n_raw += len(tr); n_den += len(td); n_pair += len(pr)
        for a, b in pr:
            dang.append(abs(a.angle_deg) - abs(b.angle_deg)); dpos.append(((a.s_start + a.s_end) - (b.s_start + b.s_end)) / 2)
        ma = {id(a) for a, _ in pr}; mb = {id(b) for _, b in pr}
        unmatched_raw_big += sum(abs(t.angle_deg) >= 60 and id(t) not in ma for t in tr)
        unmatched_den_big += sum(abs(t.angle_deg) >= 60 and id(t) not in mb for t in td)
    d = np.array(dang)
    out["raw_vs_spline_densified"] = {"paths": int(len(idx)), "turns_raw": n_raw, "turns_spline": n_den, "matched": n_pair,
        "abs_angle_diff_median_deg": float(np.median(np.abs(d))), "abs_angle_diff_p90_deg": float(np.percentile(np.abs(d), 90)),
        "signed_mean_raw_minus_spline_deg": float(d.mean()), "pos_diff_median_abs_m": float(np.median(np.abs(dpos))),
        "unmatched_raw_turns_ge60deg": unmatched_raw_big, "unmatched_spline_turns_ge60deg": unmatched_den_big}
    return out


def hairpin_examples(g: NetGraph, ps: PathStore, k: int = 5) -> list[dict]:
    """Stored paths with the largest single turn: angle raw vs spline, and the number of polyline vertices inside the turn."""
    A = np.abs(ps.z["turn_angle_deg"].astype(float))
    order = np.argsort(-A)
    seen, out = set(), []
    for j in order:
        pi = int(np.searchsorted(ps.z["turn_off"], j, side="right") - 1)
        key = tuple(ps.way_ids(pi)[:3])
        if key in seen:
            continue
        seen.add(key)
        p = path_polyline(g, ps.edges(pi), ps.L)
        s0, s1 = float(ps.z["turn_s0_m"][j]), float(ps.z["turn_s1_m"][j])
        c = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
        nv = int(((c >= s0) & (c <= s1)).sum())
        td = turns_of_polyline(densify_smooth(p, 5.0))
        near = [t for t in td if t.sign == ps.z["turn_sign"][j] and min(t.s_end, s1) - max(t.s_start, s0) > 0]
        out.append({"path": pi, "ways": ps.way_ids(pi)[:3], "angle_raw_deg": float(ps.z["turn_angle_deg"][j]), "turn_len_m": float(s1 - s0),
                    "vertices_in_turn": nv, "angle_spline_deg": [round(t.angle_deg, 1) for t in near]})
        if len(out) >= k:
            break
    return out


def turn_density(ps: PathStore) -> dict:
    z = ps.z
    off = z["turn_off"]
    n = len(ps)
    c = np.concatenate([[0.0], np.cumsum(np.abs(z["turn_angle_deg"].astype(float)))])
    absang = c[off[1:]] - c[off[:-1]]
    cnt = np.diff(off)
    km = ps.L / 1000
    pc = [5, 25, 50, 75, 95]
    return {"L": ps.L, "n_paths": n, "sampling": ps.meta["sampling"],
            "turns_per_km_pctl_5_25_50_75_95": [float(x) for x in np.percentile(cnt / km, pc)],
            "abs_turn_deg_per_km_pctl_5_25_50_75_95": [float(x) for x in np.percentile(absang / km, pc)],
            "mean_turns_per_km": float((cnt / km).mean()), "frac_paths_with_0_turns": float((cnt == 0).mean()),
            "frac_paths_with_le2_turns": float((cnt <= 2).mean())}


# ---------------------------------------------------------------- named road ----------------------------------------------------------

def named_road(g: NetGraph, pattern: str) -> dict:
    import networkx as nx
    rx = re.compile(pattern, re.I)
    es = [e for e in range(g.n_edges) if rx.search(g.edge_name[e]) or rx.search(g.edge_ref[e])]
    if not es:
        return {"pattern": pattern, "edges": 0}
    names = {}
    for e in es:
        k = (g.edge_name[e], g.edge_ref[e], g.edge_highway[e])
        names[k] = names.get(k, 0.0) + float(g.edge_len[e])
    H = nx.Graph()
    for e in es:
        u, v = int(g.edge_u[e]), int(g.edge_v[e])
        if not H.has_edge(u, v) or H[u][v]["w"] > g.edge_len[e]:
            H.add_edge(u, v, w=float(g.edge_len[e]), e=e)
    comps = sorted(nx.connected_components(H), key=lambda c: -sum(H[a][b]["w"] for a, b in H.subgraph(c).edges()))
    res = {"pattern": pattern, "edges": len(es), "directed_km": sum(g.edge_len[e] for e in es) / 1000,
           "names_ref_highway_km": [[*k, round(v / 1000, 2)] for k, v in sorted(names.items(), key=lambda kv: -kv[1])[:12]],
           "components": len(comps), "way_ids": sorted({int(g.edge_way[e]) for e in es})[:40], "chains": []}
    for c in comps[:3]:
        S = H.subgraph(c)
        a = next(iter(c))
        d1 = nx.single_source_dijkstra_path_length(S, a, weight="w")
        b = max(d1, key=d1.get)
        d2, paths = nx.single_source_dijkstra(S, b, weight="w")
        z = max(d2, key=d2.get)
        chain = paths[z]
        pts = []
        for x, y in zip(chain[:-1], chain[1:]):
            e = H[x][y]["e"]
            gm = g.geom(e)
            if int(g.edge_u[e]) != x:
                gm = gm[::-1]
            pts.append(gm if not pts else gm[1:])
        p = np.vstack(pts)
        tt = turns_of_polyline(p)
        total = float(np.hypot(*np.diff(p, axis=0).T).sum())
        res["chains"].append({"component_km": sum(H[a_][b_]["w"] for a_, b_ in S.edges()) / 1000, "chain_km": total / 1000, "n_turns": len(tt),
                              "turns_per_km": len(tt) / (total / 1000), "turns_ge120deg": sum(abs(t.angle_deg) >= 120 for t in tt),
                              "turns_ge150deg": sum(abs(t.angle_deg) >= 150 for t in tt), "sum_abs_deg": float(sum(abs(t.angle_deg) for t in tt)),
                              "net_deg": float(sum(t.angle_deg for t in tt)), "start_node_osm": int(g.node_osm[chain[0]]),
                              "end_node_osm": int(g.node_osm[chain[-1]]),
                              "turns": [[round(t.angle_deg, 1), round(t.s_start), round(t.s_end)] for t in tt]})
    return res


# ---------------------------------------------------------------- figure ---------------------------------------------------------------

def figure(g: NetGraph, area: dict, named_pat: str, out_png) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    from pyproj import Transformer
    rx = re.compile(named_pat, re.I)
    named = np.array([bool(rx.search(g.edge_name[e]) or rx.search(g.edge_ref[e])) for e in range(g.n_edges)])
    tun = g.edge_tunnel
    segs = [g.geom(e) / 1000 for e in range(g.n_edges)]
    fig, ax = plt.subplots(figsize=(11, 11 * 0.9), dpi=130)
    base = [s for s, nm in zip(segs, named) if not nm]
    ax.add_collection(LineCollection(base, colors="#8a8f98", linewidths=0.4))
    ax.add_collection(LineCollection([s for s, nm, t in zip(segs, named, tun) if nm and not t], colors="#d1242f", linewidths=2.2))
    ax.add_collection(LineCollection([s for s, nm, t in zip(segs, named, tun) if nm and t], colors="#d1242f", linewidths=2.2, linestyles=":"))
    tr = Transformer.from_crs("EPSG:4326", g.crs, always_xy=True)
    px, py = tr.transform(area["geocoded"]["lon"], area["geocoded"]["lat"])
    ax.plot(px / 1000, py / 1000, marker="*", ms=16, mfc="#f2c200", mec="k", ls="", label="geocoded pass point (Nominatim)")
    b = area["bbox"]
    bx, by = tr.transform([b["west"], b["east"], b["east"], b["west"], b["west"]], [b["south"], b["south"], b["north"], b["north"], b["south"]])
    ax.plot(np.array(bx) / 1000, np.array(by) / 1000, color="#0969da", lw=1, ls="--", label=f"search area {area['area_km2']:.0f} km2")
    ax.plot([], [], color="#d1242f", lw=2.2, label=f"candidate road: /{named_pat}/ ({named.sum()} edges; dotted = tunnel)")
    ax.autoscale(); ax.set_aspect("equal")
    ax.set_xlabel(f"UTM easting, km ({g.crs})"); ax.set_ylabel("northing, km")
    ax.set_title(f"{area['name']}: road network used for candidate paths ({g.n_edges} directed edges)\nstar = geocoded point; the highlighted road is a CANDIDATE named like the pass, not ground truth", fontsize=10)
    ax.legend(loc="lower left", fontsize=8)
    fig.text(0.01, 0.005, "Map data (c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). Experiment-internal, not for redistribution.", fontsize=7)
    fig.tight_layout(rect=(0, 0.015, 1, 1))
    fig.savefig(out_png)
    plt.close(fig)


NAMED = {"gotthard-pass": r"gott?hard|gottardo", "cayolle-pass": r"cayolle"}


def main(slug: str) -> None:
    t0 = time.time()
    areas = json.loads((WORK / "areas.json").read_text())
    area = areas[slug]
    g = NetGraph.load(WORK / slug / "network.npz")
    und = undirected_ids(g)
    res = {"slug": slug}
    Ls = sorted(int(p.stem.split("L")[1]) for p in (WORK / slug).glob("paths_L*.npz"))
    stores = {L: PathStore.load(WORK / slug, L, g) for L in Ls}
    res["turn_density"] = {L: turn_density(s) for L, s in stores.items()}
    res["ambiguity"] = {}
    for L, s in stores.items():
        res["ambiguity"][L] = {f"min{m}": self_ambiguity(s, und, 1000, m) for m in (1, 2)}
        print(slug, L, res["ambiguity"][L], round(time.time() - t0), flush=True)
    ref = stores[1000] if 1000 in stores else stores[Ls[0]]
    res["geometry_quality"] = geometry_quality(g, stores[2000] if 2000 in stores else ref)
    res["hairpin_examples"] = hairpin_examples(g, stores[5000] if 5000 in stores else ref)
    pat, basis = NAMED[slug], "name or ref matches the pass name"
    res["named_road"] = named_road(g, pat)
    if res["named_road"]["edges"] == 0:  # nothing is named like the pass: fall back to the ref of the road that passes the geocoded point
        from pyproj import Transformer
        x, y = Transformer.from_crs("EPSG:4326", g.crs, always_xy=True).transform(area["geocoded"]["lon"], area["geocoded"]["lat"])
        dist = np.array([np.hypot(g.geom(e)[:, 0] - x, g.geom(e)[:, 1] - y).min() for e in range(g.n_edges)])
        refs = sorted({str(g.edge_ref[e]) for e in np.flatnonzero(dist <= 100) if g.edge_ref[e]})
        pat, basis = "^(" + "|".join(re.escape(r) for r in refs) + ")$", f"PROXIMITY, not name: all roads (by ref) with an edge within 100 m of the geocoded point: {refs}"
        res["named_road"] = named_road(g, pat)
    res["named_road"]["basis"] = basis
    figure(g, area, pat, WORK / f"{slug}.png")
    (WORK / slug / "analysis.json").write_text(json.dumps(res, indent=1, default=float))
    print("done", round(time.time() - t0), "s")


if __name__ == "__main__":
    main(sys.argv[1])
