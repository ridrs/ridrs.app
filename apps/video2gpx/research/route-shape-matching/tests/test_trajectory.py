# SPDX-License-Identifier: AGPL-3.0-or-later
import dataclasses
import math
import subprocess
import sys

import numpy as np
import pytest
import shapely

from rsm.core.trajectory import RelativeTrajectory, ScalePrior
import synthetic as syn


def hausdorff(a: RelativeTrajectory, b: RelativeTrajectory) -> float:
    la, lb = shapely.LineString(a.points), shapely.LineString(b.points)
    return shapely.hausdorff_distance(la, lb, densify=0.02)


# -- validation ------------------------------------------------------------------------------

@pytest.mark.parametrize("pts, msg", [
    ([[0, 0]], "at least 2"),
    ([[0, 0], [0, 0], [0, 0]], "identical"),
    ([[0, 0], [np.nan, 1]], "NaN"),
    ([[0, 0], [np.inf, 1]], "NaN or infinite"),
    ([[0, 0, 1], [1, 1, 1]], "shape"),
    ([0, 1, 2], "shape"),
])
def test_invalid_points(pts, msg):
    with pytest.raises(ValueError, match=msg):
        RelativeTrajectory(np.array(pts, dtype=float))


P2 = np.array([[0.0, 0.0], [1.0, 0.0], [2.0, 1.0]])


@pytest.mark.parametrize("kw, msg", [
    ({"t": [0, 2, 1]}, "non-decreasing"),
    ({"t": [0, 1]}, "shape"),
    ({"z": [0, 1, np.nan]}, "NaN"),
    ({"uncertainty": [0, -1, 0]}, "non-negative"),
    ({"uncertainty": [0, 1]}, "shape"),
    ({"junctions": (500.0,)}, "junction"),
    ({"junctions": (-1.0,)}, "junction"),
    ({"junctions": (float("nan"),)}, "junction"),
])
def test_invalid_fields(kw, msg):
    with pytest.raises(ValueError, match=msg):
        RelativeTrajectory(P2, **kw)


def test_scale_prior_validation():
    with pytest.raises(ValueError):
        ScalePrior(min=1.4, max=0.7)
    with pytest.raises(ValueError):
        ScalePrior(min=-1.0)
    with pytest.raises(ValueError):
        ScalePrior(known="yes")


def test_immutable_and_copied():
    raw = P2.copy()
    tr = RelativeTrajectory(raw, metadata={"a": {"b": 1}})
    raw[0, 0] = 99
    assert tr.points[0, 0] == 0.0
    with pytest.raises(dataclasses.FrozenInstanceError):
        tr.points = P2
    with pytest.raises(ValueError):
        tr.points[0, 0] = 5.0


def test_cumulative_distance_is_derived():
    tr = RelativeTrajectory(P2)
    assert np.allclose(tr.cumulative_distance, [0, 1, 1 + math.sqrt(2)])
    assert not any(f.name == "cumulative_distance" for f in dataclasses.fields(tr))


def test_core_imports_no_io_libs():
    code = ("import sys, rsm.core.trajectory; "
            "bad = [m for m in ('osmnx', 'gpxpy', 'pyproj', 'networkx', 'geopandas') if m in sys.modules]; "
            "sys.exit(1 if bad else 0)")
    assert subprocess.run([sys.executable, "-c", code]).returncode == 0


# -- length ----------------------------------------------------------------------------------

def test_length_line_arc_circle():
    assert syn.line(100.0).length == pytest.approx(100.0, abs=1e-9)
    assert syn.arc(40.0, math.pi / 2).length == pytest.approx(40.0 * math.pi / 2, rel=1e-4)
    assert syn.circle(30.0).length == pytest.approx(2 * math.pi * 30.0, rel=1e-4)
    assert syn.hairpin(30.0).length == pytest.approx(30.0, rel=1e-4)


# -- resampling ------------------------------------------------------------------------------

# name -> (factory, minimum radius of curvature in metres)
CURVES = {
    "line": (lambda: syn.line(100.0, n=17), math.inf),
    "arc": (lambda: syn.arc(40.0, 2 * math.pi / 3), 40.0),
    "s_curve": (lambda: syn.s_curve(), 40.0),
    "hairpin": (lambda: syn.hairpin(30.0), 30.0 / math.pi),
    "irregular": (lambda: syn.irregular(), 80.0),
}


