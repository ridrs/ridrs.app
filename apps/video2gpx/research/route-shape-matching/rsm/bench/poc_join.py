# SPDX-License-Identifier: AGPL-3.0-or-later
"""Proof-of-concept join: vms turn sequences of two real videos (Gotthard, Cayolle) against OSM turn sequences of the area found from the
video NAME only. Entry point:  .venv/bin/python -m rsm.bench.poc_join --stage <stage[,stage...]>  (see STAGES; outputs in work/poc/).

Everything OSM-derived stays under work/ (git-ignored; (c) OpenStreetMap contributors, ODbL). No ground truth exists: nothing here says which
road the video is on. Every "correct" in this file refers to SYNTHETIC queries drawn from the map itself.

Definitions used throughout (also written to work/poc/RESULTS.md):
  block      consecutive usable vms segments (greedy: close a block once its nominal length reaches the target; a short remainder < 50 %
             of the target is merged into the last block, else it is a block of its own); never overlapping; time order kept.
  place      a distinct candidate location: matcher results whose windows share more than 50 % of the shorter window's length on the same
             directed edges are one place (node-start candidate paths overlap heavily, so the matcher's own "distinct location" rule, which
             works per path, is not enough: without this the 2nd result is the 1st one from another start node and the gap is 0).
  gap_nats   cost(2nd place) - cost(1st place); status confident iff evidence >= min_evidence and gap_nats >= min_gap (turnseq rules).
  PRIMARY    ConfidenceThresholds(min_gap_nats=5, min_evidence=2), tuned by agent A on the dev split before the test split was looked at.
  SECONDARY  (10, 4), chosen AFTER seeing agent A's test data (and not retuned here): label it so.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from rsm.core.turnseq import ConfidenceThresholds, TurnLibrary, TurnMatchParams, TurnPath, TurnQuery, search
from rsm.network.graph import NetGraph
from rsm.network.paths import PathLimitExceeded, enumerate_paths, path_polyline, turns_of_polyline
from rsm.network.store import PathStore

from .poc_guide import (ChunkedSearcher, GuideParams, dedupe_places, edge_intervals, guided_candidates, length_m, overlap_m)

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "work"
OSM = WORK / "osm"
OUT = WORK / "poc"
PAR = TurnMatchParams()
PRIMARY = ConfidenceThresholds(min_gap_nats=5.0, min_evidence=2.0)
SECONDARY = ConfidenceThresholds(min_gap_nats=10.0, min_evidence=4.0)
BIG_DEG = 45.0
RHO_PLAUS = 0.55  # lower end of the measured vms/true scale (0.56 .. 1.52); the matcher prior is 0.4 .. 1.5
LIB_LENGTHS = (1000, 2000, 5000, 10000)

AREAS = {
    "gotthard": dict(slug="gotthard-pass", video="gotthard", name="Gotthard Pass", hint=r"gott?hard|gottardo", hint_what="name/ref matches gott?hard|gottardo"),
    # Cayolle: agent B's network WITHOUT residential and living_street ways (see RESULTS.md: with them the 2 km path count is 10.4 M and no guided search finished)
    "cayolle": dict(slug="cayolle-pass-cls", video="cayolle", name="Cayolle Pass (classified roads)", hint=r"\bD ?(2202|902)\b", hint_what="ref D 2202 or D 902 (within 100 m of the geocoded pass point)",
                    dir=OUT / "cayolle-pass-cls"),
    # post-hoc sensitivity: the Gotthard area with R = 3 x 4.122 km (the fixed rule gives 2 x); built from the same local PBF, same road filter
    "gotthard-r3": dict(slug="gotthard-pass-r3", video="gotthard", name="Gotthard Pass (R=3x)", hint=r"gott?hard|gottardo", hint_what="same as gotthard", dir=OUT / "gotthard-pass-r3"),
}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def jdump(obj, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


# ----------------------------------------------------------------------------------------------------------------------------------
# 1. queries


@dataclass
class Block:
    video: str
    kind: str  # "1km" | "2km" | "4km" | "5km" | "whole"
    idx: int
    seg_range: tuple[int, int]
    t0: float
    t1: float
    nominal_m: float
    gap_nominal_m: float
    n_segments: int
    n_turns: int
    n_big: int
    query: TurnQuery = field(repr=False, default=None)

    @property
    def name(self) -> str:
        return f"{self.video}/{self.kind}/{self.idx}"

    def row(self) -> dict:
        return dict(block=self.name, segs=f"{self.seg_range[0]}-{self.seg_range[1] - 1}", t0_s=round(self.t0), t1_s=round(self.t1), span_s=round(self.t1 - self.t0),
                    nominal_m=round(self.nominal_m), gap_nominal_m=round(self.gap_nominal_m), n_segments=self.n_segments, n_turns=self.n_turns, n_big45=self.n_big)


def load_doc(video: str) -> dict:
    return json.load(open(WORK / "odometry" / video / "segments.json"))


def make_blocks(video: str, target_m: float, kind: str) -> list[Block]:
    doc = load_doc(video)
    use = [s for s in doc["segments"] if s.get("usable")]
    cuts, a, acc = [], 0, 0.0
    for k, s in enumerate(use):
        acc += s["length_nominal_m"]
        if acc >= target_m:
            cuts.append((a, k + 1))
            a, acc = k + 1, 0.0
    if a < len(use):
        if acc >= 0.5 * target_m or not cuts:
            cuts.append((a, len(use)))
        else:
            cuts[-1] = (cuts[-1][0], len(use))
    out = []
    for i, (a, b) in enumerate(cuts):
        q = TurnQuery.from_vms_segments(doc, qid=f"{video}/{kind}/{i}", seg_range=(a, b))
        seg = use[a:b]
        gap_nom = 0.0
        for k, s in enumerate(q.segments[:-1]):
            v = s.length_m / s.duration_s if s.duration_s else 3.5
            gap_nom += (s.gap_after_s or 0.0) * v
        turns = [t for s in q.segments for t in s.turns]
        out.append(Block(video, kind, i, (a, b), seg[0]["t0"], seg[-1]["t1"], q.length_m, gap_nom, b - a, len(turns),
                         sum(abs(t.angle_deg) >= BIG_DEG for t in turns), q))
    return out


def all_blocks(video: str) -> list[Block]:
    if video == "gotthard":
        return make_blocks(video, 1000, "1km") + make_blocks(video, 2000, "2km") + make_blocks(video, 4000, "4km")
    return make_blocks(video, 1000, "1km") + make_blocks(video, 2000, "2km") + make_blocks(video, 5000, "5km")


def mirrored(q: TurnQuery) -> TurnQuery:
    return q.mirrored()


# ----------------------------------------------------------------------------------------------------------------------------------
# 2. libraries


class ArrLib:
    """Complete (or sampled) node-start path set in flat arrays; works for PathStore files and for the full sets built here."""

    def __init__(self, g: NetGraph, L: float, z: dict, meta: dict, tag: str):
        self.g, self.L, self.z, self.meta, self.tag = g, float(L), z, meta, tag
        self.n = len(z["off"]) - 1
        self.toff = z["turn_off"]

    def edges(self, i: int):
        return self.z["edges"][self.z["off"][i]:self.z["off"][i + 1]]

    def turnpath(self, i: int, pid=None) -> TurnPath:
        a, b = self.toff[i], self.toff[i + 1]
        return TurnPath.from_turns(str(i) if pid is None else pid, self.z["turn_angle_deg"][a:b], self.z["turn_s0_m"][a:b], self.z["turn_s1_m"][a:b], self.L)

    def chunk_builder(self, n_chunks: int):
        bounds = np.linspace(0, self.n, n_chunks + 1).astype(int)

        def build(idx):
            a, b = int(bounds[idx]), int(bounds[idx + 1])
            return TurnLibrary([self.turnpath(i, str(i - a)) for i in range(a, b)]), a
        return build


def area_dir(slug: str) -> Path:
    for a in AREAS.values():
        if a["slug"] == slug:
            return a.get("dir", OSM / slug)
    return OSM / slug


def full_set_path(slug: str, L: int) -> Path:
    return OUT / slug / f"full_L{L}.npz"


def _turn_chunk(args):
    slug, edges_list, L = args
    g = _turn_chunk.g.get(slug)
    if g is None:
        g = _turn_chunk.g[slug] = NetGraph.load(area_dir(slug) / "network.npz")
    cnt, A, S0, S1 = [], [], [], []
    for e in edges_list:
        ts = turns_of_polyline(path_polyline(g, e, L))
        cnt.append(len(ts))
        A.extend(t.angle_deg for t in ts); S0.extend(t.s_start for t in ts); S1.extend(t.s_end for t in ts)
    return np.array(cnt, np.int32), np.array(A, np.float32), np.array(S0, np.float32), np.array(S1, np.float32)


_turn_chunk.g = {}


def build_full_set(slug: str, L: int, workers: int = 11, g: NetGraph | None = None, bbox_tag: str = "") -> Path:
    """Enumerate ALL node-start paths of length L (complete: raises when a cap is hit) and compute their turns. Stored under work/poc/."""
    from concurrent.futures import ProcessPoolExecutor
    f = full_set_path(slug, L)
    if f.exists():
        return f
    g = g or NetGraph.load(area_dir(slug) / "network.npz")
    t0 = time.time()
    ps = enumerate_paths(g, L, max_paths=6_000_000, max_expansions=120_000_000)
    log(f"[{slug}] L={L}: {len(ps)} paths, {ps.expansions} expansions, {ps.seconds:.0f}s DFS")
    n = len(ps)
    chunks = [(slug, [ps.edges[ps.off[i]:ps.off[i + 1]] for i in range(a, min(n, a + 3000))], L) for a in range(0, n, 3000)]
    with ProcessPoolExecutor(workers) as ex:
        res = list(ex.map(_turn_chunk, chunks))
    cnt = np.concatenate([r[0] for r in res])
    toff = np.zeros(n + 1, np.int64)
    toff[1:] = np.cumsum(cnt)
    f.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(f, edges=ps.edges, off=ps.off, total_len=ps.total_len, turn_off=toff, turn_angle_deg=np.concatenate([r[1] for r in res]),
                        turn_s0_m=np.concatenate([r[2] for r in res]), turn_s1_m=np.concatenate([r[3] for r in res]))
    jdump(dict(slug=slug, L=L, n_paths=n, expansions=ps.expansions, sampling="all", turns=int(toff[-1]), seconds=round(time.time() - t0, 1)), f.with_suffix(".meta.json"))
    log(f"[{slug}] L={L}: turns computed, {toff[-1]} turns, total {time.time() - t0:.0f}s -> {f}")
    return f


def load_lib(slug: str, L: int) -> ArrLib:
    """Complete library: the stored agent-B set if its sampling is 'all', else the full set built here (must exist)."""
    folder = area_dir(slug)
    mf = folder / f"paths_L{L}.meta.json"
    meta = json.loads(mf.read_text()) if mf.exists() else {"sampling": "none"}
    if meta["sampling"] == "all":
        ps = PathStore.load(folder, L)
        return ArrLib(ps.g, L, ps.z, meta, f"{slug}/L{L}/stored-complete")
    f = full_set_path(slug, L)
    if not f.exists():
        raise FileNotFoundError(f"{f}: run --stage build-full first")
    g = NetGraph.load(folder / "network.npz")
    return ArrLib(g, L, dict(np.load(f)), json.loads(f.with_suffix(".meta.json").read_text()), f"{slug}/L{L}/full-built")


def choose_L(block_or_q: Block, available=LIB_LENGTHS, rho: float = RHO_PLAUS, extra_m: float = 300.0) -> tuple[int, float]:
    need = (block_or_q.nominal_m + block_or_q.gap_nominal_m) / rho + extra_m
    for L in available:
        if L >= need:
            return L, need
    return available[-1], need


# ----------------------------------------------------------------------------------------------------------------------------------
# place details: matched span, WGS84 positions, road names


def _cum(g: NetGraph, edges) -> np.ndarray:
    return np.concatenate([[0.0], np.cumsum(g.edge_len[np.asarray(edges, int)])])


def locate(g: NetGraph, edges, s: float) -> tuple[int, float]:
    """Arc position s (m from the path start node) -> (directed edge, offset along it)."""
    cum = _cum(g, edges)
    s = min(max(s, 0.0), float(cum[-1]))
    k = min(int(np.searchsorted(cum, s, side="right")) - 1, len(edges) - 1)
    return int(edges[k]), float(s - cum[k])


def point_on_edge(g: NetGraph, e: int, off: float) -> np.ndarray:
    pts = g.geom(e)
    d = np.hypot(*np.diff(pts, axis=0).T)
    c = np.concatenate([[0.0], np.cumsum(d)])
    off = min(max(off, 0.0), float(c[-1]))
    k = min(int(np.searchsorted(c, off, side="right")) - 1, len(d) - 1)
    f = (off - c[k]) / max(d[k], 1e-9)
    return pts[k] + f * (pts[k + 1] - pts[k])


def wgs_at(g: NetGraph, edges, s: float) -> list[float]:
    e, off = locate(g, edges, s)
    ll = g.to_wgs84(point_on_edge(g, e, off)[None, :])[0]
    return [round(float(ll[1]), 5), round(float(ll[0]), 5)]  # lat, lon


def road_sequence(g: NetGraph, iv: dict, edges) -> list[dict]:
    """Run-length list of (name, ref, way id) along the window, in travel order, with metres."""
    out: list[dict] = []
    for e in edges:
        if e not in iv:
            continue
        lo, hi = iv[e]
        key = (str(g.edge_name[e]), str(g.edge_ref[e]), int(g.edge_way[e]))
        if out and (out[-1]["name"], out[-1]["ref"], out[-1]["way"]) == key:
            out[-1]["m"] += hi - lo
        else:
            out.append(dict(name=key[0], ref=key[1], way=key[2], highway=str(g.edge_highway[e]), tunnel=bool(g.edge_tunnel[e]), m=hi - lo))
    for o in out:
        o["m"] = round(o["m"])
    return out


def hint_share(iv: dict, hint: np.ndarray) -> float:
    tot = length_m(iv)
    return sum(h - l for e, (l, h) in iv.items() if hint[e]) / tot if tot > 0 else 0.0


def finalize_places(q: TurnQuery, places: list[dict], tp_of, g: NetGraph, hint: np.ndarray, top: int = 5) -> None:
    """For the first `top` places: alignment (matched turns, rho_est), matched span as directed-edge positions, WGS84 start/end of the window
    and of the matched span, road sequence, hint share. Fills the dicts in place; drops nothing."""
    from rsm.core.turnseq import _Q
    qq = _Q(q, PAR)
    for p in places[:top]:
        edges = p["edges"]
        al = align_place(q, tp_of(p), p["start_m"])
        p["align"] = None
        iv = p["iv"]
        p["roads"] = road_sequence(g, iv, edges)
        p["hint_share"] = hint_share(iv, hint)
        tot = float(g.edge_len[np.asarray(edges, int)].sum())
        a0, a1 = max(0.0, p["start_m"]), min(p["end_m"], tot)
        p["wgs_window"] = [wgs_at(g, edges, a0), wgs_at(g, edges, a1)]
        if al is None or not al["pairs"]:
            continue
        pr = al["pairs"]
        s_first, s_last = float(pr[0][4]), float(pr[-1][4])
        p["align"] = dict(cost=al["cost"], evidence=al["evidence"], components={k: (round(v, 2) if isinstance(v, float) else v) for k, v in al["components"].items()},
                          rho_est=[None if r is None else round(r, 2) for r in al["rho_est"]], n_pairs=len(pr),
                          pairs=[(int(i), int(j), round(float(qa), 1), round(float(pa), 1), round(float(pos), 1)) for i, j, qa, pa, pos in pr],
                          s_first=s_first, s_last=s_last, q_first=int(pr[0][0]), q_last=int(pr[-1][0]),
                          head_in=float(qq.pos[pr[0][0]]), tail_in=float(qq.total_in - qq.pos[pr[-1][0]]),
                          pos_first=locate(g, edges, s_first), pos_last=locate(g, edges, s_last),
                          wgs_first=wgs_at(g, edges, s_first), wgs_last=wgs_at(g, edges, s_last))


# ----------------------------------------------------------------------------------------------------------------------------------
# 3. search wrappers with physical places


def run_status(places: list[dict], thr: ConfidenceThresholds) -> dict:
    if not places:
        return dict(status="no_match", evidence=0.0, gap_nats=0.0)
    b = places[0]
    gap = (places[1]["cost"] - b["cost"]) if len(places) > 1 else float("inf")
    st = "no_match" if b["evidence"] < thr.min_evidence else ("confident" if gap >= thr.min_gap_nats else "ambiguous")
    return dict(status=st, evidence=b["evidence"], gap_nats=gap)


class CompleteSearch:
    """Search a complete ArrLib with a chunked process pool; results grouped into physical places."""

    def __init__(self, lib: ArrLib, n_chunks: int = 11, n_ranked: int = 4000, hint: np.ndarray | None = None):
        self.lib, self.n_ranked, self.hint = lib, n_ranked, hint
        self.cs = ChunkedSearcher(lib.chunk_builder(n_chunks), n_chunks)

    def close(self):
        self.cs.close()

    def places(self, q: TurnQuery, n_places: int = 12, truth: dict | None = None) -> tuple[list[dict], dict]:
        t0 = time.time()
        ent, secs, nt = self.cs.search(q, PAR, self.n_ranked)
        pl = dedupe_places(ent, self.lib.g, lambda e: self.lib.edges(e["path"]), max_places=n_places)
        for p in pl:
            p["edges"] = [int(x) for x in self.lib.edges(p["path"])]
        if self.hint is not None:
            finalize_places(q, pl, lambda p: self.lib.turnpath(p["path"]), self.lib.g, self.hint)
        info = dict(seconds=time.time() - t0, search_s=secs, n_path_turns=nt, n_entries=len(ent), n_paths=self.lib.n, lib=self.lib.tag)
        if truth is not None:
            info["truth"] = truth_stats(self.lib.g, ent, pl, lambda e: self.lib.edges(e["path"]), truth)
        return pl, info


def align_place(q: TurnQuery, lib_path: TurnPath, near_start: float) -> dict | None:
    """Alignment (components, matched pairs, rho_est) of the query on ONE candidate path, the window closest to `near_start`."""
    r = search(q, TurnLibrary([lib_path]), PAR, ConfidenceThresholds(-1e9, -1e9), top_k=4, n_ranked=0)
    if not r.matches:
        return None
    m = min(r.matches, key=lambda m: abs(m.start_m - near_start))
    return dict(cost=m.cost, evidence=m.evidence, start_m=m.start_m, end_m=m.end_m, components=m.components, pairs=m.pairs, extras=m.extras, rho_est=m.rho_est)


# ----------------------------------------------------------------------------------------------------------------------------------
# guided search (Cayolle and the foreign tests)


def truth_stats(g: NetGraph, ent: list[dict], places: list[dict], edges_of, truth: dict, cover: float = 0.5) -> dict:
    """Where does the true stretch stand? rank among places (51 = not in the first 50 places), rank among raw entries (inflated by
    duplicates of the same place), cost difference to the best entry, and the best entry's evidence."""
    r_pl = truth_rank(places, truth, cover)
    tl = length_m(truth)
    tset = set(truth)
    best = None
    for k, en in enumerate(ent):
        ed = edges_of(en)
        if tset.isdisjoint(ed):
            continue
        iv = edge_intervals(g, ed, en["start_m"], en["end_m"])
        if overlap_m(iv, truth) / max(tl, 1e-9) >= cover:
            best = (k + 1, en["cost"] - ent[0]["cost"], en["evidence"])
            break
    return dict(rank_places=r_pl, entry_rank=None if best is None else best[0], cost_delta=None if best is None else best[1],
                truth_evidence=None if best is None else best[2])


