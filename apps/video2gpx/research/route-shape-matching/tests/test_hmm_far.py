"""rsm.hmm_far: far-yaw f axis, grid swap, route difference."""
import numpy as np

from rsm.hmm.route import Route
from rsm.hmm_cal import run as crun
from rsm.hmm_far import report, run
from tests.test_hmm import city


def test_f_axis_contains_the_far_scale_and_the_grid_swap_is_restored():
    f = np.array(run.F_GRID)
    assert len(f) == 8 and np.all(np.diff(np.log(f)) > 0) and f[0] == 250.0 and abs(f[-1] - 440.0) < 1e-6
    assert f[0] < 345 < f[-1] and f[0] < 365 < f[-1]
    old = crun.F_GRID
    with run.use_grid((1.0, 2.0)):
        assert crun.F_GRID == (1.0, 2.0)
    assert crun.F_GRID == old


def _route(g, edges, shift=0.0):
    xy = np.array([g.geom(e)[0] + [shift, 0.0] for e in edges], float)
    t = np.arange(len(edges), dtype=float)
    return Route(t, xy, np.array(edges, np.int64), np.zeros(len(edges), bool))


def test_route_diff_identical_and_different():
    g = city()
    n = min(g.n_edges, 12)
    ra = _route(g, list(range(n)))
    d0 = report.route_diff(g, ra, _route(g, list(range(n))))
    assert d0["share_diff_directed_edge"] == 0.0 and d0["dist_equal_time_max"] == 0.0 and d0["geo_dev_max"] == 0.0
    rb = _route(g, list(range(n))[::-1])
    d1 = report.route_diff(g, ra, rb)
    assert d1["share_diff_directed_edge"] > 0.5 and d1["n_s"] == n
