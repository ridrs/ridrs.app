# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn-sequence matcher: synthetic sequences with known alignment, missed / extra turns, scale, gaps, mirrored control."""
from __future__ import annotations

import ast
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from rsm.core.turnseq import (ConfidenceThresholds, QSegment, QTurn, TurnLibrary, TurnMatchParams, TurnPath, TurnQuery, match_candidates, search)

PAR = TurnMatchParams()


def mkpath(pid: str, rng, n: int = 60, length: float = 15000.0, big: bool = False) -> TurnPath:
    pos = np.sort(rng.uniform(100, length - 100, n))
    pos = pos[np.concatenate([[True], np.diff(pos) > 80])]
    ang = rng.choice([-1.0, 1.0], len(pos)) * np.exp(rng.normal(4.4 if big else 4.2, 0.45, len(pos))).clip(30, 260)
    return TurnPath.from_turns(pid, ang, pos - 20, pos + 20, length)


def query_from(path: TurnPath, i0: int, i1: int, rho: float = 0.8, drop=(), extra=(), mult=1.0, one_segment: bool = True) -> tuple[TurnQuery, float, float]:
    """Turns i0..i1-1 of the path as a query of a single segment with scale rho (nominal = true * rho). Returns (query, true start, true end)."""
    c = path.center
    x0, x1 = c[i0] - 60.0, c[i1 - 1] + 60.0
    turns = []
    for k in range(i0, i1):
        if k in drop:
            continue
        cc = (c[k] - x0) * rho
        turns.append(QTurn(float(path.angle_deg[k]) * mult, cc - 20 * rho, cc + 20 * rho))
    for (cc, a) in extra:
        turns.append(QTurn(a, cc - 15, cc + 15))
    turns.sort(key=lambda t: t.center)
    L = (x1 - x0) * rho
    return TurnQuery((QSegment(L, tuple(turns), L / 3.0, None),)), x0, x1


def hit(m, name, x0, x1) -> bool:
    return m.path_id == name and min(m.end_m, x1) - max(m.start_m, x0) >= 0.5 * (x1 - x0)


def test_known_alignment_found_and_components_sum_to_cost():
    rng = np.random.default_rng(1)
    paths = [mkpath(f"p{k}", rng) for k in range(30)]
    q, x0, x1 = query_from(paths[11], 20, 32)
    r = search(q, paths, PAR, top_k=3)
    m = r.matches[0]
    assert hit(m, "p11", x0, x1)
    assert [p[1] for p in m.pairs] == list(range(20, 32))  # every turn assigned to the right path turn
    assert m.components["n_extra"] == 0 and m.components["n_flip"] == 0
    comp = m.components
    assert comp["angle"] + comp["base"] + comp["flip"] + comp["extra"] + comp["miss"] + comp["spacing"] == pytest.approx(m.cost, abs=2e-3)
    assert r.ambiguity["gap_nats"] > 8.0 and r.matches[0].evidence > 0
    est = [e for e in m.rho_est if e is not None]
    assert est and est[0] == pytest.approx(0.8, rel=0.15)


def test_missed_and_extra_turns_are_tolerated_and_counted():
    rng = np.random.default_rng(2)
    paths = [mkpath(f"p{k}", rng) for k in range(30)]
    path = paths[5]
    q, x0, x1 = query_from(path, 10, 24, drop={14, 19}, extra=[(1700.0, 250.0)])
    r = search(q, paths, PAR)
    m = r.matches[0]
    assert hit(m, "p5", x0, x1)
    assert m.components["n_extra"] == 1
    assert m.components["n_miss"] >= 2
    dropped = {k for k, w in m.misses}
    assert {14, 19} <= dropped


def test_angle_error_is_relative_and_costs_grow_with_error():
    rng = np.random.default_rng(3)
    paths = [mkpath(f"p{k}", rng) for k in range(20)]
    cost = {}
    for mult in (1.0, 0.85, 0.6):
        q, x0, x1 = query_from(paths[3], 10, 22, mult=mult)
        r = search(q, paths, PAR)
        assert hit(r.matches[0], "p3", x0, x1)
        cost[mult] = r.matches[0].components["angle"]
    assert cost[1.0] < cost[0.85] < cost[0.6]


@pytest.mark.parametrize("rho", [0.45, 0.8, 1.35])
def test_scale_inside_prior_is_free_outside_costs(rho):
    rng = np.random.default_rng(4)
    paths = [mkpath(f"p{k}", rng) for k in range(20)]
    q, x0, x1 = query_from(paths[2], 12, 24, rho=rho)
    r = search(q, paths, PAR)
    assert hit(r.matches[0], "p2", x0, x1)
    assert r.matches[0].components["spacing"] < 0.5


