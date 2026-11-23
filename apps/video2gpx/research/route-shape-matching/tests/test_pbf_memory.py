# SPDX-License-Identifier: AGPL-3.0-or-later
"""Parity and low-memory behaviour tests for the streaming C PBF node scanner in rsm.pipeline.osm."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import osmium
import pytest

from rsm.pipeline import _pbf_native as PN, config as C, osm


def _write_synthetic_pbf(path: Path) -> None:
    """Create a real .osm.pbf containing:
    - road ways inside box A, box B, both boxes, and outside all boxes
    - a boundary-crossing way with one node inside box A and another > 0.2 deg outside (exercises Pass 3 fallback lookup)
    - non-highway ways (building/forest) with many extra nodes that must be ignored
    - filtered-out ways (area=yes, access=private, excluded highway class)
    """
    w = osmium.SimpleWriter(str(path))
    # Box A: south=47.40, west=11.10, north=47.50, east=11.20
    # Box B: south=47.45, west=11.15, north=47.55, east=11.25
    nodes = [
        # Road 1 inside box A
        (1, 11.12, 47.42),
        (2, 11.14, 47.44),
        (3, 11.16, 47.46),   # in both A and B
        # Road 2 inside box B
        (4, 11.22, 47.52),
        # Road 3 starts in A, extends into pad margin (within 0.05 deg)
        (5, 11.11, 47.41),
        (6, 11.07, 47.38),
        # Road 4 starts in A, extends FAR outside pad margin (> 0.2 deg away) -> tests Pass 3 lookup_nodes_by_ids
        (7, 11.12, 47.43),
        (8, 10.80, 47.10),
        # Road 5 completely outside A and B (negative coordinates test too? keep near Europe for UTM)
        (9, 12.00, 48.00),
        (10, 12.02, 48.02),
        # Building nodes inside A (should never enter extracted road nodes)
        (100, 11.13, 47.43),
        (101, 11.131, 47.43),
        (102, 11.131, 47.431),
        (103, 11.13, 47.431),
        # Filtered road nodes (area=yes, access=private, motorway when bike)
        (200, 11.125, 47.425),
        (201, 11.126, 47.426),
        (202, 11.127, 47.427),
        (203, 11.128, 47.428),
    ]
    for nid, lon, lat in nodes:
        w.add_node(osmium.osm.mutable.Node(id=nid, location=(lon, lat)))

    ways = [
        (10, [1, 2, 3], {"highway": "tertiary", "name": "Passstrasse", "oneway": "no"}),
        (11, [3, 4], {"highway": "secondary", "name": "Talweg", "oneway": "yes", "lanes": "2"}),
        (12, [5, 6], {"highway": "residential", "name": "Randweg"}),
        (13, [7, 8], {"highway": "primary", "ref": "B2"}),
        (14, [9, 10], {"highway": "secondary", "name": "FarAway"}),
        # Building (not highway)
        (20, [100, 101, 102, 103, 100], {"building": "yes"}),
        # Excluded highways
        (21, [200, 201], {"highway": "tertiary", "area": "yes"}),
        (22, [201, 202], {"highway": "tertiary", "access": "private"}),
        (23, [202, 203], {"highway": "motorway", "name": "A95"}),
    ]
    for wid, refs, tags in ways:
        w.add_way(osmium.osm.mutable.Way(id=wid, nodes=refs, tags=tags))
    w.close()


@pytest.mark.skipif(not PN.available(), reason="native PBF library not compiled for this platform")
def test_native_pbf_extract_matches_pyosmium_reference(tmp_path):
    pbf = tmp_path / "synth.osm.pbf"
    _write_synthetic_pbf(pbf)
    boxes = {
        "a": dict(south=47.40, west=11.10, north=47.50, east=11.20),
        "b": dict(south=47.45, west=11.15, north=47.55, east=11.25),
        "empty": dict(south=46.00, west=10.00, north=46.10, east=10.10),
    }
    prog_nat: list[float] = []
    ex_nat = osm.extract(pbf, C.CLASSES_BIKE, boxes, progress=prog_nat.append)

    saved = PN.LIB
    PN.LIB = None
    try:
        ex_ref = osm.extract(pbf, C.CLASSES_BIKE, boxes)
    finally:
        PN.LIB = saved

    assert prog_nat and prog_nat[-1] == 1.0
    assert set(ex_nat.keys()) == set(ex_ref.keys())
    for k in boxes:
        w_nat, n_nat = ex_nat[k]
        w_ref, n_ref = ex_ref[k]
        assert w_nat == w_ref, f"ways mismatch in box {k}"
        assert set(n_nat.keys()) == set(n_ref.keys()), f"node keys mismatch in box {k}"
        for nid in n_ref:
            assert abs(n_nat[nid][0] - n_ref[nid][0]) < 1e-7
            assert abs(n_nat[nid][1] - n_ref[nid][1]) < 1e-7

    # Verify boundary-crossing way 13 (node 8 far outside 0.05 deg pad) was extracted with full geometry
    assert any(wid == 13 for wid, _, _ in ex_nat["a"][0])
    assert 8 in ex_nat["a"][1]
    # Verify building nodes (100..103) were ignored
    assert not ({100, 101, 102, 103} & set(ex_nat["a"][1].keys()))
    # Verify empty box has no ways or nodes
    assert ex_nat["empty"] == ([], {})

    # Verify build_graph + edges_in_bbox produce identical graphs
    g_nat = osm.build_graph(*ex_nat["a"])
    g_ref = osm.build_graph(*ex_ref["a"])
    assert g_nat.n_nodes == g_ref.n_nodes and g_nat.n_edges == g_ref.n_edges
    assert np.array_equal(osm.edges_in_bbox(g_nat, boxes["a"]), osm.edges_in_bbox(g_ref, boxes["a"]))


@pytest.mark.skipif(not PN.available(), reason="native PBF library not compiled for this platform")
def test_native_pbf_density_matches_pyosmium_reference(tmp_path):
    pbf = tmp_path / "synth.osm.pbf"
    _write_synthetic_pbf(pbf)
    c_nat = tmp_path / "c_nat"
    c_ref = tmp_path / "c_ref"
    c_nat.mkdir()
    c_ref.mkdir()

    d_nat = osm.density(pbf, C.CLASSES_BIKE, c_nat)

    saved = PN.LIB
    PN.LIB = None
    try:
        d_ref = osm.density(pbf, C.CLASSES_BIKE, c_ref)
    finally:
        PN.LIB = saved

    assert d_nat["lat0"] == d_ref["lat0"]
    assert d_nat["lon0"] == d_ref["lon0"]
    assert d_nat["km"].shape == d_ref["km"].shape
    assert np.allclose(d_nat["km"], d_ref["km"], atol=1e-6)


@pytest.mark.skipif(not PN.available(), reason="native PBF library not compiled for this platform")
def test_native_pbf_custom_way_filter_matches_reference(tmp_path):
    pbf = tmp_path / "synth.osm.pbf"
    _write_synthetic_pbf(pbf)
    boxes = {"a": dict(south=47.40, west=11.10, north=47.50, east=11.20)}
    allow_all = lambda _t: True

    ex_nat = osm.extract(pbf, C.CLASSES_BIKE, boxes, way_filter=allow_all)
    saved = PN.LIB
    PN.LIB = None
    try:
        ex_ref = osm.extract(pbf, C.CLASSES_BIKE, boxes, way_filter=allow_all)
    finally:
        PN.LIB = saved

    assert ex_nat["a"][0] == ex_ref["a"][0]
    assert any(wid == 22 for wid, _, _ in ex_nat["a"][0])   # access=private included by allow_all
