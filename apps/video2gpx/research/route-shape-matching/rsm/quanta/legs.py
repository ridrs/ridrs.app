# SPDX-License-Identifier: AGPL-3.0-or-later
"""Map quanta ("legs") on the directed road graph.

A turn EVENT is a turn (>= thr) found by the rsm turn detector on some directed walk (heading over distance at 1 m, Gaussian smoothing),
identified by (directed edge of its midpoint, 15 m offset bin, sign). A LEG is a pair of consecutive events along a walk with no turn >= thr
in between (turn, straight, turn) = one map quantum. The straight may pass through junctions: the enumeration branches at every junction
and only a branch that shows a turn ends a leg; a U-turn (reverse edge) is never taken.

  Phase 1  events: for every directed edge e the walks (back chain >= 60 m) + e + (forward chain >= 60 m) are scanned; turns whose start lies in
           e are owned by e. A turn that ends within 45 m of the window end is re-scanned with the window extended (branching).
  Phase 2  legs: from every event B the walk fragment [B.start - 60 m .. end of its last edge] is extended edge by edge through all
           non-reverse out-edges; after each extension the detector runs on the tail; the first stable new turn (ends >= 45 m before the walk
           end) closes the leg (B, C, straight) and the branch stops. Branches stop at STRAIGHT_MAX. Events found only in phase 2 are expanded too.
The detector is the same as for the GPS reference (rsm defaults), see RESULTS.md.
"""
from __future__ import annotations

import time
from bisect import bisect_right
from dataclasses import dataclass, field

import numpy as np

from rsm.network.graph import NetGraph
from rsm.network.paths import heading_curve
from rsm.odometry.turns import TurnParams, detect_turns

BACK_M = 60.0
LOOK_M = 45.0
KEY_BIN_M = 15.0
MAX_WINDOWS_PER_EDGE = 48
MERGE_M = 12.0
MAX_EXPANSIONS = 4000  # walk extensions per event in phase 2 (counted in stats['truncated'])


@dataclass
class Event:
    key: tuple
    fe: tuple  # edges of the fragment [start - BACK_M, end of last edge]
    s0: float  # turn start / end measured from the start of fe[0]
    s1: float
    sign: int
    angle: float  # absolute deg
    length: float
    mid: tuple  # xy of the turn midpoint
    edge: int  # directed edge of the midpoint
    off: float  # offset of the midpoint on that edge


class Walk:
    """Concatenated polyline of a list of directed edges with the arc-length bookkeeping."""

    __slots__ = ("g", "edges", "starts", "pts", "cum")

    def __init__(self, g: NetGraph, edges: list[int]):
        self.g = g
        self.edges = list(edges)
        parts = [g.geom(e) if i == 0 else g.geom(e)[1:] for i, e in enumerate(edges)]
        self.pts = np.vstack(parts)
        d = np.hypot(*np.diff(self.pts, axis=0).T)
        self.cum = np.concatenate([[0.0], np.cumsum(d)])
        st, c = [], 0.0
        for e in edges:
            st.append(c)
            c += float(g.edge_len[e])
        self.starts = st

    @property
    def total(self) -> float:
        return float(self.cum[-1])

    def extend(self, e: int) -> "Walk":
        w = Walk.__new__(Walk)
        w.g, w.edges = self.g, self.edges + [e]
        add = self.g.geom(e)[1:]
        w.pts = np.vstack([self.pts, add])
        d = np.hypot(*np.diff(np.vstack([self.pts[-1:], add]), axis=0).T)
        w.cum = np.concatenate([self.cum, self.cum[-1] + np.cumsum(d)])
        w.starts = self.starts + [float(self.cum[-1])]
        return w

    def locate(self, s: float) -> tuple[int, float]:
        """(index in edges, offset) of arc length s (by the geometric cum, edge starts are geometric too)."""
        i = max(bisect_right(self.starts, s) - 1, 0)
        return i, s - self.starts[i]

    def xy(self, s: float) -> tuple[float, float]:
        return float(np.interp(s, self.cum, self.pts[:, 0])), float(np.interp(s, self.cum, self.pts[:, 1]))


def _turns(pts: np.ndarray, params: TurnParams):
    s, th, _ = heading_curve(pts, params.step_m)
    return detect_turns(s, th, s, params)


