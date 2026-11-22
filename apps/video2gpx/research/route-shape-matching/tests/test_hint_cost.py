# SPDX-License-Identifier: AGPL-3.0-or-later
"""A28: the distance to the route hint costs, the bike-path classes cost a bike nothing extra.

Lahntal (2026-11-22): the hint ran along the Lahn and the railway; the route took the B 3 and the B 62 100-250 m beside it, because inside the corridor
every road was free (Sterzhausen: 0.1 nats between the two) and the local pass charged the bike's paths up to 30 nats/km more than the trunk road."""
import json

import numpy as np
import pytest

from rsm.hmm import grid
from rsm.pipeline import config as C, hints as HI, local as L
from tests.test_hmm import city


@pytest.fixture(autouse=True)
def _off():
    HI.activate_cost(None)
    yield
    HI.activate_cost(None)


# ------------------------------------------------------------------ the cost curve
@pytest.mark.parametrize("d, nats_per_km", [(0.0, 0.0), (C.HINT_COST_FREE_M, 0.0), (C.HINT_COST_FREE_M + 10.0, 10.0 * C.HINT_COST_NATS_PER_KM_PER_M),
                                            (100.0, (100.0 - C.HINT_COST_FREE_M) * C.HINT_COST_NATS_PER_KM_PER_M), (5000.0, C.HINT_COST_MAX_NATS_PER_KM)])
def test_the_distance_to_the_hint_costs_beyond_the_free_band_up_to_a_cap(d, nats_per_km):
    assert HI.cost_per_m(np.array([d]))[0] * 1000.0 == pytest.approx(nats_per_km)


def test_the_cost_is_zero_on_the_hint_and_grows_with_the_distance():
    g = city()
    HI.activate_cost([np.array([[0.0, 0.0], [0.0, 720.0]])], g.crs)          # the hint rides the street x = 0
    c = HI.cell_cost(g, np.array([[0.0, 100.0], [240.0, 100.0], [480.0, 100.0]]))
    assert c[0] == 0.0
    assert c[1:] == pytest.approx(HI.cost_per_m(np.array([240.0, 480.0])))


# ------------------------------------------------------------------ in the grid
def _weights(G):
    return {int(k.k): (k.src.copy(), k.dst.copy(), k.w.copy()) for k in G.groups}


def test_without_a_hint_the_grid_is_unchanged():
    g = city()
    a = grid.build(g, h=30.0)
    HI.activate_cost(None)
    b = grid.build(g, h=30.0)
    for k in _weights(a):
        for x, y in zip(_weights(a)[k], _weights(b)[k]):
            assert np.array_equal(x, y)


def test_with_a_hint_moving_away_from_it_costs_and_moving_along_it_does_not():
    g = city()
    plain = grid.build(g, h=30.0)
    HI.activate_cost([np.array([[0.0, 0.0], [0.0, 720.0]])], g.crs)
    G = grid.build(g, h=30.0)
    gr, gp = G.groups[1], plain.groups[1]                                   # one cell per step
    assert np.array_equal(gr.src, gp.src) and np.array_equal(gr.dst, gp.dst)
    dst_x = G.xy[gr.dst, 0]
    on, off = np.abs(dst_x) < 1.0, dst_x > 200.0
    assert np.allclose(gr.w[on], gp.w[on])
    assert np.all(gr.w[off] < gp.w[off] - 1e-3)


def test_the_hint_cost_adds_to_the_road_class_cost():
    g = city()
    ec = np.full(g.n_edges, 0.01)
    plain = grid.build(g, h=30.0, edge_cost=ec)
    HI.activate_cost([np.array([[0.0, 0.0], [0.0, 720.0]])], g.crs)
    G = grid.build(g, h=30.0, edge_cost=ec)
    off = G.xy[G.groups[1].dst, 0] > 200.0
    assert np.all(G.groups[1].w[off] < plain.groups[1].w[off] - 1e-3)


def test_a_graph_in_another_crs_gets_no_hint_cost():
    g = city()
    plain = grid.build(g, h=30.0)
    HI.activate_cost([np.array([[0.0, 0.0], [0.0, 720.0]])], "EPSG:32631" if g.crs != "EPSG:32631" else "EPSG:32633")
    G = grid.build(g, h=30.0)
    assert np.array_equal(G.groups[1].w, plain.groups[1].w)


def test_a_run_with_a_hint_file_activates_the_cost(tmp_path):
    f = tmp_path / "h.gpx"
    f.write_text('<gpx><trk><trkseg><trkpt lat="50.80" lon="8.77"/><trkpt lat="50.81" lon="8.77"/></trkseg></trk></gpx>')
    HI.start_cost(dict(hint=str(f)), "EPSG:32632")
    assert HI.cost_key() != ""
    HI.start_cost(dict(), "EPSG:32632")
    assert HI.cost_key() == ""


# ------------------------------------------------------------------ the bike-path classes cost a bike nothing extra
class _G:
    def __init__(self, hw):
        self.edge_highway = np.array(hw)


@pytest.mark.parametrize("hw", list(C.BIKE_PATH_CLASSES))
def test_a_bike_path_class_costs_a_bike_nothing(hw):
    assert L.class_cost(_G([hw, "residential", "primary"]), np.arange(3), "bike", ext=True).tolist() == [0.0, 0.0, 0.0]


def test_a_bike_path_class_still_costs_a_car():
    c = L.class_cost(_G(["path", "residential", "primary"]), np.arange(3), "car", ext=True)
    assert c[0] > 0 and c[1] > 0 and c[2] == 0.0


def test_the_local_pass_and_the_islands_use_the_same_class_cost():
    g = _G(["path", "cycleway", "residential", "steps"])
    m = L.minor_cost(g, np.arange(4), "bike")
    assert m.tolist() == L.class_cost(g, np.arange(4), "bike", ext=False).tolist()
    assert m[0] == m[1] == 0.0


# ------------------------------------------------------------------ the step keys
def test_the_hint_cost_is_in_the_keys_of_a_run_with_a_hint_only(tmp_path, monkeypatch):
    from tests.test_horizon_by_vehicle import _run
    run, base = _run(tmp_path)
    hint = tmp_path / "h.gpx"
    hint.write_text("<gpx/>")
    with_hint = dict(base, hint=str(hint), hint_hash="x", hint_buffer_m=300.0)
    h0, hh = run.hashes(base), run.hashes(with_hint)
    monkeypatch.setattr(C, "HINT_COST_NATS_PER_KM_PER_M", C.HINT_COST_NATS_PER_KM_PER_M * 2)
    assert run.hashes(base) == h0
    h2 = run.hashes(with_hint)
    assert h2["route_search"] != hh["route_search"] and h2["refine"] != hh["refine"] and h2["map"] == hh["map"]