def guide_cover(paths, g: NetGraph, truth: dict) -> float:
    """Largest fraction of the true stretch (directed edges) covered by any single candidate path of the guided set."""
    tl = length_m(truth)
    tset = set(truth)
    best = 0.0
    for p in paths:
        if tset.isdisjoint(p):
            continue
        iv = edge_intervals(g, p, 0.0, 1e9)
        best = max(best, overlap_m(iv, truth) / max(tl, 1e-9))
    return best


def guided_search(g: NetGraph, q: TurnQuery, gp: GuideParams, out, n_places: int = 12, n_ranked: int = 4000, truth: dict | None = None, hint: np.ndarray | None = None) -> tuple[list[dict], dict]:
    """Guided enumeration for THIS query, then the matcher on the returned paths, places as above."""
    t0 = time.time()
    r = guided_candidates(g, q, gp, PAR, out=out)
    paths, turns = r["paths"], r["turns"]
    info = dict(guide_calls=r["calls"], guide_s=r["seconds"], capped=r["capped"], n_candidates=len(paths), Lcap=r["Lcap"])
    if not paths:
        info.update(seconds=time.time() - t0, search_s=0.0)
        if truth is not None:
            info["truth"] = dict(rank_places=51, entry_rank=None, cost_delta=None, truth_evidence=None)
            info["guide_cover"] = 0.0
        return [], info
    tps = [TurnPath.from_turns(str(i), [a for a, _, _ in tt], [s0 for _, s0, _ in tt], [s1 for _, _, s1 in tt], ln) for i, (tt, ln) in enumerate(turns)]
    lib = TurnLibrary(tps)
    res = search(q, lib, PAR, ConfidenceThresholds(-1e9, -1e9), top_k=1, n_ranked=n_ranked)
    ent = [dict(path=int(m.path_id), start_m=m.start_m, end_m=m.end_m, cost=m.cost, evidence=m.evidence) for m in res.matches]
    pl = dedupe_places(ent, g, lambda e: paths[e["path"]], max_places=n_places)
    for p in pl:
        p["edges"] = list(paths[p["path"]])
    if hint is not None:
        finalize_places(q, pl, lambda p: tps[p["path"]], g, hint)
    info.update(seconds=time.time() - t0, search_s=res.seconds, n_path_turns=res.n_path_turns)
    if truth is not None:
        info["truth"] = truth_stats(g, ent, pl, lambda e: paths[e["path"]], truth)
        info["guide_cover"] = guide_cover(paths, g, truth)
    return pl, info