def event_key(w: Walk, s0: float, s1: float, sign: int):
    sm = 0.5 * (s0 + s1)
    i, off = w.locate(sm)
    return (int(w.edges[i]), int(off // KEY_BIN_M), int(sign)), int(w.edges[i]), off


def make_event(w: Walk, t, base: float = 0.0) -> Event:
    """Event from detector turn `t` (positions relative to the window `w` + `base`); fragment = [t.start - BACK_M, end of the edge holding t.end + LOOK_M]."""
    s0, s1 = t.s_start + base, t.s_end + base
    key, e, off = event_key(w, s0, s1, t.sign)
    i0, _ = w.locate(max(s0 - BACK_M, 0.0))
    i1, _ = w.locate(min(s1 + LOOK_M, w.total))
    fe = tuple(int(x) for x in w.edges[i0:i1 + 1])
    shift = w.starts[i0]
    return Event(key, fe, s0 - shift, s1 - shift, int(t.sign), abs(t.angle_deg), float(t.length_m), w.xy(0.5 * (s0 + s1)), e, off)


class LegBuilder:
    def __init__(self, g: NetGraph, thr: float = 45.0, params: TurnParams | None = None, straight_max: float = 3000.0):
        self.g, self.thr, self.straight_max = g, thr, straight_max
        self.params = params or TurnParams()
        from dataclasses import replace
        self.params = replace(self.params, min_angle_deg=thr)
        self.out = g.out_edges()
        self.inn: list[list[int]] = [[] for _ in range(g.n_nodes)]
        for e, v in enumerate(g.edge_v):
            self.inn[int(v)].append(e)
        self.stats = dict(windows=0, windows_capped=0, extensions=0, detects=0)

    def _not_reverse(self, cur: int, x: int) -> bool:
        g = self.g
        return not (g.edge_v[x] == g.edge_u[cur] and g.edge_u[x] == g.edge_v[cur])

    # ---------------------------------------------------------------- phase 1
    def back_chains(self, e: int):
        """All predecessor chains (list of edges ending before e) of total length >= BACK_M (or ending at a source), no U-turns."""
        res, stack = [], [([], 0.0, e)]
        while stack:
            chain, tot, head = stack.pop()
            if tot >= BACK_M:
                res.append(chain)
                continue
            preds = [p for p in self.inn[int(self.g.edge_u[head])] if self._not_reverse(head, p) and p not in chain and p != e]
            if not preds:
                res.append(chain)
                continue
            for p in preds:
                stack.append(([p] + chain, tot + float(self.g.edge_len[p]), p))
            if len(res) + len(stack) > MAX_WINDOWS_PER_EDGE:
                self.stats["windows_capped"] += 1
                res.extend(c for c, _, _ in stack)
                break
        return res

    def events_of_edge(self, e: int) -> list[Event]:
        evs: dict[tuple, Event] = {}
        n_w = 0
        for chain in self.back_chains(e):
            base_edges = chain + [e]
            lb = float(sum(self.g.edge_len[x] for x in chain))
            le = float(self.g.edge_len[e])
            # forward extensions: DFS until the window ends >= LOOK_M after the end of e and no owned turn is unstable
            stack = [Walk(self.g, base_edges)]
            while stack and n_w < MAX_WINDOWS_PER_EDGE:
                w = stack.pop()
                n_w += 1
                self.stats["windows"] += 1
                ts = _turns(w.pts, self.params)
                self.stats["detects"] += 1
                unstable = False
                for t in ts:
                    if not (lb <= t.s_start < lb + le):
                        continue
                    if t.s_end > w.total - LOOK_M:
                        unstable = True
                        continue
                    ev = make_event(w, t)
                    evs.setdefault(ev.key, ev)
                tail = w.total - (lb + le)
                if tail < LOOK_M or unstable:
                    nxt = [x for x in self.out[int(self.g.edge_v[w.edges[-1]])] if self._not_reverse(w.edges[-1], x)]
                    if nxt and w.total < lb + le + 600.0:
                        stack.extend(w.extend(x) for x in nxt)
        return list(evs.values())

    # ---------------------------------------------------------------- phase 2
    def _tail_turns(self, w: Walk, checked: float):
        """Turns of the walk, detected on its tail only (from 300 m before `checked`); positions in the walk's coordinates."""
        from dataclasses import replace as _rep
        if w.total < 1200.0:
            return _turns(w.pts, self.params)
        k = int(np.searchsorted(w.cum, max(0.0, checked - 300.0)))
        base = float(w.cum[k])
        return [_rep(t, s_start=t.s_start + base, s_end=t.s_end + base) for t in _turns(w.pts[k:], self.params)]

    def legs_of_event(self, ev: Event):
        """-> (legs [(c_event, straight, edges_from_B_to_C)], new_events). Straight = C.start - B.end along the walk."""
        w0 = Walk(self.g, list(ev.fe))
        ts = _turns(w0.pts, self.params)
        self.stats["detects"] += 1
        # B must be re-found in its own fragment (same sign, midpoint within 12 m)
        mid = 0.5 * (ev.s0 + ev.s1)
        if not any(t.sign == ev.sign and abs(0.5 * (t.s_start + t.s_end) - mid) < 12.0 for t in ts):
            return [], [], 0
        legs, new = [], []
        stack = [(w0, ev.s1 + 0.5)]
        n_ext = 0
        while stack:
            w, checked = stack.pop()
            ts = self._tail_turns(w, checked)
            self.stats["detects"] += 1
            found = None
            for t in ts:
                if t.s_start >= checked and t.s_start > ev.s1 + 0.5 and t.s_end <= w.total - LOOK_M:
                    found = t
                    break
            if found is not None:
                cev = make_event(w, found)
                straight = found.s_start - ev.s1
                # edges from the one holding B's mid to the one holding C's mid
                iB, _ = w.locate(mid)
                iC, _ = w.locate(0.5 * (found.s_start + found.s_end))
                legs.append((cev, float(straight), tuple(int(x) for x in w.edges[iB:iC + 1])))
                new.append(cev)
                continue
            # no stable turn yet: extend while the straight can still be <= straight_max
            if w.total - ev.s1 > self.straight_max + LOOK_M:
                continue
            nxt = [x for x in self.out[int(self.g.edge_v[w.edges[-1]])] if self._not_reverse(w.edges[-1], x) and x not in w.edges]  # edge-simple
            n_ext += len(nxt)
            if n_ext > MAX_EXPANSIONS:
                self.stats["truncated"] = self.stats.get("truncated", 0) + 1
                break
            nchecked = max(checked, w.total - LOOK_M - 1.0)  # everything older than this was stable-checked
            for x in nxt:
                stack.append((w.extend(x), nchecked))
        return legs, new, n_ext


def _worker_init(g, thr, straight_max):
    global _LB
    _LB = LegBuilder(g, thr, straight_max=straight_max)


def _w_events(edges):
    out = []
    for e in edges:
        out.extend(_LB.events_of_edge(int(e)))
    return out, dict(_LB.stats)


def _w_legs(events):
    res = []
    for ev in events:
        legs, new, n_ext = _LB.legs_of_event(ev)
        res.append((ev.key, legs, n_ext))
    return res, dict(_LB.stats)


def build_legs(g: NetGraph, thr: float = 45.0, straight_max: float = 3000.0, workers: int = 10, log=print) -> dict:
    """Events and legs of the whole graph. Returns dict of arrays (see `pack`) plus 'stats'."""
    import multiprocessing as mp
    t0 = time.time()
    ctx = mp.get_context("fork")
    chunks = lambda xs, n: [xs[i:i + n] for i in range(0, len(xs), n)]
    events: dict[tuple, Event] = {}
    stats_all = dict(windows=0, windows_capped=0, extensions=0, detects=0)

    def run(fn, items, n):
        with ctx.Pool(workers, initializer=_worker_init, initargs=(g, thr, straight_max)) as pool:
            return pool.map(fn, chunks(items, n))

    res = run(_w_events, list(range(g.n_edges)), 64)
    for evs, st in res:
        for ev in evs:
            events.setdefault(ev.key, ev)
        for k in st:
            stats_all[k] = stats_all.get(k, 0) + st[k]
    log(f"  phase 1: {len(events)} events from {g.n_edges} directed edges in {time.time()-t0:.0f}s")
    legs_by_key: dict[tuple, list] = {}
    todo = list(events.values())
    rounds = 0
    while todo:
        rounds += 1
        res = run(_w_legs, todo, 64)
        newkeys = {}
        for r, st in res:
            for key, legs, n_ext in r:
                legs_by_key[key] = legs
                for cev, _, _ in legs:
                    if cev.key not in events and cev.key not in newkeys:
                        newkeys[cev.key] = cev
        for k, ev in newkeys.items():
            events[k] = ev
        todo = [ev for ev in newkeys.values() if ev.key not in legs_by_key]
        log(f"  phase 2 round {rounds}: {len(legs_by_key)} events expanded, {len(newkeys)} new, {time.time()-t0:.0f}s")
    return pack(events, legs_by_key, thr, time.time() - t0)


def pack(events: dict, legs_by_key: dict, thr: float, seconds: float) -> dict:
    """Struct of arrays: events (index by order of `keys`) and legs referencing event indices (a, b)."""
    # merge key-bin duplicates: same directed edge, same sign, midpoints within MERGE_M along the edge -> one event (representative = first)
    order = sorted(events, key=lambda k: (events[k].edge, events[k].sign, events[k].off))
    rep: dict[tuple, tuple] = {}
    last = None
    for k in order:
        e = events[k]
        if last is not None and events[last].edge == e.edge and events[last].sign == e.sign and e.off - events[last].off <= MERGE_M:
            rep[k] = rep[last]
        else:
            rep[k] = k
        last = k
    keys = [k for k in events if rep[k] == k]
    idx = {k: i for i, k in enumerate(keys)}
    idx_of = {k: idx[rep[k]] for k in events}
    E = dict(sign=np.array([events[k].sign for k in keys], np.int8), angle=np.array([events[k].angle for k in keys]),
             length=np.array([events[k].length for k in keys]), mid=np.array([events[k].mid for k in keys]),
             edge=np.array([events[k].edge for k in keys], np.int32), off=np.array([events[k].off for k in keys]))
    la, lb, ls, le_off, le_flat = [], [], [], [0], []
    seen = set()
    for k in events:
        for cev, st, edges in legs_by_key.get(k, []):
            a_, b_ = idx_of[k], idx_of[cev.key]
            sig = (a_, b_, int(round(st / 5.0)))
            if a_ == b_ or sig in seen:
                continue
            seen.add(sig)
            la.append(a_); lb.append(b_); ls.append(st)
            le_flat.extend(edges); le_off.append(len(le_flat))
    la, lb, ls = np.array(la, np.int32), np.array(lb, np.int32), np.array(ls)
    q = dict(sign1=E["sign"][la].astype(float), ang1=E["angle"][la], sign2=E["sign"][lb].astype(float), ang2=E["angle"][lb],
             len1=E["length"][la], len2=E["length"][lb], straight=ls)
    st_c = np.maximum(ls, 1.0)
    q["lr1"], q["lr2"] = np.log(np.maximum(q["len1"], 1.0) / st_c), np.log(np.maximum(q["len2"], 1.0) / st_c)
    return dict(thr=thr, events=E, leg_a=la, leg_b=lb, q=q, leg_edges=np.array(le_flat, np.int32), leg_edges_off=np.array(le_off, np.int64), seconds=seconds)


def save(path, m: dict) -> None:
    flat = {"thr": np.array(m["thr"]), "seconds": np.array(m["seconds"]), "leg_a": m["leg_a"], "leg_b": m["leg_b"], "leg_edges": m["leg_edges"],
            "leg_edges_off": m["leg_edges_off"]}
    flat.update({f"e_{k}": v for k, v in m["events"].items()})
    flat.update({f"q_{k}": v for k, v in m["q"].items()})
    np.savez_compressed(path, **flat)


def load(path) -> dict:
    z = np.load(path)
    return dict(thr=float(z["thr"]), seconds=float(z["seconds"]), leg_a=z["leg_a"], leg_b=z["leg_b"], leg_edges=z["leg_edges"], leg_edges_off=z["leg_edges_off"],
                events={k[2:]: z[k] for k in z.files if k.startswith("e_")}, q={k[2:]: z[k] for k in z.files if k.startswith("q_")})