@pytest.mark.parametrize("name", CURVES)
@pytest.mark.parametrize("step", [0.5, 1.0, 2.0])
def test_resample_by_distance_invariance(name, step):
    make, radius = CURVES[name]
    tr = make()
    r = tr.resample_by_distance(step)
    gap = np.diff(tr.cumulative_distance).max()  # the input polyline is itself a chord approximation
    # a chord of a circle of radius R is shorter by a relative theta^2/24, theta = step/R, and lies
    # at most the sagitta step^2/(8R) inside the curve (likewise for the input's own gaps)
    assert r.length == pytest.approx(tr.length, rel=4 * (step**2 + gap**2) / radius**2 / 24 + 2e-4)
    assert r.length <= tr.length + 1e-9
    assert hausdorff(tr, r) < 1.2 * (step**2 + gap**2) / (8 * radius) + 1e-3
    assert np.array_equal(r.points[0], tr.points[0]) and np.array_equal(r.points[-1], tr.points[-1])
    d = np.diff(r.cumulative_distance)
    assert np.allclose(d[:-1], step, rtol=4 * (step**2 + gap**2) / radius**2 / 24 + 1e-6)  # chords, not arcs
    assert d.max() <= 1.25 * step + 1e-6 and d.min() >= 0.25 * step - 1e-6


def test_resample_uniform_spacing_exact_on_line():
    r = syn.line(10.0, n=3).resample_by_distance(1.0)
    assert len(r) == 11
    assert np.allclose(np.diff(r.cumulative_distance), 1.0)


def test_resample_remainder_rule():
    # length 10.1, step 1: remainder 0.1 < 0.25 -> last regular sample (10.0) dropped
    r = syn.line(10.1, n=3).resample_by_distance(1.0)
    assert len(r) == 11 and np.isclose(r.length, 10.1)
    assert np.isclose(np.diff(r.cumulative_distance)[-1], 1.1)


def test_resample_n():
    tr = syn.irregular()
    for n in (2, 3, 50, 333):
        r = tr.resample_n(n)
        assert len(r) == n
        assert np.array_equal(r.points[0], tr.points[0]) and np.array_equal(r.points[-1], tr.points[-1])
    r = syn.line(10, n=5).resample_n(11)
    assert np.allclose(np.diff(r.cumulative_distance), 1.0)
    with pytest.raises(ValueError):
        tr.resample_n(1)
    with pytest.raises(ValueError):
        tr.resample_by_distance(0.0)


def test_resample_interpolates_all_channels():
    s = np.array([0.0, 1.0, 3.0, 4.0])
    tr = RelativeTrajectory(np.column_stack([s, 0 * s]), z=2 * s, t=10 + s, uncertainty=0.1 + s / 10, junctions=(2.0,),
                            scale=ScalePrior(True, 0.9, 1.1), direction_known=False, metadata={"k": "v"})
    r = tr.resample_by_distance(0.5)
    x = r.points[:, 0]
    assert np.allclose(r.z, 2 * x) and np.allclose(r.t, 10 + x) and np.allclose(r.uncertainty, 0.1 + x / 10)
    assert r.junctions == (2.0,) and r.scale == tr.scale and r.direction_known is False and r.metadata == {"k": "v"}


def test_resample_handles_zero_length_steps():
    tr = RelativeTrajectory(np.array([[0, 0], [0, 0], [1, 0], [1, 0], [2, 0]], float))
    r = tr.resample_by_distance(0.5)
    assert r.length == pytest.approx(2.0) and np.all(np.diff(r.cumulative_distance) > 0)


def test_very_short_trajectory():
    tr = RelativeTrajectory(np.array([[0.0, 0.0], [0.3, 0.4]]), t=[0.0, 1.0])
    assert tr.length == pytest.approx(0.5)
    r = tr.resample_by_distance(0.1)
    assert r.length == pytest.approx(0.5) and len(r) >= 5
    assert tr.resample_n(4).t[-1] == 1.0
    n, tf = tr.normalized(heading_window_m=5.0)
    assert np.allclose(n.points[1] / np.hypot(*n.points[1]), [0, 1])
    assert tr.total_turn(0.1) == pytest.approx(0.0, abs=1e-12)
    s = tr.smooth(0.05)
    assert s.length == pytest.approx(0.5, rel=1e-6)


def test_degenerate_all_identical():
    with pytest.raises(ValueError, match="identical"):
        RelativeTrajectory(np.zeros((10, 2)))