def test_scale_far_outside_prior_is_penalised():
    rng = np.random.default_rng(4)
    paths = [mkpath(f"p{k}", rng) for k in range(20)]
    q, x0, x1 = query_from(paths[2], 12, 24, rho=0.15)
    r = search(q, paths, PAR)
    ok = [m for m in r.matches if hit(m, "p2", x0, x1)]
    assert not ok or ok[0].components["spacing"] > 5.0 or ok[0].rank > 1


def test_segments_with_unknown_gaps_are_matched():
    rng = np.random.default_rng(5)
    paths = [mkpath(f"p{k}", rng, n=80, big=True) for k in range(30)]
    path = paths[8]
    c = path.center
    # three segments with different scales, gaps of 4 s and 7 s whose length is not given to the matcher
    spans = [(c[20] - 60, c[24] + 60, 0.7), (c[25] - 60, c[28] + 60, 1.1), (c[30] - 60, c[34] + 60, 0.55)]
    segs = []
    for k, (a, b, rho) in enumerate(spans):
        turns = tuple(QTurn(float(path.angle_deg[t]), (c[t] - a) * rho - 20 * rho, (c[t] - a) * rho + 20 * rho) for t in range(len(c)) if a <= c[t] <= b)
        segs.append(QSegment((b - a) * rho, turns, (b - a) * rho / 3.0, [4.0, 7.0, None][k]))
    q = TurnQuery(tuple(segs))
    r = search(q, paths, PAR)
    assert hit(r.matches[0], "p8", spans[0][0], spans[-1][1])
    assert r.matches[0].components["n_extra"] == 0
    assert r.matches[0].components["spacing"] < 1.0


def test_mirrored_query_is_not_confident_and_does_not_flip_match():
    rng = np.random.default_rng(6)
    paths = [mkpath(f"p{k}", rng, big=True) for k in range(40)]
    q, x0, x1 = query_from(paths[7], 15, 33)
    thr = ConfidenceThresholds(min_gap_nats=8.0, min_evidence=4.0)
    ok = search(q, paths, PAR, thr)
    assert ok.status == "confident" and hit(ok.matches[0], "p7", x0, x1)
    mir = search(q.mirrored(), paths, PAR, thr)
    assert mir.status != "confident"
    assert mir.matches[0].evidence < ok.matches[0].evidence - 10.0
    assert all(m.components["n_flip"] == 0 for m in mir.matches[:3])
    # the mirrored path is the right answer for the mirrored query
    r2 = search(q.mirrored(), paths + [paths[7].mirrored("p7~mir")], PAR, thr)
    assert hit(r2.matches[0], "p7~mir", x0, x1)


def test_flip_is_possible_when_cheap_but_costly_by_default():
    rng = np.random.default_rng(7)
    paths = [mkpath(f"p{k}", rng) for k in range(10)]
    q, x0, x1 = query_from(paths[1], 10, 20)
    segs = list(q.segments[0].turns)
    t = segs[4]
    segs[4] = QTurn(-t.angle_deg, t.s_start, t.s_end)
    q2 = TurnQuery((QSegment(q.segments[0].length_m, tuple(segs), q.segments[0].duration_s, None),))
    dflt = search(q2, paths, PAR).matches[0]
    assert hit(dflt, "p1", x0, x1) and dflt.components["n_flip"] == 0 and dflt.components["n_extra"] >= 1
    cheap = search(q2, paths, TurnMatchParams(flip_cost=1.5)).matches[0]
    assert cheap.components["n_flip"] == 1 and cheap.components["n_extra"] == 0


def test_clipped_query_turn_gives_lower_bound():
    rng = np.random.default_rng(8)
    paths = [mkpath(f"p{k}", rng) for k in range(10)]
    q, x0, x1 = query_from(paths[4], 10, 18)
    seg = q.segments[0]
    ts = list(seg.turns)
    t = ts[0]
    ts_small = [QTurn(t.angle_deg * 0.45, t.s_start, t.s_end, clipped=False)] + ts[1:]
    ts_clip = [QTurn(t.angle_deg * 0.45, t.s_start, t.s_end, clipped=True)] + ts[1:]
    mk = lambda tt: TurnQuery((QSegment(seg.length_m, tuple(tt), seg.duration_s, None),))
    c_small = search(mk(ts_small), paths, PAR).matches[0].components["angle"]
    c_clip = search(mk(ts_clip), paths, PAR).matches[0].components["angle"]
    assert c_clip < c_small


def test_distinct_locations_do_not_overlap_more_than_half():
    rng = np.random.default_rng(9)
    paths = [mkpath(f"p{k}", rng) for k in range(15)]
    q, _, _ = query_from(paths[0], 5, 12)
    r = search(q, paths, PAR, top_k=5, n_ranked=30)
    for i, a in enumerate(r.matches):
        for b in r.matches[i + 1:]:
            if a.path_id == b.path_id:
                inter = max(0.0, min(a.end_m, b.end_m) - max(a.start_m, b.start_m))
                assert inter / min(a.end_m - a.start_m, b.end_m - b.start_m) <= 0.5 + 1e-9
    assert [m.cost for m in r.matches] == sorted(m.cost for m in r.matches)