# ----------------------------------------------------------------------------------------------------------------------------------
# 4. positive control: synthetic truth in the real map area


_AREA_CACHE: dict = {}


def area_graph(area: str) -> dict:
    """Graph, out-edge lists and the hint mask of an area (cached per process)."""
    if area not in _AREA_CACHE:
        a = AREAS[area]
        g = NetGraph.load(a.get("dir", OSM / a["slug"]) / "network.npz")
        rx = re.compile(a["hint"], re.I)
        hint = np.array([bool(rx.search(n + " " + r)) for n, r in zip(g.edge_name, g.edge_ref)])
        _AREA_CACHE[area] = dict(g=g, out=g.out_edges(), hint=hint)
    return _AREA_CACHE[area]


def random_walk(g: NetGraph, out, rng: np.random.Generator, length: float, allowed: np.ndarray | None = None, tries: int = 200):
    """Node-simple random walk of at least `length` metres (uniform choice among allowed out-edges to unvisited nodes). None if no walk found."""
    for _ in range(tries):
        if allowed is None:
            s = int(rng.integers(g.n_nodes))
            cand = out[s]
        else:
            ae = np.flatnonzero(allowed)
            e0 = int(rng.choice(ae))
            s = int(g.edge_u[e0])
            cand = [e0]
        visited, edges, tot = {s}, [], 0.0
        ok = True
        while tot < length:
            nxt = [e for e in cand if int(g.edge_v[e]) not in visited and (allowed is None or allowed[e])]
            if not nxt:
                ok = False
                break
            e = int(rng.choice(nxt))
            edges.append(e); tot += float(g.edge_len[e]); visited.add(int(g.edge_v[e]))
            cand = out[int(g.edge_v[e])]
        if ok:
            return edges
    return None


@dataclass
class Synth:
    area: str
    stratum: str
    target_m: float
    query: TurnQuery
    edges: list
    truth: dict  # edge -> (lo, hi) of the true stretch
    info: dict
    mirrored: bool = False


def make_synth(area: str, stratum: str, target_m: float, rng: np.random.Generator, sim) -> Synth | None:
    A = area_graph(area)
    g, out = A["g"], A["out"]
    phys = target_m / 0.75  # nominal / typical rho; the actual nominal length is whatever the simulated segments add up to
    for _ in range(30):
        allowed = None
        if stratum == "hint":
            allowed = A["hint"] & ~g.edge_tunnel
        edges = random_walk(g, out, rng, phys + 400.0, allowed)
        if edges is None:
            continue
        poly = path_polyline(g, edges)
        ts = turns_of_polyline(poly)
        total = float(np.hypot(*np.diff(poly, axis=0).T).sum())
        tp = TurnPath.from_turns("walk", [t.angle_deg for t in ts], [t.s_start for t in ts], [t.s_end for t in ts], total)
        x0 = float(rng.uniform(0.0, min(float(g.edge_len[edges[0]]) * 0.99, 300.0)))
        if x0 + phys > total:
            continue
        try:
            q, info = sim.query(tp, x0, phys, rng, qid=f"synth/{area}/{stratum}")
        except ValueError:
            continue
        truth = edge_intervals(g, edges, info["t0"], info["t1"])
        return Synth(area, stratum, target_m, q, edges, truth, info)
    return None


def truth_rank(places: list[dict], truth: dict, cover: float = 0.5) -> int:
    """Rank (1-based) of the first place whose window covers >= `cover` of the true stretch (same directed edges); 51 if none."""
    tl = length_m(truth)
    for r, p in enumerate(places):
        if overlap_m(p["iv"], truth) / max(tl, 1e-9) >= cover:
            return r + 1
    return 51


def block_like(video: str, kind: str, q: TurnQuery) -> Block:
    turns = [t for s in q.segments for t in s.turns]
    gap_nom = sum((s.gap_after_s or 0.0) * (s.length_m / s.duration_s if s.duration_s else 3.5) for s in q.segments[:-1])
    return Block(video, kind, 0, (0, len(q.segments)), 0.0, 0.0, q.length_m, gap_nom, len(q.segments), len(turns), sum(abs(t.angle_deg) >= BIG_DEG for t in turns), q)


# ----------------------------------------------------------------------------------------------------------------------------------
# 6. truth-free consistency between consecutive blocks, hint check, figures


def directed_csr(g: NetGraph):
    from scipy.sparse import csr_matrix
    best: dict = {}
    for e in range(g.n_edges):
        k = (int(g.edge_u[e]), int(g.edge_v[e]))
        if k not in best or g.edge_len[e] < best[k]:
            best[k] = float(g.edge_len[e])
    r, c = zip(*best.keys())
    return csr_matrix((list(best.values()), (r, c)), shape=(g.n_nodes, g.n_nodes))


def dist_from(g: NetGraph, csr, pos, limit=np.inf) -> np.ndarray:
    """Directed distance from position (edge, offset) to every node: rest of the edge, then shortest path from its end node."""
    from scipy.sparse.csgraph import dijkstra
    e, off = pos
    d = dijkstra(csr, directed=True, indices=int(g.edge_v[e]), limit=limit)
    return d + (float(g.edge_len[e]) - off)


def dist_to(g: NetGraph, dn: np.ndarray, pos1, pos2) -> float:
    e1, o1 = pos1
    e2, o2 = pos2
    if e1 == e2 and o2 >= o1:
        return o2 - o1
    return float(dn[int(g.edge_u[e2])]) + o2


def link_interval(tail_in: float, head_in: float, gap_s: float, v_nom: float, slack_m: float = 60.0, slack_rel: float = 0.10) -> tuple[float, float]:
    """True distance (m) from the last matched turn of block k to the first matched turn of block k+1 that the scale prior allows."""
    nom = tail_in + head_in
    lo = nom / PAR.rho_hi * (1 - slack_rel) - slack_m
    hi = (nom / PAR.rho_lo + gap_s * v_nom * PAR.gap_speed_factor / PAR.rho_lo) * (1 + slack_rel) + slack_m
    return max(lo, 0.0), hi


