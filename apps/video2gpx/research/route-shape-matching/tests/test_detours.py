# SPDX-License-Identifier: AGPL-3.0-or-later
"""Skipped spans (rsm.pipeline.detours): detours out and back to the same junction, inserted shots between cuts; both held at 0 km/h."""
import numpy as np
from scipy.ndimage import gaussian_filter

from rsm.pipeline import cuts as K, detours as DT, steps_d
from tests.test_track2 import make_graph


def spur():
    """main road west -> junction J (0, 0) -> east, and a dead-end spur 100 m north of J.
    make_graph: line i gives edge 2i (as drawn) and 2i + 1 (reversed)"""
    return make_graph([[(-500, 0), (0, 0)], [(0, 0), (500, 0)], [(0, 0), (0, 100)]])


IN, OUT, SPUR, BACK = 0, 2, 4, 5


def ride(occ, g, v=10.0):
    L = np.asarray(g.edge_len)[occ]
    start = np.r_[0.0, np.cumsum(L)]
    t = np.arange(0.0, start[-1] / v + 1.0, 0.2)
    return start, t, np.minimum(v * t, start[-1])


def odo(turns, t_end=200.0):
    """odometry steps every second; turns: {time: degrees}"""
    st_t = np.arange(0.0, t_end, 1.0)
    dth = np.zeros(len(st_t))
    for tt, deg in turns.items():
        dth[int(tt)] = np.radians(deg)
    return st_t, dth


def test_a_spur_out_and_back_with_a_u_turn_in_the_video_is_a_detour():
    g = spur()
    occ = np.array([IN, SPUR, BACK, OUT])
    start, t, s = ride(occ, g)
    st_t, dth = odo({50: 90, 55: 180, 60: 90})               # left into the spur, turn round, left out onto the main road
    det = DT.find(g.edge_u, g.edge_v, occ, start, t, s, st_t, dth)
    assert len(det) == 1
    x = det[0]
    assert abs(x["t0"] - 50.0) < 0.3 and abs(x["t1"] - 70.0) < 0.3
    assert x["s0"] == 500.0 and x["s1"] == 700.0 and x["length_m"] == 200.0 and x["odo_turn_deg"] >= 270


def test_a_decoder_wiggle_without_a_turn_in_the_video_stays():
    g = spur()
    occ = np.array([IN, SPUR, BACK, OUT])
    start, t, s = ride(occ, g)
    st_t, dth = odo({52: 20, 58: -25})                       # the video drives straight on: the path's spur is the decoder's
    assert DT.find(g.edge_u, g.edge_v, occ, start, t, s, st_t, dth) == []


def test_a_turnaround_is_part_of_the_route():
    g = spur()
    occ = np.array([IN, SPUR, BACK, IN + 1])                 # into the spur and back, then back west the way it came
    start, t, s = ride(occ, g)
    st_t, dth = odo({50: 90, 55: 180})
    assert DT.find(g.edge_u, g.edge_v, occ, start, t, s, st_t, dth) == []


def test_limits_of_time_and_length():
    g = spur()
    occ = np.array([IN, SPUR, BACK, OUT])
    start, t, s = ride(occ, g, v=0.5)                        # 400 s for the spur: longer than "a few minutes"
    st_t, dth = odo({1000: 90, 1100: 180, 1200: 90}, t_end=3000)
    assert DT.find(g.edge_u, g.edge_v, occ, start, t, s, st_t, dth) == []
    start, t, s = ride(occ, g)
    st_t, dth = odo({50: 90, 55: 180, 60: 90})
    assert DT.find(g.edge_u, g.edge_v, occ, start, t, s, st_t, dth, min_m=250.0) == []


def test_a_short_excursion_inside_a_longer_one_is_part_of_it():
    g = make_graph([[(-500, 0), (0, 0)], [(0, 0), (500, 0)], [(0, 0), (0, 100)], [(0, 100), (0, 200)], [(0, 100), (60, 100)]])
    # J -> K (0, 100) -> east stub and back to K -> north to the end and back to K -> back to J -> east
    occ = np.array([0, 4, 8, 9, 6, 7, 5, 2])
    start, t, s = ride(occ, g)
    st_t, dth = odo({50: 90, 58: 180, 66: 180, 80: 90}, t_end=300)
    det = DT.find(g.edge_u, g.edge_v, occ, start, t, s, st_t, dth)
    assert len(det) == 1 and det[0]["s0"] == 500.0 and det[0]["length_m"] == 520.0


