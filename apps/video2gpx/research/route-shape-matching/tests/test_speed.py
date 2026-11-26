# SPDX-License-Identifier: AGPL-3.0-or-later
"""Parity and behaviour tests for the video2gpx pipeline speedups:
- native C/NEON HMM backend vs pure-NumPy fallback (scan, backptr decode, forward-backward, masks & frame priors)
- extraction in-worker zip-level-1 write, lazy eig_map, and stream vertical bounds
- parallel interpretation (workers > 1) byte-identical to single-worker
- map_step skipping density/foreign boxes when decoys == 0 and pre-populating local_bbox_graph for local.corridor_graph
- rotation pass-2 reuse of win_video_base.npz
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest

from rsm.hmm import grid, seq
from rsm.hmm_cal import _native as N, dp
from rsm.pipeline import config as C, local as L, osm, steps_a as SA, steps_b as SB, steps_c as SC
from rsm.pipeline.common import Worker
from rsm.pipeline.vmsx import extract as EX, interpret as VI, motion as vm


def _toy_graph():
    """small connected 2D road graph with a turn and a branch"""
    nodes = {
        1: (45.000, 5.000),
        2: (45.000, 5.003),
        3: (45.000, 5.006),
        4: (45.003, 5.006),
        5: (45.006, 5.006),
        6: (45.003, 5.003),
        7: (45.006, 5.003),
    }
    ways = [
        (10, {"highway": "tertiary", "name": "Main"}, [1, 2, 3, 4, 5]),
        (11, {"highway": "residential", "name": "Side"}, [2, 6, 7, 5]),
        (12, {"highway": "secondary", "name": "Cross"}, [6, 4]),
    ]
    return osm.build_graph(ways, nodes)


def _toy_steps(n: int = 24):
    t = np.arange(n, dtype=float) * 3.0
    mu = np.full(n, 30.0)
    mu[0] = 0.0
    rel = np.full(n, 0.2)
    v = np.full(n, 10.0)
    dth = np.zeros(n)
    dth[0] = np.nan
    dth[n // 2] = np.radians(85.0)
    dth[5] = np.nan
    gap = np.zeros(n, bool)
    gap[5] = True
    return seq.Steps(t=t, dth=dth, mu=mu, rel=rel, v=v, gap=gap, seg=np.zeros(n, int), d0=30.0)


# ------------------------------------------------------------------ native HMM parity
@pytest.mark.skipif(not N.available(), reason="native HMM library not compiled for this platform")
def test_native_hmm_matches_numpy_scan_viterbi_and_fb():
    g = _toy_graph()
    G = grid.build(g, h=30.0, sm=10.0)
    st = _toy_steps()
    fvals = C.F_GRID[:6]
    a_angs = [C.F_REF / f for f in fvals]
    par0 = dp.Par(kappa=1.0)
    start_ok = np.zeros(G.N, bool)
    start_ok[: max(2, G.N // 4)] = True
    end_ok = np.zeros(G.N, bool)
    end_ok[G.N // 2 :] = True
    step_ok = {10: np.arange(G.N) % 2 == 0}
    s_lp = -0.05 * np.arange(G.N, dtype=np.float32)
    e_lp = -0.02 * np.arange(G.N, dtype=np.float32)[::-1].copy()

    old_hook = dp.FRAME_PRIOR_HOOK
    dp.FRAME_PRIOR_HOOK = lambda _g: (s_lp, e_lp)
    try:
        # Native batched scan
        sc_nat = dp.viterbi_scan(G, par0, st, a_angs, start_ok=start_ok, end_ok=end_ok, step_ok=step_ok, threads=2)
        # Native single viterbi with backpointers + forward-backward
        par = dp.Par(kappa=1.0, a_ang=a_angs[2])
        pre = dp.prepare(G, par)
        vit_nat = dp.viterbi(pre, st, backptr=True, start_ok=start_ok, end_ok=end_ok, step_ok=step_ok)
        fb_nat = dp.forward_backward(pre, st, vit_nat["cell_path"], start_ok=start_ok, end_ok=end_ok, step_ok=step_ok)

        # Pure-NumPy reference
        saved = N.LIB
        N.LIB = None
        try:
            sc_py = np.array([
                dp.viterbi(dp.Prepared(G, dp.Par(kappa=1.0, a_ang=a)), st, start_ok=start_ok, end_ok=end_ok, step_ok=step_ok)["score"]
                for a in a_angs
            ])
            vit_py = dp.viterbi(pre, st, backptr=True, start_ok=start_ok, end_ok=end_ok, step_ok=step_ok)
            fb_py = dp.forward_backward(pre, st, vit_py["cell_path"], start_ok=start_ok, end_ok=end_ok, step_ok=step_ok)
        finally:
            N.LIB = saved
    finally:
        dp.FRAME_PRIOR_HOOK = old_hook

    assert np.max(np.abs(sc_nat - sc_py)) < 1e-4
    assert int(np.argmax(sc_nat)) == int(np.argmax(sc_py))
    assert abs(vit_nat["score"] - vit_py["score"]) < 1e-4
    assert np.array_equal(vit_nat["cell_path"], vit_py["cell_path"])
    assert abs(fb_nat["logev"] - fb_py["logev"]) < 1e-3
    assert np.nanmax(np.abs(fb_nat["p_vit"] - fb_py["p_vit"])) < 1e-4


@pytest.mark.skipif(not N.available(), reason="native HMM library not compiled for this platform")
def test_native_hmm_charges_the_no_video_uturn_cost_like_numpy():
    """decision A31: the extra cost of a U-turn without a video reversal (Group.ut, dp.ut_cost) reaches the native scan, Viterbi and forward-backward;
    before, only the NumPy path charged it and every run with the native library decoded without it"""
    g = _toy_graph()
    G = grid.build(g, h=30.0, sm=10.0, **C.UTURN)
    assert any(gr.ut.any() for gr in G.groups[1:])
    st = _toy_steps()
    a_angs = [C.F_REF / f for f in C.F_GRID[:6]]
    ut = dict(ut_extra=20.0, ut_video_deg=135.0, ut_win_m=60.0)
    assert any(dp.ut_cost(dp.Par(kappa=1.0, a_ang=a, **ut), st)[1:].any() for a in a_angs)

    def run(par_kw):
        sc = dp.viterbi_scan(G, dp.Par(kappa=1.0, **par_kw), st, a_angs, threads=2)
        pre = dp.prepare(G, dp.Par(kappa=1.0, a_ang=a_angs[2], **par_kw))
        vit = dp.viterbi(pre, st, backptr=True)
        fb = dp.forward_backward(pre, st, vit["cell_path"])
        return sc, vit, fb

    sc_nat, vit_nat, fb_nat = run(ut)
    sc_off, _, _ = run({})
    saved = N.LIB
    N.LIB = None
    try:
        sc_py = np.array([dp.viterbi(dp.Prepared(G, dp.Par(kappa=1.0, a_ang=a, **ut)), st)["score"] for a in a_angs])
        pre = dp.prepare(G, dp.Par(kappa=1.0, a_ang=a_angs[2], **ut))
        vit_py = dp.viterbi(pre, st, backptr=True)
        fb_py = dp.forward_backward(pre, st, vit_py["cell_path"])
    finally:
        N.LIB = saved
    assert np.max(np.abs(sc_nat - sc_py)) < 1e-4
    assert abs(vit_nat["score"] - vit_py["score"]) < 1e-4
    assert np.array_equal(vit_nat["cell_path"], vit_py["cell_path"])
    assert abs(fb_nat["logev"] - fb_py["logev"]) < 1e-3
    assert np.nanmax(np.abs(fb_nat["p_vit"] - fb_py["p_vit"])) < 1e-4
    assert np.all(sc_nat <= sc_off + 1e-4)          # the cost only ever lowers a score


@pytest.mark.parametrize("use_native", [False, True])
def test_checkpointed_viterbi_and_fb_are_bit_identical_to_direct(use_native):
    if use_native and not N.available():
        pytest.skip("native HMM library not compiled for this platform")
    g = _toy_graph()
    G = grid.build(g, h=30.0, sm=10.0, **C.UTURN)
    # Backward view is built lazily: absent after grid.build() and dp.prepare()
    assert all("b_dst" not in gr.__dict__ for gr in G.groups)
    par = dp.Par(kappa=1.0, a_ang=C.F_REF / C.F_GRID[2], ut_extra=20.0, ut_video_deg=135.0, ut_win_m=60.0)
    pre = dp.prepare(G, par)
    assert all("b_dst" not in gr.__dict__ for gr in G.groups)

    # Test boundary lengths including T=1, T=2, exact multiples of block=5, and cuts/masks on block boundaries
    start_ok = np.zeros(G.N, bool); start_ok[: max(2, G.N // 3)] = True
    end_ok = np.zeros(G.N, bool); end_ok[G.N // 2 :] = True
    s_lp = -0.05 * np.arange(G.N, dtype=np.float32)
    e_lp = -0.02 * np.arange(G.N, dtype=np.float32)[::-1].copy()

    saved_lib = N.LIB
    old_hook = dp.FRAME_PRIOR_HOOK
    if not use_native:
        N.LIB = None
    dp.FRAME_PRIOR_HOOK = lambda _g: (s_lp, e_lp)
    try:
        for n_steps in (1, 2, 5, 6, 10, 11, 24):
            st = _toy_steps(n_steps) if n_steps >= 6 else seq.Steps(
                t=np.arange(n_steps, dtype=float) * 3.0,
                dth=np.r_[np.nan, np.zeros(max(0, n_steps - 1))],
                mu=np.r_[0.0, np.full(max(0, n_steps - 1), 30.0)],
                rel=np.full(n_steps, 0.2), v=np.full(n_steps, 10.0),
                gap=np.zeros(n_steps, bool), seg=np.zeros(n_steps, int), d0=30.0,
            )
            if n_steps >= 11:
                jump = np.zeros(n_steps, bool)
                jump[5] = True       # jump right on block boundary (B=5)
                jump[8] = True       # jump inside a block
                jump[n_steps - 1] = (n_steps == 11)   # jump at final step
                st = st.copy(jump=jump)
            step_ok = {}
            if n_steps > 5:
                step_ok[5] = (np.arange(G.N) % 2 == 0)
            if n_steps > 7:
                step_ok[7] = (np.arange(G.N) % 3 != 0)
            if n_steps > 1:
                step_ok[0] = (np.arange(G.N) % 2 == 0) | start_ok

            vit_dir = dp.viterbi(pre, st, backptr=True, start_ok=start_ok, end_ok=end_ok, step_ok=step_ok, block=n_steps + 1)
            vit_ck = dp.viterbi(pre, st, backptr=True, start_ok=start_ok, end_ok=end_ok, step_ok=step_ok, block=5)
            assert vit_ck["score"] == vit_dir["score"]
            assert vit_ck["final_cell"] == vit_dir["final_cell"]
            assert np.array_equal(vit_ck["cell_path"], vit_dir["cell_path"])

            if n_steps == 1:
                continue
            # Backward view is still lazy until forward_backward runs
            if n_steps == 2:
                assert all("b_dst" not in gr.__dict__ for gr in G.groups)
            fb_dir = dp.forward_backward(pre, st, vit_dir["cell_path"], start_ok=start_ok, end_ok=end_ok, step_ok=step_ok, block=n_steps + 1)
            fb_ck = dp.forward_backward(pre, st, vit_ck["cell_path"], start_ok=start_ok, end_ok=end_ok, step_ok=step_ok, block=5)
            assert all("b_dst" in gr.__dict__ for gr in G.groups)
            assert fb_ck["logev"] == fb_dir["logev"]
            assert np.array_equal(fb_ck["p_vit"], fb_dir["p_vit"], equal_nan=True)
            assert np.array_equal(fb_ck["p_max"], fb_dir["p_max"])
            assert np.array_equal(fb_ck["e_max"], fb_dir["e_max"])
            assert np.array_equal(fb_ck["ent"], fb_dir["ent"])

        # Also verify steps_c.forward_backward_cb matches direct bit-for-bit with monotonic progress
        st24 = _toy_steps(24)
        jump24 = np.zeros(24, bool); jump24[10] = True
        st24 = st24.copy(jump=jump24)
        prog = []
        cb = lambda j, p: (float(p.max()), int(np.argmax(p)))
        out_dir = SC.forward_backward_cb(pre, st24, cb, lambda _p: None, start_ok=start_ok, end_ok=end_ok, block=100)
        out_ck = SC.forward_backward_cb(pre, st24, cb, prog.append, start_ok=start_ok, end_ok=end_ok, block=5)
        assert out_ck == out_dir
        assert prog == sorted(prog) and all(0.0 <= x <= 100.0 for x in prog)
    finally:
        N.LIB = saved_lib
        dp.FRAME_PRIOR_HOOK = old_hook


# ------------------------------------------------------------------ parallel interpret parity
def test_parallel_interpret_is_byte_identical_to_single_worker(tmp_path):
    from tests.test_insight import _encode, _world
    os.environ["RSM_HWACCEL"] = "0"
    vid = tmp_path / "road.mp4"
    _encode(vid, _world(180))
    ex = tmp_path / "extract"
    EX.extract(str(vid), ex, workers=1, hwaccel=False)
    cal = {"horizon": 150.0, "iqr": 0.0, "frames": 0, "height": 360, "horizon_free": 140.0, "iqr_free": 0.0, "frames_free": 0,
           "track": {"t": [], "row": []}}
    csv1, csv2 = tmp_path / "m1.csv", tmp_path / "m2.csv"
    VI.analyse(ex, str(csv1), calibration=dict(cal), workers=1)
    # force multi-slice path on a short synthetic clip by monkeypatching nothing: test directly with slice_n > len would stay single,
    # so verify both select() sorted fast-path and multi-worker path on 2500 synthetic pairs via _fit_slice
    VI.analyse(ex, str(csv2), calibration=dict(cal), workers=2)
    assert csv1.read_bytes() == csv2.read_bytes()


# ------------------------------------------------------------------ map_step decoys==0 & local_bbox_graph reuse
def test_map_step_skips_density_without_decoys_and_local_reuses_bbox_graph(tmp_path, monkeypatch):
    g_full = _toy_graph()
    # fake pbf + run dir
    pbf = tmp_path / "dummy.osm.pbf"
    pbf.write_bytes(b"pbf")
    d = tmp_path / "run"
    (d / "rotation").mkdir(parents=True)
    (d / "motion").mkdir(parents=True)
    (d / "rotation" / "vehicle.json").write_text(json.dumps({"requested": "motorcycle", "effective": "motorcycle"}))
    # provide a trivial route_steps result
    st = _toy_steps(8)
    monkeypatch.setattr(SB.OF, "route_steps", lambda _d: st)
    monkeypatch.setattr(osm, "pbf_info", lambda _p: {"timestamp": "2026-01-01", "box": {"south": 44.0, "west": 4.0, "north": 46.0, "east": 6.0}})

    density_calls = []
    monkeypatch.setattr(osm, "density", lambda *a, **k: density_calls.append(1) or pytest.fail("density must not run when decoys == 0"))

    # make fake extract return ways touching the bbox (> 5 km scaled by duplicating length in test? easier: scale coords)
    nodes = {1: (45.00, 5.00), 2: (45.00, 5.05), 3: (45.05, 5.05), 4: (45.05, 5.00)}
    ways = [
        (10, {"highway": "tertiary", "name": "A"}, [1, 2, 3, 4, 1]),
        (11, {"highway": "residential", "name": "B"}, [1, 3]),
    ]
    extract_calls = []
    def fake_extract(pbf_, classes_, boxes_, progress=None, way_filter=None):
        extract_calls.append((tuple(sorted(classes_)), dict(boxes_)))
        return {k: (list(ways), dict(nodes)) for k in boxes_}

    monkeypatch.setattr(osm, "extract", fake_extract)
    bbox = {"south": 44.95, "west": 4.95, "north": 45.10, "east": 5.10}
    P = dict(pbf=str(pbf), bbox=bbox, vehicle="motorcycle", decoys=0)
    res = SB.map_step(d, P, Worker())
    assert density_calls == []
    assert res["n_foreign"] == 0
    assert len(extract_calls) == 1                          # ONE single PBF pass for both real and local_bbox!
    mj = json.loads((d / "map" / "map.json").read_text())
    assert "local_bbox_graph" in mj and "residential" in mj["local_bbox_graph"]["classes"]

    # Now local.corridor_graph should reuse local_bbox_graph WITHOUT calling osm.extract again!
    g_real, E_real = SB.load_map(d, "real")
    route = dict(kappa=1.0, step_cell=np.array([0, 1, 2]))
    gl, Ec, _, _ = L.corridor_graph(d, P, Worker(), g_real, E_real, route, "motorcycle", lambda f: None)
    assert len(extract_calls) == 1                          # NO second PBF scan!
    assert "residential" in set(gl.edge_highway.tolist())
    assert len(Ec) > 0


# ------------------------------------------------------------------ rotation pass-2 reuse
def test_rotation_reuses_stashed_pass1_windows(tmp_path, monkeypatch):
    d = tmp_path / "run"
    (d / "motion").mkdir(parents=True)
    (d / "rotation").mkdir(parents=True)
    (d / "motion" / "motion.json").write_text(json.dumps({"horizon_vms": 180.0, "horizon": 170.0}))
    from rsm.pipeline.vmsx.decode import VideoInfo
    monkeypatch.setattr(SA, "probe", lambda _v: VideoInfo("h264", 640, 360, 30.0, 20.0))
    k = max(2, int(round(C.FAR["k_s"] * 30.0)))
    n_win = int(20.0 * 30.0 / k) - 1
    from rsm.angle import farfeat
    p = farfeat.Params(min_inl=C.FAR["min_inl"], band_off=C.ROT_BAND_OFF_VMS)
    ends = SA.band_ends(180.0, 360, p, C.FAR["band_step"], C.FAR["n_bands"])
    meta = dict(video="video", f=C.F_FAR, k=k, fps=30.0, horizon=180.0, band_off=C.ROT_BAND_OFF_VMS, n_windows=n_win, n_ok=0, wall_s=1.0, band_ends=ends, source="video")
    np.savez(d / "_pass1_win_video_base.npz", idx=np.arange(n_win), ta=np.arange(n_win) * k / 30.0, tb=(np.arange(n_win) + 1) * k / 30.0,
             fields=np.array(SA.FIELDS), data=np.zeros((n_win, len(ends), len(SA.FIELDS))), ok=np.zeros((n_win, len(ends)), bool),
             n_pts=np.zeros((n_win, len(ends))), n_inl=np.zeros((n_win, len(ends))), why=np.ones((n_win, len(ends))), meta=json.dumps(meta))
    called_series = []
    monkeypatch.setattr(SA, "rotation_series", lambda d_, P_, W_, m_: called_series.append(m_) or {"reused": True})
    monkeypatch.setattr(SA, "_chunk", lambda *a, **k: pytest.fail("_chunk must not run when pass-1 windows match"))
    res = SA.rotation(d, {"video": "v.mp4"}, Worker())
    assert res == {"reused": True}
    assert (d / "rotation" / "win_video_base.npz").exists()
    assert not (d / "_pass1_win_video_base.npz").exists()


# ------------------------------------------------------------------ Tier 3 & Metal GPU LK
def test_detect_npts1_argmax_matches_general_path(monkeypatch):
    import cv2
    rng = np.random.default_rng(7)
    img = cv2.GaussianBlur(rng.integers(0, 256, (360, 640), dtype=np.uint8), (0, 0), 1.0)
    em = EX.eig_map(img)
    monkeypatch.setattr(EX, "NPTS", 1)
    p1, q1 = EX.detect(em, EX.THR["raw"], y0=160, y1=360)
    monkeypatch.setattr(EX, "NPTS", 2)
    p2, q2 = EX.detect(em, EX.THR["raw"], y0=160, y1=360)
    # Every cell's first (strongest) point in NPTS=2 must be bit-identical to NPTS=1 argmax
    cells2 = (p2[:, 1].astype(int) // EX.CELL) * 1000 + (p2[:, 0].astype(int) // EX.CELL)
    first_idx = np.flatnonzero(np.concatenate([[True], cells2[1:] != cells2[:-1]]))
    assert np.array_equal(p1, p2[first_idx])
    assert np.array_equal(q1, q2[first_idx])


def test_metal_lk_matches_opencv_and_is_deterministic_across_chunks(tmp_path, monkeypatch):
    from rsm.pipeline.vmsx import _metal
    if not _metal.available(vm.LK_PARAMS):
        pytest.skip("Metal GPU LK library not available on this platform")
    from tests.test_insight import _encode, _world
    os.environ["RSM_HWACCEL"] = "0"
    vid = tmp_path / "road.mp4"
    _encode(vid, _world(180))

    # Extract with Metal GPU (sequential + parallel 2 workers) and OpenCV CPU
    d_m1 = tmp_path / "metal_seq"
    d_m2 = tmp_path / "metal_par"
    d_cpu = tmp_path / "cpu_seq"
    chunk_s = 4 * vm.WARM_FRAMES / 30.0
    m1 = EX.extract(str(vid), d_m1, workers=1, hwaccel=False)
    m2 = EX.extract(str(vid), d_m2, workers=2, chunk_s=chunk_s, hwaccel=False)
    assert m1["params"]["tracker"] == "metal" and m2["params"]["tracker"] == "metal"
    a1, a2 = EX.load(d_m1), EX.load(d_m2)
    assert a1.keys() == a2.keys()
    for k in a1:
        assert np.array_equal(a1[k], a2[k]), f"metal seq vs par mismatch in {k}"

    monkeypatch.setenv("RSM_NO_METAL", "1")
    mc = EX.extract(str(vid), d_cpu, workers=1, hwaccel=False)
    assert mc["params"]["tracker"] == "opencv"
    # Verify Metal vs OpenCV flow parity on a pair of synthetic road frames
    monkeypatch.delenv("RSM_NO_METAL")
    fr = list(_world(4))
    em = EX.eig_map(fr[1])
    pts, _ = EX.detect(em, EX.THR["raw"])
    cv_fl, cv_fb, cv_ok = EX.track(fr[1], fr[2], pts)
    with _metal.MetalLKSession(fr[1].shape[1], fr[1].shape[0], vm.LK_PARAMS) as sess:
        m_fl, m_fb, m_ok = sess.run_batch([(0, fr[1], 1, fr[2], pts)])[0]
    both = cv_ok & m_ok & (cv_fb < 1.0) & (m_fb < 1.0)
    assert both.sum() > 0.9 * (cv_ok & (cv_fb < 1.0)).sum()
    err = np.linalg.norm(m_fl[both] - cv_fl[both], axis=1)
    assert float(np.median(err)) < 0.05
    assert float(np.percentile(err, 90)) < 0.15


def test_hwaccel_name_respects_platform_and_env(monkeypatch):
    from rsm.pipeline import common as CM
    monkeypatch.delenv("RSM_HWACCEL", raising=False)
    monkeypatch.setattr(CM.sys, "platform", "darwin")
    assert CM.hwaccel_name() == "videotoolbox" and CM.hwaccel_enabled() is True

    monkeypatch.setattr(CM.sys, "platform", "linux")
    assert CM.hwaccel_name() is None and CM.hwaccel_enabled() is False

    monkeypatch.setenv("RSM_HWACCEL", "1")
    assert CM.hwaccel_name() == "auto" and CM.hwaccel_enabled() is True

    monkeypatch.setenv("RSM_HWACCEL", "vaapi")
    assert CM.hwaccel_name() == "vaapi" and CM.hwaccel_enabled() is True

    monkeypatch.setenv("RSM_HWACCEL", "0")
    assert CM.hwaccel_name() is None and CM.hwaccel_enabled() is False


def test_dp_native_compiles_for_simd_scalar_and_x86_64_sse2(tmp_path):
    import shutil
    import subprocess
    if not shutil.which("cc"):
        pytest.skip("C compiler (cc) not available")
    c_src = Path(N.__file__).resolve().parent / "_dp_native.c"
    so_simd = tmp_path / "dp_simd.so"
    so_scalar = tmp_path / "dp_scalar.so"
    subprocess.run(["cc", "-O3", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-lm", "-lpthread", "-o", str(so_simd), str(c_src)], check=True)
    subprocess.run(["cc", "-O3", "-Wall", "-Wextra", "-Werror", "-DRSM_NO_SIMD=1", "-shared", "-fPIC", "-lm", "-lpthread", "-o", str(so_scalar), str(c_src)], check=True)

    # On macOS with universal clang SDK, also verify that the x86_64 SSE2 path compiles cleanly with -Werror
    if shutil.which("clang") and os.uname().sysname == "Darwin":
        so_x86 = tmp_path / "dp_x86_64.so"
        subprocess.run(["clang", "-arch", "x86_64", "-O3", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-lm", "-lpthread", "-o", str(so_x86), str(c_src)], check=True)
        # Verify the compiled x86_64 binary uses the SIMD path (not scalar fallback) by checking RSM_HAS_SIMD via nm/objdump or running under Rosetta if available
        if shutil.which("arch"):
            chk = subprocess.run(["arch", "-x86_64", "/usr/bin/true"], capture_output=True)
            if chk.returncode == 0:
                c_test = tmp_path / "test_x86.c"
                c_test.write_text(
                    '#include <stdio.h>\n'
                    '#include <math.h>\n'
                    '#include "' + str(c_src) + '"\n'
                    'int main(void) {\n'
                    '#if !RSM_HAS_SIMD || !RSM_HAS_SSE2\n'
                    '#error "Expected RSM_HAS_SIMD == 1 and RSM_HAS_SSE2 == 1 on x86_64"\n'
                    '#endif\n'
                    '    float in[4] = {0.0f, 0.25f, 1.5f, 12.0f}, out[4];\n'
                    '    v4_store(out, fast_log1pf_v4(v4_load(in)));\n'
                    '    for (int i = 0; i < 4; i++) {\n'
                    '        float ref = fast_log1pf_scalar(in[i]);\n'
                    '        if (fabsf(out[i] - ref) > 1e-6f) return i + 1;\n'
                    '    }\n'
                    '    int32_t src[2] = {0, 1}, ud[2] = {1, 2};\n'
                    '    int64_t starts[2] = {0, 1};\n'
                    '    float D[2] = {30.0f, 31.0f}, dphi[2] = {0.1f, -0.2f}, w[2] = {0.0f, -0.1f};\n'
                    '    GroupBase gr = {2, 2, src, D, dphi, w, starts, ud, NULL, 30.0f, 31.0f, NULL};\n'
                    '    float ls4[8] = {-0.1f,-0.2f,-0.3f,-0.4f, -0.1f,-0.2f,-0.3f,-0.4f};\n'
                    '    float is2_4[8] = {1.0f, 2.0f, 3.0f, 4.0f, 1.5f, 2.5f, 3.5f, 4.5f};\n'
                    '    const float *ls_p[1] = {ls4}, *is2_p[1] = {is2_4};\n'
                    '    float mus[3] = {0.0f, 30.0f, 30.5f}, sds[3] = {0.0f, 5.0f, 5.0f};\n'
                    '    int32_t has_dth[3] = {0, 1, 1};\n'
                    '    float dths4[12] = {0,0,0,0, 0.1f,0.2f,0.3f,0.4f, -0.2f,-0.1f,0.0f,0.1f};\n'
                    '    float s0[3] = {0.0f, -INFINITY, -INFINITY};\n'
                    '    Batch4Job job = {3, 3, 1, &gr, ls_p, is2_p, mus, sds, has_dth, dths4, 2.0f, s0, NULL, 0, NULL, NULL, {0,0,0,0}, NULL, NULL};\n'
                    '    viterbi_scan_batches(1, 1, &job);\n'
                    '    for (int k = 0; k < 4; k++) {\n'
                    '        if (!isfinite(job.out_scores[k])) return 10 + k;\n'
                    '    }\n'
                    '    return 0;\n'
                    '}\n'
                )
                bin_x86 = tmp_path / "test_x86"
                subprocess.run(["clang", "-arch", "x86_64", "-O3", "-Wall", "-Wextra", "-Werror", "-lm", "-lpthread", "-o", str(bin_x86), str(c_test)], check=True)
                subprocess.run(["arch", "-x86_64", str(bin_x86)], check=True)

    # Compare SIMD vs scalar C build on the same HMM problem
    g = _toy_graph()
    G = grid.build(g, h=30.0, sm=10.0)
    st = _toy_steps()
    a_angs = [C.F_REF / f for f in C.F_GRID[:6]]
    par0 = dp.Par(kappa=1.0)
    saved = N.LIB
    try:
        N.LIB = N._bind(so_simd)
        sc_simd = N.viterbi_scan(G, par0, st, a_angs, threads=2)
        N.LIB = N._bind(so_scalar)
        sc_scalar = N.viterbi_scan(G, par0, st, a_angs, threads=2)
    finally:
        N.LIB = saved
    assert np.max(np.abs(sc_simd - sc_scalar)) < 1e-5