def consistency(area: str, recs: list[dict], blocks: list[Block], rng: np.random.Generator, n_rand: int = 20000, max_perm: int = 5000) -> dict:
    """Do consecutive blocks of one kind land at consecutive, connected places in travel direction? Top-1 place of every block: directed network
    distance from the last matched turn of block k to the first matched turn of block k+1 against the interval the scale prior allows.
    Nulls: (A) a random place for block k+1 (uniform point of the directed network); (B) shuffle of the top-1 places among the blocks of the kind."""
    A = area_graph(area)
    g = A["g"]
    csr = directed_csr(g)
    el = g.edge_len / g.edge_len.sum()
    by = {b.name: b for b in blocks}
    out = {}
    kinds = sorted({r["block"]["block"].split("/")[1] for r in recs})
    for kind in kinds:
        rs = sorted([r for r in recs if r["block"]["block"].split("/")[1] == kind], key=lambda r: int(r["block"]["block"].split("/")[2]))
        n = len(rs)
        pl = [r["places"][0] if r["places"] else None for r in rs]
        ok_pl = [p is not None and p.get("align") for p in pl]
        links = []
        for k in range(n - 1):
            ba, bb = by[rs[k]["block"]["block"]], by[rs[k + 1]["block"]["block"]]
            seg_a = ba.query.segments[-1]
            v_nom = seg_a.length_m / seg_a.duration_s if seg_a.duration_s else 3.5
            gap_s = bb.t0 - ba.t1
            links.append(dict(k=k, gap_s=gap_s, v_nom=v_nom))
        if n < 2:
            continue

        dn_cache: dict = {}

        def link_stat(pa, pb, lk):
            if not (pa and pb and pa.get("align") and pb.get("align")):
                return None
            lo, hi = link_interval(pa["align"]["tail_in"], pb["align"]["head_in"], lk["gap_s"], lk["v_nom"])
            dn = dn_cache.get(id(pa))
            if dn is None:
                dn = dn_cache[id(pa)] = dist_from(g, csr, tuple(pa["align"]["pos_last"]))
            d = dist_to(g, dn, tuple(pa["align"]["pos_last"]), tuple(pb["align"]["pos_first"]))
            return dict(d=d, lo=lo, hi=hi, ok=bool(lo <= d <= hi), dn=dn)

        rows, p_null = [], []
        for lk in links:
            k = lk["k"]
            st = link_stat(pl[k], pl[k + 1], lk)
            if st is None:
                rows.append(dict(k=k, gap_s=round(lk["gap_s"], 1), d=None, ok=False, note="no alignment"))
                p_null.append(None)
                continue
            # null A: random point of the network (edge by length, uniform offset)
            es = rng.choice(g.n_edges, n_rand, p=el)
            dn = st["dn"]
            d_r = dn[g.edge_u[es]] + rng.uniform(0, 1, n_rand) * g.edge_len[es]
            pr = float(np.mean((d_r >= st["lo"]) & (d_r <= st["hi"])))
            p_null.append(pr)
            rows.append(dict(k=k, gap_s=round(lk["gap_s"], 1), d_m=None if not np.isfinite(st["d"]) else round(st["d"]), lo_m=round(st["lo"]), hi_m=round(st["hi"]),
                             ok=st["ok"], p_random=round(pr, 4), status_a=rs[k]["status_primary"], status_b=rs[k + 1]["status_primary"]))
        T = sum(1 for r in rows if r["ok"])
        # Poisson-binomial tail under null A
        pn = [x for x in p_null if x is not None]
        dist = np.array([1.0])
        for x in pn:
            dist = np.convolve(dist, [1 - x, x])
        p_A = float(dist[T:].sum()) if pn else None
        # null B: shuffle top-1 places among the blocks
        import itertools
        idx = list(range(n))
        perms = list(itertools.permutations(idx)) if n <= 7 else [tuple(rng.permutation(n)) for _ in range(max_perm)]
        Ts = []
        for perm in perms:
            t = 0
            for lk in links:
                k = lk["k"]
                st = link_stat(pl[perm[k]], pl[perm[k + 1]], lk)
                t += int(st is not None and st["ok"])
            Ts.append(t)
        Ts = np.array(Ts)
        out[kind] = dict(n_blocks=n, n_links=len(links), consistent=T, links=rows, expected_under_A=round(float(sum(pn)), 3), p_A=p_A,
                         null_B_mean=float(Ts.mean()), null_B_p_ge=float(np.mean(Ts >= T)), null_B_n_perm=len(perms))
    return out


def span_iv(g: NetGraph, p: dict, pad: float = 30.0) -> dict | None:
    """Edge intervals between the first and the last MATCHED turn of a place (+-pad m); None without alignment."""
    a = p.get("align")
    if not a or "edges" not in p:
        return None
    return edge_intervals(g, p["edges"], a["s_first"] - pad, a["s_last"] + pad)


def nesting(area: str, recs: list[dict]) -> dict:
    """Hierarchical consistency: the matched span of the top-1 place of a block should lie inside the matched span of the top-1 place of a longer
    block that contains it in time. Statistic: share of the small span's length (same directed edges) inside the big span; null = the same
    statistic for pairs where the small block is NOT part of the big block."""
    g = area_graph(area)["g"]
    info = []
    for r in recs:
        if not r["places"]:
            continue
        iv = span_iv(g, r["places"][0])
        if iv is None:
            continue
        a, b = (int(x) for x in r["block"]["segs"].split("-"))
        info.append(dict(name=r["block"]["block"], nominal=r["block"]["nominal_m"], seg=(a, b), iv=iv, iv5=[x for x in (span_iv(g, q) for q in r["places"][:5]) if x], status=r["status_primary"]))
    nested, null = [], []
    for sm in info:
        for bg in info:
            if bg["nominal"] <= sm["nominal"] * 1.2 or bg["name"] == sm["name"]:
                continue
            f = overlap_m(sm["iv"], bg["iv"]) / max(length_m(sm["iv"]), 1e-9)
            f5 = max((overlap_m(sm["iv"], x) / max(length_m(sm["iv"]), 1e-9) for x in bg["iv5"]), default=0.0)
            inside = sm["seg"][0] >= bg["seg"][0] and sm["seg"][1] <= bg["seg"][1]
            (nested if inside else null).append(dict(small=sm["name"], big=bg["name"], f_top1=round(f, 2), f_top5=round(f5, 2), status_small=sm["status"], status_big=bg["status"]))
    n1 = sum(x["f_top1"] >= 0.5 for x in nested)
    z1 = sum(x["f_top1"] >= 0.5 for x in null)
    return dict(nested=nested, n_nested=len(nested), nested_ge50=n1, nested_top5_ge50=sum(x["f_top5"] >= 0.5 for x in nested), n_null=len(null), null_ge50=z1,
                null_top5_ge50=sum(x["f_top5"] >= 0.5 for x in null))


def window_polyline(g: NetGraph, edges, a0: float, a1: float) -> np.ndarray:
    p = path_polyline(g, edges)
    d = np.hypot(*np.diff(p, axis=0).T)
    c = np.concatenate([[0.0], np.cumsum(d)])
    a0, a1 = max(0.0, a0), min(float(c[-1]), a1)
    if a1 <= a0:
        return p[:2]
    inside = (c > a0) & (c < a1)
    def at(s):
        k = min(int(np.searchsorted(c, s, side="right")) - 1, len(d) - 1)
        return p[k] + (s - c[k]) / max(d[k], 1e-9) * (p[k + 1] - p[k])
    return np.vstack([at(a0), p[inside], at(a1)])


def random_hint_base_rate(area: str, rng: np.random.Generator, length_m: float = 1500.0, n: int = 1500) -> dict:
    A = area_graph(area)
    g, hint = A["g"], A["hint"]
    sh = []
    for _ in range(n):
        e = random_walk(g, A["out"], rng, length_m)
        if e is None:
            continue
        L = g.edge_len[e]
        sh.append(float(L[hint[e]].sum() / L.sum()))
    sh = np.array(sh)
    return dict(n=len(sh), walk_length_m=length_m, share_ge_50=float(np.mean(sh >= 0.5)), mean_share=float(sh.mean()), km_share=float(g.edge_len[hint].sum() / g.edge_len.sum()),
                km_share_no_tunnel=float(g.edge_len[hint & ~g.edge_tunnel].sum() / g.edge_len[~g.edge_tunnel].sum()))


def _edge_lines_wgs(g: NetGraph):
    from pyproj import Transformer
    tr = Transformer.from_crs(g.crs, "EPSG:4326", always_xy=True)
    xy = g.edge_geom
    lon, lat = tr.transform(xy[:, 0], xy[:, 1])
    ll = np.column_stack([lon, lat])
    return [ll[g.edge_off[e]:g.edge_off[e + 1]] for e in range(g.n_edges)], tr