def test_excise_and_remap_cut_the_detour_out_of_the_path():
    sg = np.arange(0.0, 1200.0)
    xy = np.c_[sg, np.zeros(len(sg))]
    new, per_m, shifts = DT.excise(sg, dict(xy=xy, flag=np.arange(len(sg))), [(500.0, 700.0)])
    assert len(new) == 1000 and np.allclose(np.diff(new), 1.0) and shifts == [200.0]
    assert per_m["flag"][499] == 499 and per_m["flag"][500] == 700
    r = DT.remap(np.array([100.0, 500.0, 650.0, 700.0, 800.0]), [(500.0, 700.0)], shifts)
    assert np.allclose(r, [100.0, 500.0, 500.0, 500.0, 600.0])
    # two spans: the second moves back by both
    new, _, shifts = DT.excise(sg, {}, [(100.0, 200.0), (500.0, 700.0)])
    assert len(new) == 900 and np.allclose(np.diff(new), 1.0)
    assert np.allclose(DT.remap(np.array([150.0, 300.0, 600.0, 900.0]), [(100.0, 200.0), (500.0, 700.0)], shifts), [100.0, 200.0, 400.0, 600.0])


def test_merge_spans_keeps_the_kind_of_the_longest_part():
    sp, k = DT.merge_spans([(10.0, 20.0), (50.0, 60.0), (15.0, 40.0)], [0, 2, 1])
    assert sp == [(10.0, 40.0), (50.0, 60.0)] and k == [1, 2]


def _track(t0, t1, v=6.0):
    t = np.arange(t0, t1, 4.0 / v)
    return dict(t=t, s=(t - t0) * v, th=np.zeros(len(t)))


def test_plan_takes_resumed_pieces_as_inserted_shots():
    tr = [_track(130, 300), _track(301, 360), _track(361, 600)]
    cuts = [dict(t=x) for x in (300.5, 360.5)]
    out, info = K.plan(tr, cuts, resumed=[(300.5, 360.5)])
    assert info["inserted"] == [dict(t0=300.5, t1=360.5, kind="resumed")]
    assert [float(x["t"][0]) for x in out] == [130.0, 361.0]
    out, info = K.plan(tr, cuts)
    assert info["inserted"] == [] and len(out) == 3


def _texture(seed, h=270, w=480):
    rng = np.random.default_rng(seed)
    x = gaussian_filter(rng.normal(0, 1, (h, w)), 2.0)
    return np.clip(128 + 45 * x / x.std(), 0, 255).astype(np.uint8)


def test_resume_check_looks_above_the_bonnet():
    hood = _texture(9)[:110]
    a, b = _texture(1), _texture(2)
    a[-110:], b[-110:] = hood, hood                          # the same camera: the bonnet in the lower part of every frame
    assert K.same_scene(a, b)["share"] > 0.3                 # the whole frame: the bonnet alone makes two drives look alike
    assert K.same_scene(a, b, top=0.6)["share"] < 0.2        # above it: two different scenes
    c = np.roll(a, 2, axis=1)                                # the drive goes on where it was: the same scene
    assert K.same_scene(a, c, top=0.6)["share"] >= 0.5         # (PANO_SAME_SHARE 0.3)


def test_route_points_carry_the_kind_of_a_skipped_span():
    class R(dict):
        files = property(lambda self: list(self.keys()))
    r = R(in_still=np.zeros(3, bool), still_t0=np.array([1.0, 5.0]), still_t1=np.array([2.0, 9.0]), still_s0=np.array([10.0, 50.0]), still_s1=np.array([10.0, 50.0]),
          still_sd=np.array([1.0, 1.0]), still_conf=np.array([0.9, 0.9]), still_kind=np.array([0, 2], np.int8))
    _, st = steps_d.still_state(r, 3)
    assert [x[6] for x in st] == [0, 2]
    del r["still_kind"]
    _, st = steps_d.still_state(r, 3)
    assert [x[6] for x in st] == [0, 0]