# -- dedup -----------------------------------------------------------------------------------

def test_dedup_exact_and_near_duplicates():
    pts = np.array([[0, 0], [0, 0], [0.001, 0], [1, 0], [1, 0], [1.0005, 0], [2, 0], [2, 0]], float)
    tr = RelativeTrajectory(pts, t=np.arange(8.0))
    d = tr.dedup(0.01)
    assert np.allclose(d.points, [[0, 0], [1, 0], [2, 0]])
    assert d.t.tolist() == [0.0, 3.0, 7.0]  # last point kept (replaced the near-duplicate (2,0) at index 6)
    assert np.array_equal(d.points[0], tr.points[0]) and np.array_equal(d.points[-1], tr.points[-1])
    assert d.length == pytest.approx(2.0)


def test_dedup_exact_only_with_zero_step():
    tr = RelativeTrajectory(np.array([[0, 0], [0, 0], [1, 0], [1, 0]], float))
    assert np.allclose(tr.dedup(0.0).points, [[0, 0], [1, 0]])


def test_dedup_keeps_distinct_points_and_last():
    tr = syn.line(10.0, n=11)
    assert len(tr.dedup(0.5)) == 11
    # last point 0.2 m after the previous kept one: it replaces it, nothing is appended
    pts = np.array([[0, 0], [1, 0], [2, 0], [2.2, 0]], float)
    d = RelativeTrajectory(pts).dedup(0.5)
    assert np.allclose(d.points, [[0, 0], [1, 0], [2.2, 0]])


def test_dedup_all_close_raises_or_keeps_ends():
    tr = RelativeTrajectory(np.array([[0, 0], [0.1, 0], [0.2, 0]], float))
    assert np.allclose(tr.dedup(5.0).points, [[0, 0], [0.2, 0]])
    with pytest.raises(ValueError, match="identical"):
        RelativeTrajectory(np.array([[0, 0], [1, 1], [0, 0]], float)).dedup(5.0)


# -- smoothing -------------------------------------------------------------------------------

def test_smooth_straight_line_unchanged_including_ends():
    tr = syn.line(50.0, n=101, angle=0.4)
    s = tr.smooth(3.0)
    assert np.allclose(s.points[0], tr.points[0], atol=1e-9) and np.allclose(s.points[-1], tr.points[-1], atol=1e-9)
    assert hausdorff(tr, s) < 1e-9
    assert s.length == pytest.approx(50.0, rel=1e-9)


def test_smooth_reduces_noise():
    clean = syn.arc(60.0, math.pi / 2, n=2000)
    clean = clean.resample_by_distance(0.5)
    noisy = syn.noisy(clean, sigma=0.3)
    center = np.array([-60.0, 0.0])

    def rms(t):
        return float(np.sqrt(np.mean((np.hypot(*(t.points - center).T) - 60.0) ** 2)))

    before, after = rms(noisy), rms(noisy.smooth(3.0))
    assert before == pytest.approx(0.3, rel=0.15)
    assert after < 0.5 * before
    assert noisy.smooth(3.0).length < noisy.length  # noise inflates the raw length


def test_smooth_shrinkage_on_arc_is_bounded():
    R, sigma = 40.0, 4.0
    tr = syn.arc(R, math.pi, n=1500)
    s = tr.smooth(sigma)
    center = np.array([-R, 0.0])
    r = np.hypot(*(s.points - center).T)
    interior = (s.cumulative_distance > 3 * sigma) & (s.cumulative_distance < s.length - 3 * sigma)
    predicted = math.exp(-sigma**2 / (2 * R**2))
    ratio = r[interior].mean() / R
    assert ratio == pytest.approx(predicted, abs=1e-3)
    assert 0.99 < ratio < 1.0
    # the end points are pinned exactly, and even near the ends the radius error stays below 3 %
    assert np.allclose(s.points[0], tr.points[0], atol=1e-9) and np.allclose(s.points[-1], tr.points[-1], atol=1e-9)
    assert np.abs(r / R - 1).max() < 0.03
    assert s.length == pytest.approx(tr.length * predicted, rel=0.02)


def test_smooth_hairpin_shrinks_more():
    # sigma comparable to the radius (9.5 m): documented strong shrinkage, still bounded by the formula
    tr = syn.hairpin(30.0, n=1500)
    s = tr.smooth(4.0)
    assert 0.80 < s.length / tr.length < 0.99


# -- normalisation ---------------------------------------------------------------------------

