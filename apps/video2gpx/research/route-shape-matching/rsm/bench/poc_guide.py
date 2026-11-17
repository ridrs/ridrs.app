# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reusable pieces of the proof-of-concept join (see rsm/bench/poc_join.py): tolerant sequence-guided path enumeration, physical
de-duplication of candidate places, and a chunked, process-parallel search over a large turn library. Map data stays in work/.

TolerantGuide (`allow` hook of rsm.network.paths.enumerate_paths, but it also RECORDS its own results)
  The shipped rsm.network.guided.TurnGuide requires the finished turns of a prefix to be a contiguous run of the query turn list, i.e. one
  missed turn or one extra turn kills the true path. The measured error model has misses (small turns 68 %, big 7.5 %) and extras
  (about 1 per km), so this guide aligns instead of matching contiguously:
    * the finished turns of the prefix (those that end >= `commit_margin_m` before the prefix end, so the detector cannot change them any
      more) are fed one by one into a small set of hypotheses (last matched query turn i, its path position, #big misses, #extras);
    * a path turn is MATCHED to query turn k > i (turns i+1..k-1 become extras) if the sign agrees, |angle| within a ratio window (or an
      absolute allowance) and the distance to the previous matched turn is compatible with a scale rho in [rho_lo, rho_hi] (gaps may add
      length); or SKIPPED (a miss): free below `free_miss_deg`, otherwise it counts against a budget M0 + M1 * (#big path turns seen);
      extras count against E0 + E1 * (#matched + 1);
    * hypotheses that can no longer reach their next query turn (spacing deadline) die; a prefix with no hypothesis is pruned;
    * a prefix is RECORDED (and not extended) when some hypothesis has consumed the query up to `tail_extras` turns and the prefix covers the
      expected remaining length of the video (tail / rho_center).
  The turns of the growing prefix are computed from a short tail polyline only (the tail starts in a straight stretch after the last
  committed turn), with the same detector as the library (rsm.network.paths.turns_of_polyline, default TurnParams).
  The guide is an over-complete FILTER; its recall on map-derived synthetic queries is measured in poc_join (stage `guide`).
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import numpy as np

from rsm.core.turnseq import TurnMatchParams, TurnQuery, _Q
from rsm.network.graph import NetGraph
from rsm.network.paths import PathLimitExceeded, enumerate_paths, path_polyline, turns_of_polyline


@dataclass(frozen=True)
class GuideParams:
    rho_lo: float = 0.4
    rho_hi: float = 1.5
    rho_center: float = 0.75
    rho_cover_tail: float = 0.55  # coverage required when query turns after the last match are left unexplained
    slack_m: float = 30.0  # position slack added to every spacing bound (turn centres, OSM geometry)
    slack_rel: float = 0.10
    ratio_lo: float = 0.45  # |query| / |path| window for a match
    ratio_hi: float = 2.3
    abs_allow_deg: float = 20.0  # or ||query| - |path|| <= this
    free_miss_deg: float = 45.0  # path turns below this may be skipped for free (measured miss rate 68 %)
    M0: float = 2.0  # big-turn misses allowed: M0 + M1 * (#big path turns seen)
    M1: float = 0.20
    E0: float = 2.0  # extras allowed: E0 + E1 * (#matched + 1)
    E1: float = 0.25
    max_skip_q: int = 3  # query turns skipped (extras) between two matches
    tail_extras: int = 2  # query turns after the last match that may be unexplained
    commit_margin_m: float = 70.0
    keep_per_i: int = 2
    max_expansions: int = 3_000_000
    max_found: int = 400000


class _St:
    """State of a prefix, stored per DFS depth."""
    __slots__ = ("tail", "origin", "last_end", "hyps", "n_big", "plen", "turns", "tkey")

    def __init__(self, tail, origin, last_end, hyps, n_big, plen, turns=(), tkey=((), 0.0)):
        self.tail, self.origin, self.last_end, self.hyps, self.n_big, self.plen, self.turns, self.tkey = tail, origin, last_end, hyps, n_big, plen, turns, tkey


def _cut_tail(pts: np.ndarray, s: float) -> tuple[np.ndarray, float]:
    """Polyline from arc position s (relative to pts[0]) on; returns (pts, s actually used)."""
    d = np.hypot(*np.diff(pts, axis=0).T)
    c = np.concatenate([[0.0], np.cumsum(d)])
    if s <= 0:
        return pts, 0.0
    if s >= c[-1]:
        return pts[-1:].copy(), float(c[-1])
    k = int(np.searchsorted(c, s, side="right"))
    p = pts[k - 1] + (s - c[k - 1]) / max(d[k - 1], 1e-9) * (pts[k] - pts[k - 1])
    return np.vstack([p, pts[k:]]), s


class TolerantGuide:
    def __init__(self, g: NetGraph, query: TurnQuery, gp: GuideParams = GuideParams(), par: TurnMatchParams = TurnMatchParams()):
        self.g, self.gp, self.query = g, gp, query
        q = _Q(query, par)
        self.m = q.N
        self.a = q.a.copy()
        self.pos = q.pos.copy()
        self.clipped = q.clipped.copy()
        self.Gc = q.cumGc[q.seg].copy()  # cumulative upper bound of gap lengths (true m) before each turn's segment
        self.tail_tot = (q.tail_tot.copy() if q.N else np.zeros(0))
        self.total_span_nom = q.total_in + q.total_gn
        self.calls = 0
        self._cache: dict = {}
        self.cache_hits = 0
        self.found: list[tuple[int, ...]] = []
        self.found_set: set = set()
        self.found_turns: list = []
        self.st: list[_St | None] = [None] * 4096
        self.lead_len = 0.0
        self.capped = False
        self.t_first = 0.0
        # query turn lookup: sign & |angle|
        self.sgn = np.sign(self.a)
        self.aa = np.abs(self.a)

    # -- helpers -------------------------------------------------------------------------------------------------------------
    def _angle_ok(self, k: int, A: float) -> bool:
        if (A > 0) != (self.a[k] > 0):
            return False
        r = self.aa[k] / max(abs(A), 1e-9)
        if r > self.gp.ratio_hi and abs(self.aa[k] - abs(A)) > self.gp.abs_allow_deg:
            return False
        if self.clipped[k]:
            return True  # lower bound of the true angle: any smaller query angle is fine
        return r >= self.gp.ratio_lo or abs(self.aa[k] - abs(A)) <= self.gp.abs_allow_deg

    def _bounds(self, i: int, k: int) -> tuple[float, float]:
        """allowed true distance between the centres of matched query turns i and k (in-segment nominal D, gap bound G)."""
        gp = self.gp
        D = self.pos[k] - self.pos[i]
        G = self.Gc[k] - self.Gc[i]
        lo = D / gp.rho_hi * (1 - gp.slack_rel) - gp.slack_m
        hi = (D / gp.rho_lo + G) * (1 + gp.slack_rel) + gp.slack_m
        return lo, hi

    def _first_hi(self, k: int) -> float:
        """latest path position (from the start node) of a first match with query turn k."""
        gp = self.gp
        return self.lead_len + (self.pos[k] / gp.rho_lo + self.Gc[k]) * (1 + gp.slack_rel) + gp.slack_m

    def _first_lo(self, k: int) -> float:
        """earliest path position of a first match with query turn k (the video starts at x0 >= 0 inside the first edge)."""
        gp = self.gp
        return self.pos[k] / gp.rho_hi * (1 - gp.slack_rel) - gp.slack_m - 0.0

    def _feed(self, hyps: dict, A: float, c: float, n_big: int) -> dict:
        """One committed path turn -> new hypothesis dict {i: [(cost_vec, c_prev, nmiss, nextra)...]}."""
        gp = self.gp
        big = abs(A) >= gp.free_miss_deg
        out: dict[int, list] = {}
        mmax = gp.M0 + gp.M1 * n_big

        def put(i, c_prev, nmiss, nex):
            lst = out.setdefault(i, [])
            lst.append((nmiss + nex, c_prev, nmiss, nex))

        for i, lst in hyps.items():
            for (_, c_prev, nmiss, nex) in lst:
                # skip (miss)
                lead_free = (i < 0 and c <= self.lead_len)
                nm2 = nmiss + (0 if (not big or lead_free) else 1)
                if nm2 <= mmax:
                    put(i, c_prev, nm2, nex)
                # match with k
                for k in range(i + 1, min(self.m, i + 2 + gp.max_skip_q)):
                    if not self._angle_ok(k, A):
                        continue
                    if i >= 0:
                        lo, hi = self._bounds(i, k)
                        d = c - c_prev
                        if d < lo or d > hi:
                            continue
                        ex = k - i - 1
                    else:
                        if c > self._first_hi(k) or c < self._first_lo(k):
                            continue
                        ex = k
                    nx2 = nex + ex
                    if nx2 <= gp.E0 + gp.E1 * (k + 1):
                        put(k, c, nmiss, nx2)
        # reduce: per i keep best keep_per_i by cost (dedupe)
        red: dict[int, list] = {}
        for i, lst in out.items():
            lst = sorted(set(lst), key=lambda x: (x[0], x[1]))[: gp.keep_per_i]
            red[i] = lst
        return red

    def _alive(self, hyps: dict, committed_to: float, plen: float) -> tuple[bool, list]:
        """(alive, done). `done` = hypotheses that explain the query (up to tail_extras unexplained turns) and, if turns remain, cover the tail;
        the prefix is recorded for them and they are dropped. `alive` = some other hypothesis can still reach a later query turn."""
        gp = self.gp
        alive = False
        done = []
        for i, lst in hyps.items():
            if not lst:
                continue
            rem = self.m - 1 - i
            if i >= 0 and rem <= gp.tail_extras:
                cover = gp.rho_center if rem == 0 else gp.rho_cover_tail
                if any(plen >= x[1] + self.tail_tot[i] / cover for x in lst):
                    done.append(i)  # the tail of the video is covered (the matcher charges misses of path turns in its tail window, so do not cut earlier)
                else:
                    alive = True
                continue
            for k in range(i + 1, min(self.m, i + 2 + gp.max_skip_q)):
                if i >= 0:
                    hi = max(x[1] for x in lst) + self._bounds(i, k)[1]
                else:
                    hi = self._first_hi(k)
                if hi >= committed_to:
                    alive = True
                    break
        return alive, done

    def _tail_turns(self, tkey, tail) -> list:
        """Turns (angle, s_start, s_end) of the tail polyline, memoised on the tail's road description (edges + start offset): different
        starts that run into the same road share the work."""
        r = self._cache.get(tkey)
        if r is None:
            r = [(t.angle_deg, t.s_start, t.s_end) for t in turns_of_polyline(tail)]
            if len(self._cache) > 3_000_000:
                self._cache.clear()
            self._cache[tkey] = r
        else:
            self.cache_hits += 1
        return r

    def _cut_key(self, tkey, s: float):
        edges, off = tkey
        el = self.g.edge_len
        acc = -off
        for k, e in enumerate(edges):
            acc_next = acc + float(el[e])
            if s < acc_next or k == len(edges) - 1:
                return (edges[k:], round((off + s) if k == 0 else (s - acc), 2))
            acc = acc_next
        return (edges[-1:], 0.0)

    # -- the hook ------------------------------------------------------------------------------------------------------------
    def __call__(self, prefix: list, length: float) -> bool:
        gp, g = self.gp, self.g
        self.calls += 1
        if self.calls > gp.max_expansions:
            self.capped = True
            raise PathLimitExceeded("guide expansion cap", len(self.found), self.calls)
        d = len(prefix)
        if d >= len(self.st):
            self.st.extend([None] * len(self.st))
        e = prefix[-1]
        if d == 1:
            self.lead_len = float(g.edge_len[e])
            ps = _St(np.zeros((0, 2)), 0.0, -1e9, {-1: [(0, 0.0, 0, 0)]}, 0, 0.0, (), ((), 0.0))
        else:
            ps = self.st[d - 1]
        geom = g.geom(e)
        tail = np.vstack([ps.tail, geom if len(ps.tail) == 0 else geom[1:]])
        # quick check: can the tail contain a turn at all? (total heading variation)
        hyps, n_big, last_end, origin = ps.hyps, ps.n_big, ps.last_end, ps.origin
        committed_to = length - gp.commit_margin_m
        if len(tail) >= 3:
            dv = np.diff(tail, axis=0)
            th = np.unwrap(np.arctan2(dv[:, 1], dv[:, 0]))
            var = float(np.abs(np.diff(th)).sum()) if len(th) > 1 else 0.0
        else:
            var = 0.0
        cut_to = None
        turns = ps.turns
        ts = []
        origin_ts = origin  # the turns in `ts` are relative to this origin (the tail is cut below)
        tkey = (ps.tkey[0] + (e,), ps.tkey[1])
        if var >= math.radians(22.0):
            ts = self._tail_turns(tkey, tail)
            new = [t for t in ts if origin + t[2] <= committed_to and origin + t[1] > last_end]
            for t in new:
                c = origin + 0.5 * (t[1] + t[2])
                A = t[0]
                if abs(A) >= gp.free_miss_deg:
                    n_big += 1
                hyps = self._feed(hyps, A, c, n_big)
                last_end = origin + t[2]
                turns = turns + ((A, origin + t[1], origin + t[2]),)
                if not hyps:
                    return False
            if new:
                cut_to = last_end + 20.0
        elif len(tail) > 2 and length - origin > 400.0:
            cut_to = length - 150.0  # straight enough: forget the old part
        if cut_to is not None and cut_to > origin:
            tail, used = _cut_tail(tail, cut_to - origin)
            origin = origin + used
            tkey = self._cut_key(tkey, used)
        alive, done = self._alive(hyps, committed_to, length)
        if done:
            key = tuple(prefix)
            if key not in self.found_set:
                allt = turns + tuple((t[0], origin_ts + t[1], origin_ts + t[2]) for t in ts if origin_ts + t[1] > last_end)
                self.found_set.add(key)
                self.found.append(key)
                self.found_turns.append((allt, float(length)))
                if len(self.found) >= gp.max_found:
                    self.capped = True
                    raise PathLimitExceeded("guide found cap", len(self.found), self.calls)
            hyps = {i: l for i, l in hyps.items() if i not in done}
        if not alive or not hyps:
            return False
        self.st[d] = _St(tail, origin, last_end, hyps, n_big, length, turns, tkey)
        return True


def guided_candidates(g: NetGraph, query: TurnQuery, gp: GuideParams = GuideParams(), par: TurnMatchParams = TurnMatchParams(),
                      out=None, Lcap: float | None = None) -> dict:
    """Run the guided enumeration. Returns {paths: [edge tuples], calls, seconds, capped, Lcap, reached_L}."""
    t0 = time.time()
    guide = TolerantGuide(g, query, gp, par)
    if Lcap is None:
        Lcap = min(2.5 * guide.total_span_nom + 600.0, 40000.0)
    out = out if out is not None else g.out_edges()
    reached = 0
    try:
        ps = enumerate_paths(g, Lcap, allow=guide, out=out, max_paths=10**7, max_expansions=10**9)
        reached = len(ps)
        for i in range(len(ps)):  # paths that reached Lcap alive: keep them too (incomplete coverage is not penalised by the matcher)
            key = tuple(int(x) for x in ps.path_edges(i))
            if key not in guide.found_set:
                ts = turns_of_polyline(path_polyline(g, key))
                guide.found_set.add(key)
                guide.found.append(key)
                guide.found_turns.append((tuple((t.angle_deg, t.s_start, t.s_end) for t in ts), float(np.hypot(*np.diff(path_polyline(g, key), axis=0).T).sum())))
    except PathLimitExceeded:
        guide.capped = True
    return {"paths": list(guide.found), "turns": list(guide.found_turns), "calls": guide.calls, "cache_hits": guide.cache_hits, "seconds": time.time() - t0, "capped": guide.capped, "Lcap": Lcap, "reached_L": reached}


# ---------------------------------------------------------------------------------------------------------------------------------
# physical places


def edge_intervals(g: NetGraph, edges, a: float, b: float, total: float | None = None) -> dict[int, tuple[float, float]]:
    """Directed edges covered by the arc window [a, b] (metres from the path start node) -> {edge: (lo, hi)} in metres along the edge."""
    el = g.edge_len[np.asarray(edges, int)]
    cum = np.concatenate([[0.0], np.cumsum(el)])
    a, b = max(0.0, a), min(b, float(cum[-1]))
    out: dict[int, tuple[float, float]] = {}
    if b <= a:
        return out
    for k, e in enumerate(edges):
        lo, hi = max(a, cum[k]), min(b, cum[k + 1])
        if hi > lo:
            out[int(e)] = (float(lo - cum[k]), float(hi - cum[k]))
    return out


def overlap_m(A: dict, B: dict) -> float:
    s = 0.0
    for e, (l1, h1) in A.items():
        if e in B:
            l2, h2 = B[e]
            s += max(0.0, min(h1, h2) - max(l1, l2))
    return s


def length_m(A: dict) -> float:
    return sum(h - l for l, h in A.values())


def dedupe_places(entries: list[dict], g: NetGraph, edges_of, frac: float = 0.5, max_places: int = 50) -> list[dict]:
    """Greedy (entries sorted by cost): an entry is a new PLACE unless its window shares more than `frac` of the shorter window's length
    (same directed edges, same stretches) with an already accepted place. `edges_of(entry) -> edge list`. Adds `iv` (edge intervals)
    and `members` (number of entries merged into the place)."""
    places: list[dict] = []
    for en in entries:
        iv = edge_intervals(g, edges_of(en), en["start_m"], en["end_m"])
        L = length_m(iv)
        if L <= 1.0:
            continue
        hit = None
        for p in places:
            if overlap_m(iv, p["iv"]) > frac * min(L, p["len"]):
                hit = p
                break
        if hit is not None:
            hit["members"] += 1
            continue
        places.append(dict(en, iv=iv, len=L, members=1))
        if len(places) >= max_places:
            break
    return places


# ---------------------------------------------------------------------------------------------------------------------------------
# chunked, process-parallel search over a large library


def _worker(conn, build, idx):
    from rsm.core.turnseq import ConfidenceThresholds, search
    lib, offset = build(idx)
    while True:
        msg = conn.recv()
        if msg is None:
            break
        query, params, n_ranked = msg
        r = search(query, lib, params, ConfidenceThresholds(-1e9, -1e9), top_k=1, n_ranked=n_ranked)
        ent = [dict(path=int(m.path_id) + offset, start_m=m.start_m, end_m=m.end_m, cost=m.cost, evidence=m.evidence) for m in r.matches]
        conn.send((ent, r.seconds, r.n_path_turns))
    conn.close()


class ChunkedSearcher:
    """Library of many TurnPaths split into `n` chunks, each held by a forked worker process. `build(idx) -> (TurnLibrary, offset)`
    runs inside the worker (so the lib is built in parallel and never pickled); path ids of the paths must be str(local index)."""

    def __init__(self, build, n_chunks: int):
        import multiprocessing as mp
        ctx = mp.get_context("fork")
        self.conns, self.procs = [], []
        for i in range(n_chunks):
            a, b = ctx.Pipe()
            p = ctx.Process(target=_worker, args=(b, build, i), daemon=True)
            p.start()
            self.conns.append(a)
            self.procs.append(p)
        self.n = n_chunks

    def search(self, query, params, n_ranked: int = 3000) -> tuple[list[dict], float, int]:
        for c in self.conns:
            c.send((query, params, n_ranked))
        ent, secs, nt = [], 0.0, 0
        for c in self.conns:
            e, s, n = c.recv()
            ent.extend(e)
            secs = max(secs, s)
            nt += n
        ent.sort(key=lambda x: x["cost"])
        return ent[: n_ranked], secs, nt

    def close(self):
        for c in self.conns:
            try:
                c.send(None)
            except Exception:  # noqa: BLE001
                pass
        for p in self.procs:
            p.join(timeout=5)