def test_empty_query_and_query_without_turns():
    rng = np.random.default_rng(10)
    paths = [mkpath("p0", rng)]
    r = search(TurnQuery((QSegment(100.0, ()),)), paths, PAR)
    assert r.status == "no_match" and r.matches == ()


def test_from_theta_and_reversed_agree_with_recomputation():
    # S-shaped road: left quarter circle (R 60 m) then right quarter circle, straight lines between
    s = np.arange(0, 700.0, 2.0)
    kappa = np.where((s > 100) & (s < 100 + 60 * math.pi / 2), 1 / 60, 0.0) - np.where((s > 400) & (s < 400 + 60 * math.pi / 2), 1 / 60, 0.0)
    theta = np.cumsum(kappa) * 2.0
    p = TurnPath.from_theta("s", s, theta)
    assert p.n_turns == 2 and p.angle_deg[0] == pytest.approx(90, abs=8) and p.angle_deg[1] == pytest.approx(-90, abs=8)
    xy = np.column_stack([np.cumsum(np.cos(theta)) * 2.0, np.cumsum(np.sin(theta)) * 2.0])
    px = TurnPath.from_xy("xy", xy)
    assert px.n_turns == 2 and np.sign(px.angle_deg).tolist() == [1, -1]
    rev = px.reversed()
    pr = TurnPath.from_xy("rev", xy[::-1])
    assert rev.n_turns == pr.n_turns == 2
    assert np.allclose(rev.angle_deg, pr.angle_deg, atol=6.0) and np.allclose(rev.center, pr.center, atol=8.0)
    m = px.mirrored()
    assert np.allclose(m.angle_deg, -px.angle_deg)


def test_from_vms_segments_and_match_candidates_interface():
    rng = np.random.default_rng(11)
    paths = [mkpath(f"p{k}", rng, big=True) for k in range(12)]
    q, x0, x1 = query_from(paths[3], 10, 20)
    doc = {"segments": [{"usable": False, "t0": 0, "t1": 5}, {"usable": True, "t0": 10.0, "t1": 40.0, "duration_s": 30.0, "length_nominal_m": q.length_m,
                                                                  "turns": [dict(angle_deg=t.angle_deg, s_start=t.s_start, s_end=t.s_end, clipped=False) for t in q.segments[0].turns]},
                         {"usable": True, "t0": 46.0, "t1": 70.0, "duration_s": 24.0, "length_nominal_m": 80.0, "turns": []}]}
    q2 = TurnQuery.from_vms_segments(doc)
    assert len(q2.segments) == 2 and q2.segments[0].gap_after_s == pytest.approx(6.0) and q2.segments[1].gap_after_s is None
    assert q2.n_turns == q.n_turns
    # candidates as (id, s, theta): a path whose heading changes by the turns
    s = np.arange(0, 6000.0, 2.0)
    theta = np.zeros_like(s)
    for a, c in ((90, 1000.0), (-70, 2000.0), (110, 3000.0), (-60, 3600.0), (80, 4500.0)):
        theta += np.radians(a) / (1 + np.exp(-(s - c) / 12.0))
    res = match_candidates(TurnQuery((QSegment(1900.0, (QTurn(88, 1000 * 0.8 - 100, 1000 * 0.8 + 100), QTurn(-68, 2000 * 0.8 - 1000 * 0.8 - 100, 2000 * 0.8 - 1000 * 0.8 + 100)), 100.0, None),)),
                           [("a", s, theta), ("b", s, -theta)], both_directions=False)
    assert res.matches and res.matches[0].path_id in ("a", "b")


def test_speed_20k_paths_smoke():
    rng = np.random.default_rng(12)
    paths = [mkpath(f"p{k}", rng, n=20, length=5000.0) for k in range(3000)]
    q, x0, x1 = query_from(paths[1234], 3, 12)
    lib = TurnLibrary(paths)
    import time

    t0 = time.perf_counter()
    r = search(q, lib, PAR, top_k=1)
    assert time.perf_counter() - t0 < 5.0
    assert hit(r.matches[0], "p1234", x0, x1)


def test_turnseq_imports_only_numpy_scipy_and_rsm():
    f = Path(__file__).resolve().parents[1] / "rsm" / "core" / "turnseq.py"
    allowed = {"numpy", "scipy"}
    stdlib = set(sys.stdlib_module_names) | {"rsm"}
    seen = set()
    for node in ast.walk(ast.parse(f.read_text())):
        mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module else []
        seen |= {m.split(".")[0] for m in mods}
    assert seen - stdlib <= allowed, seen - stdlib - allowed
    code = "import sys, rsm.core.turnseq; bad = [m for m in ('shapely', 'gpxpy', 'cv2', 'pandas', 'matplotlib', 'osmnx') if m in sys.modules]; assert not bad, bad"
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=f.parents[2])
    assert r.returncode == 0, r.stderr