def make_full():
    base = syn.s_curve(radius=30.0)
    n = len(base)
    rng = np.random.default_rng(3)
    c, s = math.cos(1.0), math.sin(1.0)
    pts = base.points @ np.array([[c, -s], [s, c]]).T + [120.0, -75.0]
    return RelativeTrajectory(pts, z=rng.normal(size=n), t=np.sort(rng.uniform(0, 50, n)), uncertainty=rng.uniform(0, 1, n),
                              junctions=(10.0, 40.0), metadata={"a": 1})


@pytest.mark.parametrize("unit", [False, True])
def test_normalized_invertible(unit):
    tr = make_full()
    n, tf = tr.normalized(unit_length=unit)
    assert np.allclose(n.points[0], 0.0)
    if unit:
        assert n.length == pytest.approx(1.0, rel=1e-12)
    back = tf.invert_trajectory(n)
    assert np.allclose(back.points, tr.points, atol=1e-9)
    assert np.allclose(back.z, tr.z, atol=1e-12) and np.array_equal(back.t, tr.t)
    assert np.allclose(back.uncertainty, tr.uncertainty, atol=1e-12)
    assert np.allclose(back.junctions, tr.junctions)
    assert np.allclose(tf.invert(tf.apply(tr.points)), tr.points, atol=1e-9)


def test_normalized_initial_heading_is_plus_y():
    tr = make_full()
    n, _ = tr.normalized(heading_window_m=5.0)
    q = n.point_at(5.0)
    assert q[0] == pytest.approx(0.0, abs=1e-9) and q[1] > 0
    # the total turn is a rotation invariant
    assert n.total_turn(0.5) == pytest.approx(tr.total_turn(0.5), abs=1e-9)


def test_normalized_uses_window_not_first_segment():
    # straight road at 30 degrees, but the first segment is a 0.3 m jitter pointing elsewhere
    a = np.radians(30)
    pts = [[0.0, 0.0], [0.3 * math.cos(1.5), 0.3 * math.sin(1.5)]] + [[s * math.cos(a), s * math.sin(a)] for s in np.arange(1.0, 30.0, 1.0)]
    tr = RelativeTrajectory(np.array(pts))
    n, tf = tr.normalized(heading_window_m=10.0)
    assert tf.angle == pytest.approx(math.pi / 2 - a, abs=0.05)  # first-segment heading would be off by ~50 degrees


def test_normalized_loop_in_window_raises():
    with pytest.raises(ValueError, match="initial heading undefined"):
        syn.circle(1.0).normalized(heading_window_m=2 * math.pi * 1.0)


# -- heading and turning angle (left positive) -----------------------------------------------

def test_turning_angle_analytic_and_sign():
    for tr, expected in [
        (syn.line(100.0), 0.0),
        (syn.arc(40.0, math.pi / 2, left=True), math.pi / 2),
        (syn.arc(40.0, math.pi / 2, left=False), -math.pi / 2),
        (syn.hairpin(30.0, left=True), math.pi),
        (syn.hairpin(30.0, left=False), -math.pi),
        (syn.circle(30.0), 2 * math.pi),
        (syn.s_curve(), 0.0),
    ]:
        assert tr.total_turn(step=0.5) == pytest.approx(expected, abs=0.01), expected


def test_turning_angle_profile_and_mirror():
    tr = syn.s_curve(radius=40.0, quarter=math.pi / 3)
    s, turn = tr.turning_angle(step=0.5)
    assert turn[0] == 0.0 and turn.max() == pytest.approx(math.pi / 3, abs=0.01) and turn.min() > -0.01
    s2, turn_m = tr.mirrored().turning_angle(step=0.5)
    assert np.allclose(turn_m, -turn, atol=1e-9) and np.allclose(s, s2)
    h = tr.heading(0.5)[1]
    assert h[0] == pytest.approx(math.pi / 2, abs=0.01)


def test_loop_unwrapped_monotonic():
    s, turn = syn.circle(30.0).turning_angle(1.0)
    assert np.all(np.diff(turn) > 0) and turn[-1] == pytest.approx(2 * math.pi, abs=0.01)


def test_operations_are_deterministic_and_pure():
    tr = make_full()
    pts = tr.points.copy()
    a = tr.smooth(2.0).resample_n(77)
    b = tr.smooth(2.0).resample_n(77)
    assert a.equals(b)
    assert np.array_equal(tr.points, pts)
