# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sure standstill (rsm.pipeline.standstill, work/standstill): the whole-frame cell test, the sampling plan of candidate runs, the route-side steps (tracks
split, gap measured ~0) and the held position in the fusion, the standstill edges in the GPX and the Incyclist export."""
import json
from datetime import datetime, timezone

import cv2
import numpy as np

from rsm.fusion import rts
from rsm.pipeline import config as C, export as X, odofail as OF, standstill as SS, steps_c as SC, steps_d as SD


def texture(seed=0, h=360, w=640):
    rng = np.random.default_rng(seed)
    a = cv2.GaussianBlur((rng.random((h, w)) * 255).astype(np.float32), (0, 0), 2.0)
    return cv2.normalize(a, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)


def shift(img, dx, dy, scale=1.0, cx=320.0, cy=150.0):
    M = np.array([[scale, 0, cx * (1 - scale) + dx], [0, scale, cy * (1 - scale) + dy]], np.float32)
    return cv2.warpAffine(img, M, (img.shape[1], img.shape[0]), borderMode=cv2.BORDER_REFLECT)


def test_cell_test_standing_with_passing_vehicle():
    a = texture()
    b = shift(a, 0.15, -0.1)                                   # the motorcycle sways a little
    car = texture(7)[200:340, 40:300]
    a2, b2 = a.copy(), b.copy()
    a2[200:340, 40:300] = car                                  # a vehicle in the lower left moves 6 px between the frames
    b2[200:340, 46:306] = car
    s_all, s_up = SS.cell_shares(a2, b2, horizon=175.0)
    assert s_all >= C.STILL_ALL and s_up >= C.STILL_UP


def test_cell_test_driving_is_not_still():
    a = texture()
    h, w = a.shape                                             # forward motion: expansion from the focus of expansion with parallax (near rows faster)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    k = 0.01 + 0.05 * np.abs(yy - 150.0) / h
    b = cv2.remap(a, xx - k * (xx - 320.0), yy - k * (yy - 150.0), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    s_all, s_up = SS.cell_shares(a, b, horizon=175.0)
    assert s_all < C.STILL_ALL


def test_plan_and_spans():
    ts = np.arange(100.0, 120.0, 0.5)                          # one 20 s candidate run
    runs = SS.plan(ts)
    (r, tw), = runs
    assert len(r) == 40 and 8 <= len(tw) < 40                  # dense at both ends, sparse inside
    assert {100.0, 101.5, 118.0, 119.5} <= set(tw.tolist())
    tested = {float(t): True for t in tw}
    assert SS.spans_of(runs, tested) == [[100.0, 120.0]]
    mid = float(tw[len(tw) // 2])
    tested[mid] = False                                        # one sampled window inside moves: the run splits there
    sp = SS.spans_of(runs, tested)
    assert len(sp) == 2 and sp[0][1] <= mid and sp[1][0] > mid
    assert SS.spans_of(SS.plan(np.array([50.0])), {50.0: True}) == []      # shorter than STILL_MIN_S
    runs = SS.plan(np.arange(200.0, 208.0, 0.5))                # 8 s run: edges creep, the middle is not sampled
    (r, tw), = runs
    tested = {float(t): False for t in tw}
    fill = SS.refill(runs, tested)
    assert fill == []                                          # all samples agree: nothing to fill
    assert 202.0 in tw and 205.5 in tw and 203.0 not in tw     # inner samples at both ends of the middle only
    tested[205.5] = True                                       # one inner sample stands: every window between it and the moving one before is tested
    assert SS.refill(runs, tested) == [202.5, 203.0, 203.5, 204.0, 204.5, 205.0]


def _project(tmp_path, still, phantom=(30.0, 40.0)):
    """motion.csv at 10 Hz, 3 nominal m/s, phantom speed inside `phantom` (passing traffic), and route_search/standstill.json"""
    d = tmp_path / "out"
    (d / "motion").mkdir(parents=True)
    (d / "route_search").mkdir()
    dt = 0.1
    t = np.arange(dt / 2, 80.0, dt)
    k = C.F360 * OF.CAMERA_HEIGHT_M
    s = np.full(len(t), 3.0 * dt / k)
    s[(t >= phantom[0]) & (t < phantom[1])] = 0.3 * 3.0 * dt / k
    rows = ["frame,time,corners,tracked,inliers,rms_px,s,c,yaw,pitch,roll,diff,rel_speed"]
    rows += [f"{i + 1},{x:.4f},200,190,180,0.1,{v:.6e},0,0,0,0,3.0,{v / dt:.6e}" for i, (x, v) in enumerate(zip(t, s))]
    (d / "motion" / "motion.csv").write_text("\n".join(rows) + "\n")
    (d / "route_search" / "standstill.json").write_text(json.dumps(dict(version=1, spans=still)))
    s_cum = np.concatenate([[0.0], np.cumsum(s * k)])
    t_e = np.concatenate([[0.0], t + dt / 2])
    grid = np.arange(0.0, s_cum[-1], 4.0)
    tr = dict(t=np.interp(grid, s_cum, t_e), s=grid, th=np.zeros(len(grid)))
    return d, [tr]


def test_route_steps_measure_a_sure_standstill_as_zero(tmp_path):
    d, tracks = _project(tmp_path, still=[[30.0, 40.0]])
    csv = str(d / "motion" / "motion.csv")
    tr, gn, still = OF.apply_still(tracks, csv)
    assert still == [(30.0, 40.0)] and len(tr) == 2
    assert tr[0]["t"][-1] <= 30.0 and tr[1]["t"][0] >= 40.0
    assert gn[1] is not None and gn[1] < 8.0                   # only the approach / start metres around the stop, not 10 s of phantom speed
    st, info = OF.build(tracks, csv, d0=4.0)
    assert info["still"] == [[30.0, 40.0]]
    g = st.gap & (st.t > 30.0) & (st.t <= 41.0)
    assert g.any() and st.mu[g].sum() < 8.0
    (d / "route_search" / "standstill.json").write_text(json.dumps(dict(version=1, spans=[])))
    st0, _ = OF.build(tracks, csv, d0=4.0)                     # without the span: the phantom distance stays (9 m nominal)
    m0 = (st0.t > 30.0) & (st0.t <= 40.0)
    assert st0.mu[m0].sum() >= 8.0


def test_still_switch_off(tmp_path, monkeypatch):
    d, tracks = _project(tmp_path, still=[[30.0, 40.0]])
    monkeypatch.setattr(C, "STILL_ON", False)
    tr, gn, still = OF.apply_still(tracks, str(d / "motion" / "motion.csv"))
    assert still == [] and tr is tracks and gn is None


def test_fusion_holds_the_position():
    nodes = np.arange(0.0, 20.01, 0.5)
    dm = np.concatenate([[0.0], np.full(len(nodes) - 1, 1.0)])     # odometry says 2 m/s throughout (phantom inside the span)
    dg = np.zeros(len(nodes))
    meas = [rts.Meas(float(t), float(2.0 * t), 1.0, "posterior") for t in np.arange(0.0, 20.01, 1.0)]
    still = [(8.0, 12.0)]
    kept = SC.hold_still(nodes, dm, dg, meas, still)
    assert all(not (8.0 < m.t < 12.0) for m in kept) and len(kept) == len(meas) - 3
    assert np.all(dm[(nodes > 8.0) & (nodes <= 12.0)] == 0.0)
    res = rts.fuse(nodes, dm, dg, kept, 0.0, rts.FuseParams())
    s = res["xs"][:, 0]
    i8, i12 = int(np.searchsorted(nodes, 8.0)), int(np.searchsorted(nodes, 12.0))
    assert np.ptp(s[i8:i12 + 1]) < 1e-6                       # held exactly
    assert s[-1] > s[i12] + 10.0                               # and driving again afterwards


def test_gpx_edges_and_subsecond_time(tmp_path):
    pts = [dict(t=float(t), lat=45.0, lon=6.0 + 1e-5 * t, confidence=0.9, in_gap=False, extrapolated=False, motion_state="driving") for t in range(10)]
    stills = [dict(t0=3.5, t1=6.25, lat=45.0, lon=6.00004, heading=90.0, confidence=0.9, sd_m=1.0, arc_m=40.0, offset_m=1.6, line_source="fixed")]
    out = SD.with_edges(pts, stills)
    assert [p["t"] for p in out if "edge" in p] == [3.5, 6.25] and len(out) == 12
    assert [p["t"] for p in out] == sorted(p["t"] for p in out)
    assert SD.fmt(datetime(2000, 1, 1, 0, 0, 3, 500000, tzinfo=timezone.utc)) == "2000-01-01T00:00:03.500Z"
    assert SD.fmt(datetime(2000, 1, 1, 0, 0, 3, tzinfo=timezone.utc)) == "2000-01-01T00:00:03Z"
    meta = dict(name="x", rule="r", verdict="confident", basis="b", offset_m=1.6, side="right", vehicle="bike")
    SD.write_gpx(tmp_path / "r.gpx", out, datetime(2000, 1, 1, tzinfo=timezone.utc), meta)
    g = (tmp_path / "r.gpx").read_text()
    assert "<time>2000-01-01T00:00:06.250Z</time>" in g and g.count("<rsm:edge>") == 2


class _R(dict):
    @property
    def files(self):
        return list(self)


def test_export_adds_edges_and_keeps_the_standstill():
    t = np.arange(0.0, 20.0)
    s = np.where(t < 8, 2.0 * t, np.where(t <= 12, 16.0, 16.0 + 2.0 * (t - 12)))
    R = _R(t=t, in_still=(t >= 7.5) & (t <= 12.5), still_t0=np.array([7.5]), still_t1=np.array([12.5]), still_s0=np.array([16.0]), still_conf=np.array([0.9]))
    t2, s2, c2, st2 = X.add_still_edges(R, t, s, np.ones(len(t)))
    assert len(t2) == 22 and 7.5 in t2 and 12.5 in t2 and st2[t2 == 7.5][0] and st2[t2 == 12.5][0]
    old = _R(t=t)
    t3, *_ , st3 = X.add_still_edges(old, t, s, np.ones(len(t)))
    assert len(t3) == 20 and not st3.any()


def test_fusion_distance_follows_the_odometry_inside_a_step():
    """a stop inside one 30-m step: the step total stays, but the distance inside the step follows the track (not a flat speed over the step)"""
    from types import SimpleNamespace
    # track: 10 m/s for 3 s, standing 10 s, 10 m/s again (4-m samples on distance, as tracks._resample)
    tt = np.array([0.0, 3.0, 13.0, 16.0]); ss = np.array([0.0, 30.0, 30.4, 60.4])
    g = np.arange(0.0, 60.4, 4.0)
    tr = dict(t=np.interp(g, ss, tt), s=g, th=np.zeros(len(g)))
    st = SimpleNamespace(t=np.array([0.0, 2.0, 15.0, 16.0]), mu=np.array([0.0, 20.0, 30.4, 10.0]), gap=np.zeros(4, bool))
    Dcum = np.concatenate([[0.0], np.cumsum(st.mu[1:])])
    ctx = SimpleNamespace(st=st, tracks=[tr], D=lambda t: np.interp(t, st.t, Dcum))
    t = np.arange(0.0, 16.01, 0.5)
    D = SC.shaped_D(ctx, t)
    assert np.allclose(SC.shaped_D(ctx, st.t), Dcum)                                   # step totals unchanged
    v = np.diff(D) / 0.5
    stop = (t[1:] > 4.0) & (t[1:] <= 12.5)
    assert v[stop].max() < 0.5                                                         # held, not 30.4 m / 13 s = 2.3 m/s
    assert np.all(np.diff(D) >= -1e-9)


def test_fusion_fine_profile_beats_the_4m_samples():
    """with the per-pair profile the stop is held even when one 4-m track sample spans it"""
    from types import SimpleNamespace
    tt = np.array([0.0, 3.0, 13.0, 16.0]); ss = np.array([0.0, 30.0, 30.4, 60.4])
    g = np.arange(0.0, 60.4, 4.0)
    tr = dict(t=np.interp(g, ss, tt), s=g, th=np.zeros(len(g)))
    st = SimpleNamespace(t=np.array([0.0, 2.0, 15.0, 16.0]), mu=np.array([0.0, 20.0, 30.4, 10.0]), gap=np.zeros(4, bool))
    Dcum = np.concatenate([[0.0], np.cumsum(st.mu[1:])])
    tf = np.arange(0.0, 16.01, 0.1)
    fine = (tf, np.interp(tf, tt, ss))
    ctx = SimpleNamespace(st=st, tracks=[tr], D=lambda t: np.interp(t, st.t, Dcum), extra=dict(fine=fine))
    t = np.arange(0.0, 16.01, 0.5)
    D = SC.shaped_D(ctx, t)
    v = np.diff(D) / 0.5
    assert v[(t[1:] > 3.5) & (t[1:] <= 13.0)].max() < 0.1
    assert np.allclose(SC.shaped_D(ctx, st.t), Dcum)


def test_fusion_shapes_a_gap_step_too():
    """the stop's pairs are rejected (negative speed) and split the track: the gap step is shaped by the filled per-pair profile, not spread evenly"""
    from types import SimpleNamespace
    st = SimpleNamespace(t=np.array([0.0, 4.0, 14.0]), mu=np.array([0.0, 30.0, 32.0]), gap=np.array([False, False, True]))
    Dcum = np.concatenate([[0.0], np.cumsum(st.mu[1:])])
    tf = np.arange(0.0, 14.01, 0.1)
    fine = (tf, np.interp(tf, [0.0, 3.0, 11.0, 14.0], [0.0, 30.0, 30.2, 60.2]))
    ctx = SimpleNamespace(st=st, tracks=[], D=lambda t: np.interp(t, st.t, Dcum), extra=dict(fine=fine))
    t = np.arange(0.0, 14.01, 0.5)
    v = np.diff(SC.shaped_D(ctx, t)) / 0.5
    assert v[(t[1:] > 5.0) & (t[1:] <= 10.5)].max() < 0.2
    assert np.allclose(SC.shaped_D(ctx, st.t), Dcum)