def figure_video(area: str, recs_by_kind: dict, out: Path, title: str):
    """Grey network, hint road in orange, top-1 window of every block coloured by block order (viridis, arrow = travel direction); confident
    (primary thresholds) windows get a star. One panel per block kind."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    A = area_graph(area)
    g, hint = A["g"], A["hint"]
    lines, tr = _edge_lines_wgs(g)
    kinds = list(recs_by_kind)
    fig, axes = plt.subplots(1, len(kinds), figsize=(6.2 * len(kinds), 6.6), squeeze=False)
    lat0 = float(np.mean([l[:, 1].mean() for l in lines[:200]]))
    for ax, kind in zip(axes[0], kinds):
        ax.add_collection(LineCollection([l for l, h in zip(lines, hint) if not h], colors="#b9b9b9", linewidths=0.5, zorder=1))
        ax.add_collection(LineCollection([l for l, h in zip(lines, hint) if h], colors="#e8a33d", linewidths=1.6, zorder=2, label="hint road (name/ref)"))
        rs = sorted(recs_by_kind[kind], key=lambda r: int(r["block"]["block"].split("/")[2]))
        cm = plt.get_cmap("viridis")
        for i, r in enumerate(rs):
            if not r["places"]:
                continue
            p = r["places"][0]
            if "edges" not in p:
                continue
            w = window_polyline(g, p["edges"], p["start_m"], p["end_m"])
            lon, lat = tr.transform(w[:, 0], w[:, 1])
            col = cm(i / max(len(rs) - 1, 1))
            conf = r["status_primary"] == "confident"
            ax.plot(lon, lat, color=col, lw=3.2, zorder=4, solid_capstyle="round", alpha=0.95)
            m = len(lon) // 2
            if len(lon) >= 2:
                j = min(m + max(1, len(lon) // 8), len(lon) - 1)
                ax.annotate("", xy=(lon[j], lat[j]), xytext=(lon[m], lat[m]),
                            arrowprops=dict(arrowstyle="-|>", fc=col, ec="black", lw=0.8, mutation_scale=22, shrinkA=0, shrinkB=0), zorder=5)
            ax.text(lon[0], lat[0], str(i), fontsize=7, color="black", zorder=6, ha="center", va="center", bbox=dict(boxstyle="circle,pad=0.12", fc=col, ec="none", alpha=0.9))
            if conf:
                ax.plot(lon[m], lat[m], marker="*", ms=13, mfc="red", mec="black", zorder=7, ls="none")
        ax.autoscale()
        ax.set_aspect(1.0 / math.cos(math.radians(lat0)))
        ax.set_title(f"{kind} blocks, top-1 place of each (number = block order)", fontsize=9)
        ax.set_xlabel("longitude"); ax.set_ylabel("latitude")
        ax.tick_params(labelsize=7)
    fig.suptitle(title, fontsize=10)
    fig.text(0.5, 0.012, "(c) OpenStreetMap contributors, ODbL. Grey: road network used (see RESULTS.md); orange: hint road; red star: confident (gap>=5 nats, evidence>=2). Arrow: travel direction. NOT ground truth.",
             ha="center", fontsize=7)
    fig.tight_layout(rect=(0, 0.06, 1, 0.96))
    fig.savefig(out, dpi=130)
    plt.close(fig)


# ----------------------------------------------------------------------------------------------------------------------------------
# 5. stages


STAGES: dict = {}


def stage(fn):
    STAGES[fn.__name__.replace("stage_", "").replace("_", "-")] = fn
    return fn


def trim_place(p: dict, keep_edges: bool = False) -> dict:
    """JSON-friendly place record."""
    d = {k: v for k, v in p.items() if k not in ("iv", "edges")}
    d["len_m"] = round(p["len"])
    d["iv_edges"] = len(p["iv"])
    if keep_edges:
        d["edges"] = p["edges"]
    return d


def block_record(b: Block, places: list[dict], info: dict, variant: str, area: str, keep_places: int = 12) -> dict:
    st1, st2 = run_status(places, PRIMARY), run_status(places, SECONDARY)
    return dict(block=b.row(), variant=variant, area=area, status_primary=st1["status"], status_secondary=st2["status"], evidence=st1["evidence"],
                gap_nats=st1["gap_nats"], info={k: v for k, v in info.items() if k != "entries"},
                places=[trim_place(p, keep_edges=(i < 5)) for i, p in enumerate(places[:keep_places])])


def _pool_map(fn, items, workers):
    import multiprocessing as mp
    with mp.get_context("fork").Pool(workers) as pool:
        return list(pool.imap(fn, items, chunksize=1))


_G: dict = {}


def _guided_job(job):
    area, key, qpickle = job
    A = area_graph(area)
    q = qpickle
    t0 = time.time()
    pl, info = guided_search(A["g"], q, _G["gp"], A["out"], n_places=_G.get("n_places", 12), hint=A["hint"], truth=_G.get("truths", {}).get(key))
    return key, pl, info


def run_guided(area: str, items: list[tuple[str, TurnQuery]], gp: GuideParams, workers: int = 11, n_places: int = 12, truths: dict | None = None):
    """items: [(key, query)]. Returns {key: (places, info)}."""
    area_graph(area)
    _G.update(gp=gp, n_places=n_places, truths=truths or {})
    jobs = sorted(((area, k, q) for k, q in items), key=lambda j: -j[2].n_turns)  # longest first
    out = {}
    for key, pl, info in _pool_map(_guided_job, jobs, workers):
        out[key] = (pl, info)
    return out


def run_complete(area: str, items: list[tuple[str, Block]], n_places: int = 12, truths: dict | None = None, n_chunks: int = 11):
    """items: [(key, block)]; groups by library length. Returns {key: (places, info)}."""
    A = area_graph(area)
    slug = AREAS[area]["slug"]
    by_L: dict[int, list] = {}
    for key, b in items:
        L, need = choose_L(b)
        by_L.setdefault(L, []).append((key, b, need))
    out = {}
    for L, lst in sorted(by_L.items()):
        lib = load_lib(slug, L)
        cs = CompleteSearch(lib, n_chunks, hint=A["hint"])
        try:
            for key, b, need in lst:
                pl, info = cs.places(b.query, n_places, truth=(truths or {}).get(key))
                info.update(L=L, L_need=need)
                out[key] = (pl, info)
                log(f"  {slug} L={L} {key}: {len(pl)} places, {run_status(pl, PRIMARY)['status']}, {info['seconds']:.1f}s")
        finally:
            cs.close()
    return out


def lib_available(slug: str, L: int) -> bool:
    folder = area_dir(slug)
    mf = folder / f"paths_L{L}.meta.json"
    if mf.exists() and json.loads(mf.read_text())["sampling"] == "all":
        return True
    return full_set_path(slug, L).exists()


def run_auto(area: str, items: list[tuple[str, Block]], mode: str, gp: GuideParams, workers: int, n_places: int = 12, truths: dict | None = None):
    """mode complete | guided | auto (complete where a complete library of the rule's length exists, else guided)."""
    slug = AREAS[area]["slug"]
    comp, gd = [], []
    for key, b in items:
        L, _ = choose_L(b)
        (comp if (mode == "complete" or (mode == "auto" and lib_available(slug, L))) else gd).append((key, b))
    out = {}
    if comp:
        out.update(run_complete(area, comp, n_places, truths))
    if gd:
        out.update(run_guided(area, [(k, b.query) for k, b in gd], gp, workers, n_places, truths))
    return out


def make_variant(blocks: list[Block], variant: str) -> list[Block]:
    from dataclasses import replace
    if variant == "mirrored":
        return [replace(b, query=b.query.mirrored()) for b in blocks]
    return blocks


def other(video: str) -> str:
    return "cayolle" if video == "gotthard" else "gotthard"


def real_path(area: str, variant: str, mode: str) -> Path:
    return OUT / f"real_{area}_{variant}_{mode}.json"


def run_real(area: str, variant: str, mode: str, gp: GuideParams, workers: int):
    """area in AREAS; variant real | mirrored | foreign (the other video's blocks, unmirrored); mode complete | guided."""
    video = AREAS[area]["video"]
    blocks = all_blocks(other(video) if variant == "foreign" else video)
    if variant == "mirrored":
        blocks = make_variant(blocks, "mirrored")
    items = [(b.name, b) for b in blocks]
    t0 = time.time()
    res = run_auto(area, items, mode, gp, workers)
    recs = [block_record(b, *res[b.name], variant=variant, area=area) for b in blocks]
    jdump(dict(area=area, variant=variant, mode=mode, seconds=round(time.time() - t0), guide=gp.__dict__, records=recs), real_path(area, variant, mode))
    for r in recs:
        log(f"{area}/{variant}/{mode} {r['block']['block']}: {r['status_primary']} ev {r['evidence']:.1f} gap {r['gap_nats']:.1f} ({r['info'].get('seconds', 0):.0f}s)")


@stage
def stage_real(args):
    """--areas gotthard,cayolle,gotthard-r3 --variants real,mirrored,foreign --mode complete|guided (default: complete for gotthard, guided otherwise)"""
    for area in args.areas.split(","):
        for variant in args.variants.split(","):
            mode = args.mode or "auto"
            run_real(area, variant, mode, GuideParams(), args.workers)


@stage
def stage_build_r3(args):
    """POST-HOC sensitivity: the Gotthard network for R = 3 x 4.122 km (the fixed rule is 2 x), from the local Swiss PBF, same filter and
    graph code as agent B (rsm.network.graph.from_pbf / build). No download. Output work/poc/gotthard-pass-r3/network.npz."""
    import osmnx as ox
    from rsm.network import graph as gmod
    from rsm.network.area import area_for
    a = area_for("Gotthard Pass")  # geocode answer from the cache (no request)
    lat, lon = a["geocoded"]["lat"], a["geocoded"]["lon"]
    R = 3.0 * a["nominal_m"]
    dlat = math.degrees(R / 6371008.8)
    dlon = dlat / math.cos(math.radians(lat))
    a2 = dict(a, slug="gotthard-pass-r3", radius_m=R, scale_max=3.0, bbox=dict(north=lat + dlat, south=lat - dlat, east=lon + dlon, west=lon - dlon), area_km2=(2 * R / 1000) ** 2)
    out = OUT / "gotthard-pass-r3"
    out.mkdir(parents=True, exist_ok=True)
    G = gmod.from_pbf(a2, gmod.PBF["gotthard-pass"])
    g = gmod.build(ox.project_graph(G))
    g.save(out / "network.npz")
    st = gmod.stats(g)
    st.update(bbox=a2["bbox"], radius_m=R, area_km2=a2["area_km2"], pbf=G.graph.get("source"))
    jdump(st, out / "network_stats.json")
    log(json.dumps({k: st[k] for k in ("nodes", "directed_edges", "road_km_undirected", "tunnel_km", "bbox", "area_km2")}))


def sim_for(em: dict, level: str):
    """Agent A's generator at the measured level, the stress level, or 'dense' = measured error rates but 6 extra turns per km (the real
    Cayolle vms has about 13 turns per nominal km where the measured-level generator yields 6 on these roads; HYPOTHETICAL, not measured)."""
    from dataclasses import replace
    from .turnseq_bench import Sim, sim_configs
    cfgs = sim_configs(em)
    if level == "dense":
        return Sim(em, replace(cfgs["measured"], name="dense", extra_per_km=6.0))
    return Sim(em, cfgs[level])


def synth_path(area: str, stratum: str, target: float, mode: str, level: str = "measured") -> Path:
    return OUT / f"synth_{area}_{stratum}_{int(target)}_{mode}{'' if level == 'measured' else '_' + level}.json"


def synth_record(sy: Synth, pl: list[dict], info: dict) -> dict:
    st1, st2 = run_status(pl, PRIMARY), run_status(pl, SECONDARY)
    q = sy.query
    turns = [t for s_ in q.segments for t in s_.turns]
    tr = info.get("truth", {})
    return dict(target=sy.target_m, stratum=sy.stratum, nominal_m=round(q.length_m), n_obs=q.n_turns, n_big=sum(abs(t.angle_deg) >= BIG_DEG for t in turns),
                n_true=sy.info["n_true_turns"], n_missed=sy.info["n_missed"], n_extra=sy.info["n_extra"], status_primary=st1["status"], status_secondary=st2["status"],
                evidence=st1["evidence"], gap_nats=st1["gap_nats"], second_evidence=(pl[1]["evidence"] if len(pl) > 1 else None), rank=tr.get("rank_places"),
                entry_rank=tr.get("entry_rank"), cost_delta=tr.get("cost_delta"), truth_evidence=tr.get("truth_evidence"), seconds=round(info.get("seconds", 0), 1),
                n_candidates=info.get("n_candidates"), capped=info.get("capped"), guide_cover=info.get("guide_cover"), L=info.get("L"), mirrored=sy.mirrored)


def run_synth_cell(area: str, stratum: str, target: float, n: int, seed: int, mode: str, mirror: bool, workers: int, sim, gp: GuideParams, level: str = "measured"):
    rng = np.random.default_rng([seed, zlib.crc32(f"{area}|{stratum}|{int(target)}".encode())])
    sys_ = []
    while len(sys_) < n:
        sy = make_synth(area, stratum, target, rng, sim)
        if sy is not None:
            sys_.append(sy)
    out = {}
    for mir in ([False, True] if mirror else [False]):
        items = []
        truths = {}
        for i, sy in enumerate(sys_):
            key = f"{area}/{stratum}/{int(target)}/{i}"
            q = sy.query.mirrored() if mir else sy.query
            items.append((key, q))
            truths[key] = sy.truth  # for the mirrored query the truth is the same place (it must NOT be found confidently)
        t0 = time.time()
        res = run_auto(area, [(k, block_like(AREAS[area]["video"], "synth", q)) for k, q in items], mode, gp, workers, n_places=50, truths=truths)
        recs = []
        for (key, q), sy in zip(items, sys_):
            pl, info = res[key]
            sy2 = Synth(sy.area, sy.stratum, sy.target_m, q, sy.edges, sy.truth, sy.info, mir)
            recs.append(synth_record(sy2, pl, info))
        out["mirrored" if mir else "normal"] = recs
        log(f"synth {area}/{stratum}/{int(target)} mirrored={mir}: {len(recs)} queries in {time.time() - t0:.0f}s")
    jdump(dict(area=area, stratum=stratum, target=target, mode=mode, level=level, n=n, guide=gp.__dict__, **out), synth_path(area, stratum, target, mode, level))


@stage
def stage_synth(args):
    """Positive control. --areas gotthard,cayolle --n N (queries per cell; the longest block length gets N/2). Strata: any (random walks anywhere)
    and hint (walks restricted to the hint road, tunnels excluded)."""
    em = json.load(open(ROOT / "work/turnseq/error_model.json"))
    sim = sim_for(em, args.level)
    for area in args.areas.split(","):
        mode = args.mode or "auto"
        targets = (1000, 2000, 4000) if AREAS[area]["video"] == "gotthard" else (1000, 2000, 5000)
        if args.targets:
            targets = tuple(int(x) for x in args.targets.split(","))
        for stratum in args.strata.split(","):
            for t in targets:
                n = args.n if t < max(targets) else args.n_long
                run_synth_cell(area, stratum, t, n, args.seed, mode, mirror=True, workers=args.workers, sim=sim, gp=GuideParams(), level=args.level)


def load_real(area: str, variant: str, mode: str) -> dict | None:
    f = real_path(area, variant, mode)
    return json.loads(f.read_text()) if f.exists() else None


def ev_summary(recs: list[dict]) -> dict:
    ev = np.array([r["evidence"] for r in recs])
    gp = np.array([min(r["gap_nats"], 1e6) for r in recs])
    return dict(n=len(recs), confident_primary=sum(r["status_primary"] == "confident" for r in recs), confident_secondary=sum(r["status_secondary"] == "confident" for r in recs),
                ambiguous=sum(r["status_primary"] == "ambiguous" for r in recs), no_match=sum(r["status_primary"] == "no_match" for r in recs),
                evidence_min=float(ev.min()), evidence_median=float(np.median(ev)), evidence_max=float(ev.max()), evidence_p90=float(np.percentile(ev, 90)),
                gap_median=float(np.median(gp)), gap_max=float(gp.max()), ev_list=[round(float(x), 2) for x in ev])


@stage
def stage_analyze(args):
    """Consistency (task 5), negative-control summaries (6), hint check (7), figures (8) from the real_*.json files."""
    rng = np.random.default_rng(args.seed)
    res: dict = {}
    for area, mode in (("gotthard", "auto"), ("gotthard", "guided"), ("gotthard-r3", "auto"), ("gotthard-r3", "guided"), ("cayolle", "auto")):
        d = load_real(area, "real", mode)
        if d is None:
            continue
        key = f"{area}/{mode}"
        recs = d["records"]
        video = AREAS[area]["video"]
        blocks = all_blocks(video)
        out = dict(summary=ev_summary(recs))
        for v in ("mirrored", "foreign"):
            dv = load_real(area, v, mode)
            if dv is not None:
                out[v] = ev_summary(dv["records"])
        out["by_kind"] = {}
        for kind in sorted({r["block"]["block"].split("/")[1] for r in recs}):
            out["by_kind"][kind] = ev_summary([r for r in recs if r["block"]["block"].split("/")[1] == kind])
        log(f"consistency {key}")
        out["consistency"] = consistency(area, recs, blocks, rng)
        out["nesting"] = nesting(area, recs)
        # hint
        A = area_graph(area)
        top1 = [r["places"][0] for r in recs if r["places"]]
        on = [p["hint_share"] >= 0.5 for p in top1 if "hint_share" in p]
        top5_any = [any(q.get("hint_share", 0) >= 0.5 for q in r["places"][:5]) for r in recs if r["places"]]
        out["hint"] = dict(what=AREAS[area]["hint_what"], n=len(on), top1_on_hint=int(sum(on)), top1_frac=float(np.mean(on)) if on else None, top5_any_frac=float(np.mean(top5_any)) if top5_any else None,
                           confident_on_hint=[(r["block"]["block"], r["places"][0]["hint_share"]) for r in recs if r["status_primary"] == "confident" and r["places"]],
                           base=random_hint_base_rate(area, rng))
        res[key] = out
        # figure per video
        rk = {}
        for r in recs:
            rk.setdefault(r["block"]["block"].split("/")[1], []).append(r)
        figure_video(area, rk, OUT / f"fig_{area}_{mode}.png", f"{AREAS[area]['name']}: top-1 candidate of each vms block ({mode} candidate set), not ground truth")
    jdump(res, OUT / "analysis.json")


def md_table(rows: list[dict], cols: list[tuple[str, str]]) -> str:
    """cols: (key, header). Missing keys print as an empty cell."""
    if not rows:
        return "(no rows)\n"
    head = "| " + " | ".join(h for _, h in cols) + " |\n|" + "---|" * len(cols) + "\n"
    body = ""
    for r in rows:
        body += "| " + " | ".join("" if r.get(k) is None else str(r.get(k)) for k, _ in cols) + " |\n"
    return head + body


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def bin_label(n: int) -> str:
    return "0-1" if n <= 1 else "2-3" if n <= 3 else "4-7" if n <= 7 else "8-15" if n <= 15 else "16+"


def synth_stats(recs: list[dict]) -> dict:
    n = len(recs)
    if n == 0:
        return dict(n=0)
    rk = np.array([r["rank"] if r["rank"] is not None else 51 for r in recs])
    top1, top5 = int((rk == 1).sum()), int((rk <= 5).sum())
    cc = [r for r in recs if r["status_primary"] == "confident"]
    c2 = [r for r in recs if r["status_secondary"] == "confident"]
    lo, hi = wilson(top1, n)
    return dict(n=n, nominal_med=int(np.median([r["nominal_m"] for r in recs])), n_obs_med=float(np.median([r["n_obs"] for r in recs])), top1=f"{top1}/{n} ({100 * top1 / n:.0f} %) [{100 * lo:.0f},{100 * hi:.0f}]",
                top5=f"{top5}/{n} ({100 * top5 / n:.0f} %)", med_rank=float(np.median(rk)), not_in_50=int((rk > 50).sum()),
                conf_ok=sum(r["rank"] == 1 for r in cc), conf_bad=sum(r["rank"] != 1 for r in cc),
                conf2_ok=sum(r["rank"] == 1 for r in c2), conf2_bad=sum(r["rank"] != 1 for r in c2),
                ev_med=round(float(np.median([r["evidence"] for r in recs])), 1), s_med=round(float(np.median([r["seconds"] for r in recs])), 1))


def load_synth(area: str, stratum: str, target: float, mode: str, level: str = "measured") -> dict | None:
    f = synth_path(area, stratum, target, mode, level)
    return json.loads(f.read_text()) if f.exists() else None


def synth_tables() -> str:
    out = ""
    rows, rows_bin = [], []
    pool: dict = {}
    for area in ("gotthard", "cayolle"):
        mode = "auto"
        targets = (1000, 2000, 4000) if area == "gotthard" else (1000, 2000, 5000)
        for stratum in ("any", "hint"):
            for t in targets:
                for level in ("measured", "stress", "dense"):
                    d = load_synth(area, stratum, t, mode, level)
                    if d is None:
                        continue
                    for var in ("normal", "mirrored"):
                        if var in d:
                            st = synth_stats(d[var])
                            rows.append(dict(area=area, stratum=stratum, level=level, target_m=t, var=var, **st))
                            if level == "measured":
                                pool.setdefault((area, stratum, var), []).extend(d[var])
    out += md_table(rows, [("area", "area"), ("stratum", "stratum"), ("level", "error level"), ("target_m", "block nominal (m)"), ("var", "query"), ("n", "n"), ("nominal_med", "nominal med"),
                           ("n_obs_med", "turns med"), ("top1", "top-1 [95 % Wilson]"), ("top5", "top-5"), ("med_rank", "median rank"), ("not_in_50", "not in 50"),
                           ("conf_ok", "confident correct (5,2)"), ("conf_bad", "confident wrong (5,2)"), ("conf2_ok", "conf. correct (10,4)"), ("conf2_bad", "conf. wrong (10,4)"),
                           ("ev_med", "evidence med"), ("s_med", "s/query")])
    for (area, stratum, var), recs in sorted(pool.items()):
        for b in ("0-1", "2-3", "4-7", "8-15", "16+"):
            sub = [r for r in recs if bin_label(r["n_obs"]) == b]
            if sub:
                st = synth_stats(sub)
                rows_bin.append(dict(area=area, stratum=stratum, var=var, turns=b, **st))
    out += "\nBy number of observed turns (all block lengths pooled):\n\n"
    out += md_table(rows_bin, [("area", "area"), ("stratum", "stratum"), ("var", "query"), ("turns", "turns"), ("n", "n"), ("top1", "top-1"), ("top5", "top-5"), ("med_rank", "median rank"),
                               ("not_in_50", "not in 50"), ("conf_ok", "conf. correct (5,2)"), ("conf_bad", "conf. wrong (5,2)"), ("conf2_ok", "conf. correct (10,4)"), ("conf2_bad", "conf. wrong (10,4)")])
    return out


@stage
def stage_synth_tables(args):
    (OUT / "synth_tables.md").write_text(synth_tables())
    print(synth_tables())


def road_str(roads: list[dict], k: int = 6) -> str:
    parts = []
    for r in roads[:k]:
        nm = r["name"] or r["ref"] or f"way {r['way']}"
        if r["name"] and r["ref"]:
            nm += f" ({r['ref']})"
        parts.append(f"{nm} {r['m']} m" + (" [tunnel]" if r["tunnel"] else ""))
    return "; ".join(parts) + (f"; +{len(roads) - k} more" if len(roads) > k else "")


def top5_md(recs: list[dict], title: str) -> str:
    out = f"### {title}\n\n"
    for r in recs:
        b = r["block"]
        out += (f"**{b['block']}**: {b['t0_s']}-{b['t1_s']} s, nominal {b['nominal_m']} m, {b['n_turns']} turns ({b['n_big45']} >= 45 deg); status (5,2) **{r['status_primary']}**, "
                f"(10,4) {r['status_secondary']}; evidence {r['evidence']:.1f}, gap {r['gap_nats']:.1f} nats; {r['info'].get('seconds', 0):.0f} s")
        if "n_candidates" in r["info"]:
            out += f"; {r['info']['n_candidates']} guided candidates" + (" (CAPPED)" if r["info"].get("capped") else "")
        out += "\n\n"
        rows = []
        for i, p in enumerate(r["places"][:5]):
            a = p.get("align") or {}
            rho = [x for x in (a.get("rho_est") or []) if x is not None]
            rows.append(dict(rank=i + 1, path=p["path"], cost=round(p["cost"], 1), ev=round(p["evidence"], 1), gap=(round(r["places"][i + 1]["cost"] - p["cost"], 1) if i + 1 < len(r["places"]) else ""),
                             match=a.get("n_pairs"), rho=(f"{np.median(rho):.2f}" if rho else ""), ways=", ".join(str(x["way"]) for x in p["roads"][:5]) + (" ..." if len(p["roads"]) > 5 else ""),
                             roads=road_str(p["roads"], 4), start=",".join(map(str, p["wgs_window"][0])), end=",".join(map(str, p["wgs_window"][1])), hint=f"{p.get('hint_share', 0):.2f}",
                             sp0=",".join(map(str, a["wgs_first"])) if a else "", sp1=",".join(map(str, a["wgs_last"])) if a else ""))
        out += md_table(rows, [("rank", "#"), ("cost", "cost"), ("ev", "evidence"), ("gap", "gap to next"), ("match", "matched turns"), ("rho", "rho est (med)"), ("hint", "hint share"),
                               ("ways", "OSM way ids"), ("roads", "roads along the window"), ("start", "window start lat,lon"), ("end", "window end lat,lon"),
                               ("sp0", "first matched turn lat,lon"), ("sp1", "last matched turn lat,lon")]) + "\n"
    return out


def confirm_list() -> str:
    """Candidate routes per video as sequences of named roads with WGS84 endpoints, for the USER to confirm (top-1 places only; none of them is declared true)."""
    out = ""
    for area, mode in (("gotthard", "auto"), ("gotthard-r3", "guided"), ("cayolle", "auto")):
        d = load_real(area, "real", mode)
        if d is None:
            continue
        out += f"\n**{AREAS[area]['name']}** ({mode} candidate set)\n\n"
        rows = []
        for r in sorted(d["records"], key=lambda r: (-r["block"]["nominal_m"] // 1500, int(r["block"]["block"].split("/")[2]))):
            if not r["places"]:
                continue
            kind = r["block"]["block"].split("/")[1]
            if kind in ("1km",):
                continue
            p = r["places"][0]
            a = p.get("align") or {}
            rows.append(dict(block=r["block"]["block"], span=f"{r['block']['t0_s']}-{r['block']['t1_s']} s", st=r["status_primary"], ev=round(r["evidence"], 1), gap=round(min(r["gap_nats"], 999), 1),
                             roads=road_str(p["roads"], 8), first=",".join(map(str, a.get("wgs_first", ""))) if a else "", last=",".join(map(str, a.get("wgs_last", ""))) if a else "",
                             w0=",".join(map(str, p["wgs_window"][0])), w1=",".join(map(str, p["wgs_window"][1]))))
        out += md_table(rows, [("block", "block"), ("span", "video time"), ("st", "status (5,2)"), ("ev", "evidence"), ("gap", "gap"), ("roads", "road sequence (name/ref, metres in the window)"),
                               ("first", "first matched turn lat,lon"), ("last", "last matched turn lat,lon"), ("w0", "window start"), ("w1", "window end")])
    return out


@stage
def stage_report(args):
    """Assemble work/poc/RESULTS.md from the json outputs plus work/poc/notes.md (hand-written judgement, verdict, confirm-list)."""
    parts = []
    notes = OUT / "notes.md"
    parts.append(notes.read_text() if notes.exists() else "(notes.md missing)\n")
    parts.append("\n## Tables (generated by `python -m rsm.bench.poc_join --stage report`)\n")
    # blocks
    parts.append("### 1. Blocks (consecutive usable vms segments)\n\n")
    for v in ("gotthard", "cayolle"):
        parts.append(f"**{v}**\n\n" + md_table([b.row() for b in all_blocks(v)], [("block", "block"), ("segs", "usable segments"), ("t0_s", "from (s)"), ("t1_s", "to (s)"), ("span_s", "span (s)"),
                     ("nominal_m", "nominal (m)"), ("gap_nominal_m", "gaps (nominal m)"), ("n_turns", "turns"), ("n_big45", "turns >= 45 deg")]) + "\n")
    parts.append("### 2. Guide recall on synthetic queries (error model: measured / stress)\n\n" + guide_check_table() + "\n")
    # synth
    parts.append("### 3. Positive control (synthetic truth in the real map areas)\n\n" + synth_tables() + "\n")
    # real
    an = json.loads((OUT / "analysis.json").read_text()) if (OUT / "analysis.json").exists() else {}
    for area, mode in (("gotthard", "auto"), ("gotthard", "guided"), ("gotthard-r3", "auto"), ("gotthard-r3", "guided"), ("cayolle", "auto")):
        d = load_real(area, "real", mode)
        if d is None:
            continue
        recs = d["records"]
        rows = []
        for r in recs:
            p = r["places"][0] if r["places"] else None
            rows.append(dict(block=r["block"]["block"], nominal=r["block"]["nominal_m"], turns=r["block"]["n_turns"], L=r["info"].get("L", ""), st=r["status_primary"], st2=r["status_secondary"],
                             ev=round(r["evidence"], 1), gap=round(min(r["gap_nats"], 999), 1), top1=road_str(p["roads"], 3) if p else "", s=round(r["info"].get("seconds", 0))))
        parts.append(f"### 4. Real queries: {area} ({mode} candidates; total {d['seconds']} s)\n\n" + md_table(rows, [("block", "block"), ("nominal", "nominal (m)"), ("turns", "turns"), ("L", "lib L (m)"),
                     ("st", "status (5,2)"), ("st2", "status (10,4)"), ("ev", "evidence"), ("gap", "gap (nats)"), ("top1", "top-1 roads"), ("s", "s")]) + "\n")
        parts.append(top5_md(recs, f"Top-5 places, {area} / {mode}") + "\n")
    # analysis
    for key, a in an.items():
        parts.append(f"### 5-7. {key}\n\n")
        for kind, c in a["consistency"].items():
            parts.append(f"Consistency, {kind} blocks: {c['consistent']}/{c['n_links']} consecutive links consistent; expected under a random place {c['expected_under_A']:.2f} (P(>= observed) = {c['p_A']:.3g}); "
                         f"shuffled top-1 places: mean {c['null_B_mean']:.2f}, P(>= observed) = {c['null_B_p_ge']:.3g} ({c['null_B_n_perm']} permutations)\n\n")
            parts.append(md_table(c["links"], [("k", "link k->k+1"), ("gap_s", "gap (s)"), ("d_m", "network distance (m)"), ("lo_m", "allowed lo"), ("hi_m", "allowed hi"), ("ok", "consistent"),
                                               ("p_random", "P(random place ok)"), ("status_a", "status k"), ("status_b", "status k+1")]) + "\n")
        rows = []
        for name in ("summary", "mirrored", "foreign"):
            if name in a:
                x = a[name]
                rows.append(dict(set={"summary": "real area, real query", "mirrored": "real area, mirrored query", "foreign": "other video's blocks in this area"}[name], n=x["n"], conf=x["confident_primary"],
                                 conf2=x["confident_secondary"], amb=x["ambiguous"], nm=x["no_match"], emin=round(x["evidence_min"], 1), emed=round(x["evidence_median"], 1),
                                 ep90=round(x["evidence_p90"], 1), emax=round(x["evidence_max"], 1)))
        parts.append("Evidence distribution (nats) and decisions:\n\n" + md_table(rows, [("set", "query set"), ("n", "n"), ("conf", "confident (5,2)"), ("conf2", "confident (10,4)"), ("amb", "ambiguous"), ("nm", "no_match"),
                                                                                       ("emin", "ev min"), ("emed", "ev median"), ("ep90", "ev p90"), ("emax", "ev max")]) + "\n")
        ne = a["nesting"]
        parts.append(f"Nesting (top-1 place of a block inside the top-1 place of a longer block that contains it in time; inside = >= 50 % of its length): {ne['nested_ge50']}/{ne['n_nested']} nested pairs (top-5 of the big block: {ne['nested_top5_ge50']}/{ne['n_nested']}); null pairs (small block NOT in the big block): {ne['null_ge50']}/{ne['n_null']} (top-5: {ne['null_top5_ge50']}/{ne['n_null']}).\n\n" + md_table(ne['nested'], [('small', 'small'), ('big', 'big'), ('f_top1', 'inside (top-1)'), ('f_top5', 'inside (best of top-5)'), ('status_small', 'status small'), ('status_big', 'status big')]) + "\n")
        h = a["hint"]
        b = h["base"]
        parts.append(f"Hint check (HINT, not truth; {h['what']}): top-1 place on the hint road (>= 50 % of window length) in {h['top1_on_hint']}/{h['n']} blocks; any of top-5 in {100 * (h['top5_any_frac'] or 0):.0f} % of blocks. "
                     f"Base rates: hint km share of the road km {100 * b['km_share']:.1f} % ({100 * b['km_share_no_tunnel']:.1f} % without tunnels); random node-simple walks of {b['walk_length_m']:.0f} m with >= 50 % on the hint road: "
                     f"{100 * b['share_ge_50']:.1f} % (n={b['n']}).\n\n")
    parts.append("### 9. Candidate routes for the user to confirm (not truth)\n" + confirm_list())
    (OUT / "RESULTS.md").write_text("\n".join(parts))
    log(f"wrote {OUT / 'RESULTS.md'} ({sum(len(x) for x in parts)} chars)")


@stage
def stage_guide_check(args):
    """Recall of the tolerant guide on synthetic queries drawn from the same map (error model: measured level of agent A's generator):
    guide_cover = largest fraction of the true stretch covered by a single guided candidate path (>= 0.5 counts as found); and, where a complete
    library exists, whether the guided run reproduces the complete run's rank / top-1 / confident decision."""
    from .turnseq_bench import Sim, sim_configs
    em = json.load(open(ROOT / "work/turnseq/error_model.json"))
    res = {}
    for level in ("measured", "stress"):
        sim = Sim(em, sim_configs(em)[level])
        for area, targets in (("gotthard", (1000, 2000, 4000)), ("cayolle", (1000, 2000, 5000))):
            for t in targets:
                n = args.n if t != targets[-1] else args.n_long
                rng = np.random.default_rng([args.seed + 7, zlib.crc32(f"gc|{area}|{t}|{level}".encode())])
                sys_ = []
                while len(sys_) < n:
                    sy = make_synth(area, "any", t, rng, sim)
                    if sy is not None:
                        sys_.append(sy)
                keys = [f"gc/{area}/{t}/{level}/{i}" for i in range(n)]
                truths = {k: sy.truth for k, sy in zip(keys, sys_)}
                t0 = time.time()
                gd = run_guided(area, [(k, sy.query) for k, sy in zip(keys, sys_)], GuideParams(), args.workers, n_places=50, truths=truths)
                comp = {}
                slug = AREAS[area]["slug"]
                items = [(k, block_like(AREAS[area]["video"], "gc", sy.query)) for k, sy in zip(keys, sys_)]
                items_c = [(k, b) for k, b in items if lib_available(slug, choose_L(b)[0])]
                if items_c:
                    comp = run_complete(area, items_c, 50, truths)
                rows = []
                for k, sy in zip(keys, sys_):
                    pl, info = gd[k]
                    c = comp.get(k)
                    rows.append(dict(n_obs=sy.query.n_turns, n_true=sy.info["n_true_turns"], cover=info.get("guide_cover"), cand=info["n_candidates"], calls=info["guide_calls"], capped=info["capped"],
                                     seconds=round(info["seconds"], 1), rank_guided=info["truth"]["rank_places"], ev_guided=pl[0]["evidence"] if pl else None,
                                     rank_complete=(c[1]["truth"]["rank_places"] if c else None), ev_complete=(c[0][0]["evidence"] if (c and c[0]) else None),
                                     conf_guided=run_status(pl, PRIMARY)["status"], conf_complete=(run_status(c[0], PRIMARY)["status"] if c else None)))
                res[f"{area}/{t}/{level}"] = rows
                cov = np.array([r["cover"] for r in rows])
                log(f"guide-check {area} {t} {level}: n={n} recall(cover>=0.5)={np.mean(cov >= 0.5):.2f} cand med {np.median([r['cand'] for r in rows]):.0f} capped {sum(r['capped'] for r in rows)} ({time.time() - t0:.0f}s)")
    jdump(res, OUT / "guide_check.json")


def guide_check_table() -> str:
    f = OUT / "guide_check.json"
    if not f.exists():
        return "(guide_check.json missing)\n"
    d = json.loads(f.read_text())
    rows = []
    for key, rs in d.items():
        area, t, level = key.split("/")
        for lab, sel in (("all", lambda r: True), ("turns >= 4", lambda r: r["n_obs"] >= 4), ("turns <= 3", lambda r: r["n_obs"] <= 3)):
            sub = [r for r in rs if sel(r)]
            if not sub:
                continue
            both = [r for r in sub if r["rank_complete"] is not None]
            rows.append(dict(area=area, target=t, level=level, sel=lab, n=len(sub), recall=f"{sum(r['cover'] >= 0.5 for r in sub)}/{len(sub)}", capped=sum(r["capped"] for r in sub),
                             cand=int(np.median([r["cand"] for r in sub])), sec=round(float(np.median([r["seconds"] for r in sub])), 1),
                             top1_g=sum(r["rank_guided"] == 1 for r in sub), top1_c=(sum(r["rank_complete"] == 1 for r in both) if both else ""), n_both=len(both) if both else "",
                             same_top1=(sum(r["rank_guided"] == 1 and r["rank_complete"] == 1 for r in both) if both else ""),
                             conf_g=sum(r["conf_guided"] == "confident" for r in sub), conf_c=(sum(r["conf_complete"] == "confident" for r in both) if both else "")))
    return md_table(rows, [("area", "area"), ("target", "block nominal (m)"), ("level", "error level"), ("sel", "queries"), ("n", "n"), ("recall", "guide recall (some candidate covers >= 50 % of the true stretch)"),
                           ("capped", "capped"), ("cand", "candidates (median)"), ("sec", "s (median)"), ("top1_g", "top-1 guided"), ("top1_c", "top-1 complete lib"), ("n_both", "n with complete lib"),
                           ("same_top1", "top-1 in both"), ("conf_g", "confident guided"), ("conf_c", "confident complete")])


@stage
def stage_blocks(args):
    rows = {}
    for v in ("gotthard", "cayolle"):
        rows[v] = [b.row() for b in all_blocks(v)]
        for r in rows[v]:
            print(r)
    jdump(rows, OUT / "blocks.json")


def subgraph(g: NetGraph, mask: np.ndarray) -> NetGraph:
    """Same nodes, only the directed edges with mask True (geometry re-packed)."""
    idx = np.flatnonzero(mask)
    off, geo = [0], []
    for e in idx:
        p = g.geom(int(e))
        geo.append(p)
        off.append(off[-1] + len(p))
    return NetGraph(g.crs, g.node_xy, g.node_osm, g.edge_u[idx], g.edge_v[idx], g.edge_len[idx], g.edge_way[idx], np.array(off, np.int64), np.vstack(geo), g.edge_name[idx],
                    g.edge_ref[idx], g.edge_highway[idx], g.edge_tunnel[idx], g.edge_bridge[idx], g.edge_oneway[idx])


@stage
def stage_build_cls(args):
    """Cayolle without residential / living_street ways (judgement call, see RESULTS.md) + its complete path sets for 1, 2, 5 km."""
    g = NetGraph.load(OSM / "cayolle-pass" / "network.npz")
    keep = ~np.isin(g.edge_highway, ["residential", "living_street"])
    h = subgraph(g, keep)
    out = OUT / "cayolle-pass-cls"
    out.mkdir(parents=True, exist_ok=True)
    h.save(out / "network.npz")
    jdump(dict(edges_full=g.n_edges, edges_kept=h.n_edges, km_full=float(g.edge_len.sum() / 2000), km_kept=float(h.edge_len.sum() / 2000),
               dropped_km=float(g.edge_len[~keep].sum() / 2000), dropped_edges=int((~keep).sum())), out / "restriction.json")
    for L in (1000, 2000, 5000):
        build_full_set("cayolle-pass-cls", L, workers=args.workers, g=h)


@stage
def stage_build_full(args):
    build_full_set("gotthard-pass", 10000, workers=args.workers)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="blocks")
    ap.add_argument("--workers", type=int, default=11)
    ap.add_argument("--areas", default="gotthard,cayolle")
    ap.add_argument("--variants", default="real,mirrored,foreign")
    ap.add_argument("--mode", default="")
    ap.add_argument("--level", default="measured", help="synthetic error level: measured | stress (agent A's generator)")
    ap.add_argument("--targets", default="", help="override the block-length targets of stage synth, e.g. 5000")
    ap.add_argument("--strata", default="any,hint")
    ap.add_argument("--n", type=int, default=30, help="synthetic queries per cell (stage dependent)")
    ap.add_argument("--n-long", type=int, default=8, help="synthetic queries in the longest block-length cell (slow libraries)")
    ap.add_argument("--seed", type=int, default=20261110)
    args = ap.parse_args(argv)
    for s in args.stage.split(","):
        log(f"=== stage {s}")
        STAGES[s](args)


if __name__ == "__main__":
    main()
