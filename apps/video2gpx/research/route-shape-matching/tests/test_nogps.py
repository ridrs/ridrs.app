# SPDX-License-Identifier: AGPL-3.0-or-later
"""No-GPS adapter: dark-interval detection, tunnel check against a synthetic route, heading shape."""
from types import SimpleNamespace

import numpy as np

from rsm.nogps import evidence, verify


def test_dark_intervals_found_and_short_ones_ignored():
    n = 2000
    a = np.full((n, 36, 64), 100.0)
    a[400:420] = 5.0  # 10 s at 2 fps
    a[900:902] = 5.0  # 1 s: too short
    iv, thr, med = evidence.dark_intervals(a)
    assert len(iv) == 1 and abs(iv[0]["t0"] - 200.0) < 1e-6 and abs(iv[0]["dur"] - 10.0) < 1e-6
    assert abs(thr - 50.0) < 1e-6


def _route(tunnel_t=(100, 110)):
    t = np.arange(0.0, 300.0, 2.0)
    E = np.where((t >= tunnel_t[0]) & (t <= tunnel_t[1]), 1, 0)
    xy = np.column_stack([t * 8.0, np.zeros_like(t)])
    return SimpleNamespace(t=t, E=E, xy=xy, gap_edges=[], inc=np.zeros_like(t))


def test_tunnel_check_hit_and_miss():
    g = SimpleNamespace(edge_tunnel=np.array([False, True]))
    r = verify.tunnel_check(_route(), g, [dict(t0=102, t1=106), dict(t0=200, t1=204)], T=300, n_perm=50)
    assert r["rows"][0]["hit"] and not r["rows"][1]["hit"]
    assert r["hits"] == 1 and r["n"] == 2


def test_heading_series_left_turn_positive():
    t = np.arange(0.0, 100.0)
    th = np.linspace(0, np.pi / 2, len(t))  # path curving to the left (counter-clockwise)
    xy = np.column_stack([np.cumsum(np.cos(th)), np.cumsum(np.sin(th))])
    _, h = verify.heading_series(t, xy)
    assert h[-1] > h[0] + 1.0
